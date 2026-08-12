# Durability gap analysis

## 2026-08-12 P1 convergence update

Migration `202608120001_p1_persistence_completion.sql` activates 41 collections: Governance Core
(11), Agreement Intelligence (6, including the digit-suffixed `contractVersionsV2` the original
scanner missed), Enterprise Intelligence and Analytics (15), and Agent Runtime (9). Existing
relations remain canonical; only `analysis_reviews`, which had no relation, is created. The durable
store now maps every engine collection except the six Performance Readiness collections deliberately
outside this P1 batch. The ratchet's scanner now accepts digits and its baseline is six.

**Status: ANALYSIS + GATE.** Measures what the platform actually persists, states what it is meant to
persist, registers the difference, and installs the mechanism that keeps the difference visible. It
does **not** close the gap — closing it is sequenced below as named work.

Every number here was measured against this repository and, where it concerns runtime behaviour,
against a live PostgreSQL instance. Where a previously accepted document disagrees, the measurement
wins and the disagreement is recorded.

## The finding

**Engines write 129 collections. The durable store maps 64. Sixty-seven are unmapped.**

Every engine package composes with `TrustPersistence`. In a durable deployment that resolves —
through `apps/web/lib/persistence.ts`, which refuses an in-memory adapter and has no
`databaseUrl ? postgres : memory` fallback — to `PostgresTrustStore`. That store refuses any
collection it has no mapping for:

```
PERSISTENCE_COLLECTION_NOT_MAPPED: agreements has no mapping in the durable trust store
```

That refusal is **correct**. Accepting a write nothing can read back is worse, and it is why Batches
A–D found `trust_records` holding zero rows for all thirty-five aggregates they activated. But it
fires at the first request rather than at build time, so this repository could pass every gate it has
— typecheck, lint, 766 default tests, 231 PostgreSQL tests, `repo:certify` 11/11 — and a durable
deployment would still be unable to create a contract.

Confirmed by running the real engine against a real database:

| Probe | Result |
|---|---|
| `ContractAuthoringEngine.create` via `PostgresTrustStore` | **REFUSED** — `PERSISTENCE_COLLECTION_NOT_MAPPED: agreements` |

`agreements` is the canonical chain's first link. 161 of the 163 API routes go through this store.

## Current state, measured

| Question | Answer | How it was measured |
|---|---|---|
| Engine packages composing with `TrustPersistence` | **15 of 15** | source scan; no engine package uses `AssuraRepository` |
| API routes through the durable store | **161 of 163** (2 are health) | import scan of `apps/web/app/api/**/route.ts` |
| API routes through `FileAssuraStore` | **8** | same scan; they also import `trust-app` |
| Collections engines write | **129** | `.append(` / `.replace(` call sites |
| Collections the store maps | **64** | `POSTGRES_TRUST_COLLECTIONS` at runtime |
| **Unmapped** | **67** | set difference |
| Canonical chain links durable | **7 of 11** | chain from CLAUDE.md vs the mapped set |
| Tables with FORCE row-level security | **44 of 108** | `pg_class` on a fully migrated database |
| Tables with ENABLE but no FORCE | **59** | same; all outside the store's routing table |
| Tables with no boundary | **5** | same; all outside the routing table |

### Two prior claims this corrects

**"`FileAssuraStore` remains production-active for Engines 06–60."** — the capability registry, and
repeated by me. Wrong in a specific and important way: those engines do not use `FileAssuraStore`.
They use `TrustPersistence`, and the durable store **refuses** them. Only 8 routes touch
`FileAssuraStore` at all. The consequence is not "these engines persist to JSON files" but "these
engines do not persist" — which is worse, and hidden differently.

I asserted the FileAssuraStore version of this three times before measuring it. The corrected
statement is the one above.

**"102 tables carry ENABLE without FORCE."** — the same notes. Measured: **59**, because Batches A–D
converted their share. Recorded as a ceiling in `store-boundary.postgres.test.ts` so it can fall
without an edit and cannot rise.

## Future state

From `docs/ARCHITECTURE.md`, `docs/ENGINE_CATALOG.md`, CLAUDE.md and
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md`:

1. **Every engine's state is durable and tenant-scoped.** One canonical relational owner per
   aggregate, columns rather than JSON blobs, FORCE row-level security predicated on the trust scope,
   governed mutation boundaries, and schema-validated reads.
2. **The canonical chain is evidence-backed end to end** — all eleven links, because a link that
   cannot be persisted cannot be evidence, and the product's central claim is that obligations become
   evidence-backed execution.
3. **Every release stays certified-work-backed** with no unconditional release path, no custody, and a
   full append-only audit trail.
4. **`FileAssuraStore` is retired**, and with it the three trust-domain compatibility tables
   (`workspaces`, `workspace_memberships`, `user_identities`) whose retirement this capability is the
   named condition for.
5. **Engines 51–60 stay untouched until the persistence boundary is resolved** — an explicit sequencing
   rule, not an oversight.

## The gap register

Sixty-seven collections, grouped by owning package and ordered by the sequence below.

| # | Package | Engines | Unmapped | Contains |
|---|---|---|---|---|
| 1 | `performance-blueprint` | 21–25 | 6 | `performanceBlueprints`, `blueprintMilestones`, `dodPackages` — **3 canonical chain links** |
| 2 | `agreement-creation` | 11–15 | 15 | `agreements` — **the chain's first link** |
| 3 | `performance-readiness` | 26–30 | 6 | `paymentTriggerRules` |
| 4 | `governance-core` | 06–10 | 11 | certification, governed execution, payment authorisation proposals |
| 5 | `agreement-intelligence` | 16–20 | 5 | analysis runs, risk assessments |
| 6 | `enterprise-intelligence` | 51–55 | 6 | KPIs, assurance indices, forecasts |
| 7 | `enterprise-analytics` | 56–60 | 9 | scorecards, model registry, drift |
| 8 | `agent-runtime` | governed agents | 9 | agent memory, telemetry, executions |

### Two consequences worth naming precisely

**The canonical chain is broken at its front.** Links 5–11 are durable (Batches A–D). Links 1–4 —
contract, blueprint, milestone, definition of done — are not. So the durable half of the chain
references a non-durable half: an `ExecutionWorkspace` carries a `milestoneId`, and a `Milestone`
cannot be stored.

**Batch B already ships a reference to an unstorable record.** `paymentEligibility.paymentTriggerRuleId`
is a required, non-blank identifier, validated by a Zod schema and stored in a column — pointing at
`paymentTriggerRules`, which is unmapped. A durable payment eligibility therefore names a trigger rule
that cannot exist. Nothing detects it today, because none of these identifiers is a foreign key across
the batch boundary — and could not be, while the parent has no table.

## The fix

Three parts. Only the third is large, and it is sequenced rather than attempted here.

### 1. A coverage gate — delivered

`packages/database-testing/src/durability-coverage.test.ts`. Static, so it runs in the default suite in
under a second and a developer sees it immediately. It does what nothing did before: **turns a
production refusal into a build-time fact.**

- **A new unmapped collection fails immediately**, naming the collection and its owning package.
  Adding an `append` for something nobody mapped is now a red test, not an incident.
- **The baseline can only shrink.** A collection the store has since mapped must be removed from the
  baseline, so the list cannot rot into a permanent excuse and progress shows up in the diff.
- **A phantom baseline entry fails**, so the list describes live code rather than history.
- **The canonical chain's coverage is asserted as a floor** — 7 of 11 today. Mapping another link makes
  it pass by more; nothing can make it pass by less.
- **The scan itself is guarded**, because a coverage test whose pattern silently stops matching passes
  by finding nothing, which is the worst failure mode available to it.

Verified negatively as well as positively: removing `agreements` from the baseline — simulating a
newly added unmapped write — fails two assertions with
`agreements (written by agreement-creation)` in the output.

### 2. The corrected record — delivered

The capability registry's notes now state the measured position rather than the `FileAssuraStore`
story, including both corrected numbers. `store-boundary.postgres.test.ts` holds the row-level-security
census as a ceiling.

### 3. Closing the 67 — sequenced, not attempted

This is roughly twice the work of Batches A–D and belongs in batches of the same shape, in the order
of the register above. The order is not arbitrary:

- **Batch E first: `performance-blueprint` (6).** Three canonical chain links for six aggregates — the
  highest ratio of central-claim repair to work in the whole register. It also gives
  `execution_workspaces.milestone_id` a real parent, which lets a tenant-composite foreign key replace
  the bare identifier Batch A had to accept.
- **Batch F: `agreement-creation` (15).** Completes the chain's front. Largest single batch; its
  closure will need measuring the way Batch B's and C's did, because `agreements` is referenced widely.
- **Batch G: `performance-readiness` (6).** Closes the `paymentTriggerRules` hole that Batch B already
  points at, and lets that reference become a foreign key.
- **Batches H–I: `governance-core` (11), `agreement-intelligence` (5).**
- **Last: `enterprise-intelligence` (6), `enterprise-analytics` (9), `agent-runtime` (9).** Deferred by
  the accepted decision until the persistence boundary is resolved, and the register keeps them in that
  position rather than reordering by convenience.

Each batch should follow the shape Batches A–D settled into, because it produced four consecutive
clean activations and found a real defect every time:

1. compute the foreign-key closure against a live migrated instance, in **both** directions;
2. write canonical Zod schemas with compile-time conformance proofs against the domain types;
3. read the engines before writing the migration — every batch found a mutation boundary that
   contradicted its engine, in one direction or the other;
4. converge identity, tenancy and FORCE row-level security for the whole closure at once;
5. make cross-row invariants database constraints, and prove each refusal through a **direct
   statement** as well as through the store;
6. remove the batch's entries from the coverage baseline in the same change.

### What this fix does not do

- **It does not make any of the 67 durable.** The gate makes the gap visible and bounded; it does not
  shrink it.
- **It does not change the 8 `FileAssuraStore` routes.** They work, and they are a separate question
  from the 67 — which are not file-backed at all.
- **It does not force row-level security on the 59 unforced tables.** They have no reader and no
  writer, their policies predicate on the superseded `current_workspace_id()`, and forcing a boundary
  on a dead table is work that looks like security and delivers none.
- **It does not re-point the capability's REOS probes.** They name a single-store shape the batch
  decision superseded; repointing them would flip the derived lifecycle without changing what exists.
  They should be redrawn when the remaining scope is designed, and this document is the input to that.

## Evidence

- 5 static tests in `durability-coverage.test.ts`, verified to fail on an injected regression.
- 4 live-PostgreSQL tests in `store-boundary.postgres.test.ts` for the boundary rule and the census.
- A live probe of `ContractAuthoringEngine.create` against a fully migrated database, returning
  `PERSISTENCE_COLLECTION_NOT_MAPPED`.
- Counts reproducible from the repository: `POSTGRES_TRUST_COLLECTIONS` at runtime, `.append(` /
  `.replace(` call sites in the fifteen engine packages, and `pg_class` on a migrated instance.
