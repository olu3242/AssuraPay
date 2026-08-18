# Durability gap analysis

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

The table below is the measurement taken when this register was written, kept as the starting point
rather than edited on each batch. **The live figure is asserted by
`packages/database-testing/src/durability-coverage.test.ts`, which is the authority** — a prose number
here would go stale between one batch and the next, and a stale number in a document called a register is
worse than none. As of Batch L: **132** collections written, **123** mapped, **9** unmapped — the nine that remain are `agent-runtime`'s, which have no tables at all. The written
total is above 129 because the gate itself had two blind spots, both since corrected — it read only
`src/index.ts`, and its collection-name pattern dropped every name containing a digit.

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

Measured again after Batch L: **105 of 108** tables force row-level security, **zero** carry ENABLE without
FORCE, and the three without any boundary are `trust_migration_ledger` — which the owner writes and every host
reads at startup — and `contracts` and `milestones`, two dead legacy tables no engine reads or writes and no
batch activated. The 59 fell to zero without a single edit to the ceiling that recorded them, which is what
that ceiling was for. Asserted in `wave6-batch-l-repository.postgres.test.ts`.

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
| 5 | `agreement-intelligence` | 16–20 | 6 | contract versions, analysis runs, risk assessments |
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
- **Batch G: `performance-readiness` (6) — DONE (`202608110009`).** Closed the `paymentTriggerRules` hole
  Batch B pointed at: `paymentEligibility.paymentTriggerRuleId` is now a foreign key rather than a bare
  `NOT NULL` column. Its discovery found the worst mutation-boundary defect of any batch so far, because
  this one *disabled working code* rather than permitting something it should not. `202608030005` put
  blanket append-only triggers on `acceptance_criteria`, `success_metrics` and `payment_trigger_rules`,
  and all three are aggregates their engines transition, so `confirm()`, `confirm()` and `activate()`
  every one refused on PostgreSQL. The third is the consequential one: `evaluate()` refuses any rule that
  is not ACTIVE, so a rule that could not leave DRAFT could never be assessed at all — the settlement path
  was citing a condition that, on the durable store, was permanently unassessable. That is a failure of
  CLAUDE.md's second hard constraint arriving as an absence rather than as a wrong answer, which is why
  nothing caught it: no bad release was produced because no release could be produced.
- **Also closed while building Batch G's fixtures (`202608110010`).** Six routed tables still carried the
  *historical* unique keys underneath their tenant-scoped replacements — `performance_blueprints
  UNIQUE (contract_id, version)` among them. Batches A-F added the scoped keys and none removed the old
  ones, so whichever tenant reached a `(contract_id, version)` pair first held it against every other
  tenant on the deployment, permanently. A cross-tenant denial of service needing no privilege and no
  mistake, found because a two-tenant fixture did the ordinary thing and was refused. Eleven further
  tables have keys of the same shape and are deliberately left alone: no store route reaches them, so the
  batch that activates each one should carry its key across.
- **Batch H: `governance-core` (11) — DONE (`202608110011`).** The tightest closure in the register: all
  thirty-two of its foreign keys point inside the eleven or at the deprecated `workspaces` table, and
  nothing outside references any of them. Its discovery inverted Batch G's. Where Batch G found triggers
  that refused what its engines did, Batch H found **eight of eleven tables with no mutation boundary at
  all** — and the three that had one were, for the first time in the register, correct.
  What was unprotected was the release-authorisation chain. `createEscrowReleaseIntent` reads a payment
  authorization proposal, requires `status === 'PROPOSED'`, and then instructs a certified Financial
  Provider. No engine ever updates a proposal, so nothing in the database said so, and a BLOCKED proposal
  carrying `['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED']` was one statement from authorising a release:
  `UPDATE payment_authorization_proposals SET status = 'PROPOSED', blockers = '[]'`. `dod_evaluations
  .mandatory_passed` — what produces `DOD_NOT_SATISFIED` — and `payment_trigger_definitions.amount_minor`
  were exposed the same way. CLAUDE.md's second hard constraint says no unconditional release path exists;
  on the durable store one did, needing no privilege beyond the write access the application already holds.
  Batch H also carried across the six tenant-blind unique keys `202608110010` deferred to it, including
  `digital_certification_records UNIQUE (certificate_number)` — global, while the engine numbers
  certificates by counting its own rows, so every tenant produced `AP-CERT-2026-000001` and only the first
  could store it.
- **Batch I: `agreement-intelligence` (6) — DONE (`202608110012`).** Six, not the five this register
  recorded until now. `contractVersionsV2` is written by `ContractVersionEngine` and was absent from both the
  register and the coverage baseline, because the gate's collection-name pattern was `[a-zA-Z]+` and silently
  dropped every name containing a digit — so an engine write with no durable mapping sat unseen inside the
  gate that exists to find exactly that. It was the only collection so hidden, and it turned out to be the
  parent of four of the other five: finding it is what made this closure tractable rather than unbounded.

  Three firsts in this batch. **The closure is larger than the aggregate set.** `agreement_intelligence_items`
  and `contract_analysis_findings` reference it and no engine writes either; they are leaves, but their
  `*_id` columns point at aggregates whose identity converts from UUID to TEXT, so they are converged and
  governed *without* being routed. **A table in the closure never existed at all**: `analysis_reviews`, so a
  reviewer's decision on a machine-generated finding had nowhere to be recorded and the human-in-the-loop
  rule left nothing to audit afterwards. And **an engine defect had to be fixed before the schema could hold
  the invariant**: `contentHash` digested each intelligence item *including* its review status, while
  `review()` changes that status without recomputing the hash — so after any review the stored hash described
  a state that no longer existed, and `publish()` emitted it as the citation for what was published. The
  engine now digests only what was extracted, which is what lets `content_hash` be immutable rather than a
  value that silently goes stale.

  What was unprotected was the human-in-the-loop rule itself. `publish()` refuses `HUMAN_REVIEW_REQUIRED`
  while any item is PENDING, but that is a guard in one method, and these items become the contract's
  parties, milestones and payment triggers downstream — so an unreviewed one is an unverified term entering
  the settlement path. It is now a CHECK on the row. Two more of the same kind: a risk `level` must follow
  from its `score` on the engine's own thresholds (the banner is what a reader acts on, and it was free to
  disagree with its own number), and an assessment's score is immutable once validated, so a rating cannot be
  lowered after sign-off.

  Batch I also **found a defect in its own first draft**: step 3 drops the tenant-blind unique keys on the
  closure, and the first version re-added only two of the four. The two it dropped silently were
  `contract_risk_assessments (contract_version_id, version)` and `agreement_intelligence_versions
  (contract_id, version)` — revision keys the engines compute by counting what exists, so two concurrent
  calls both write the same revision. Trading a cross-tenant collision for a duplicate revision is the worse
  of the two, and it was caught by reading the original `CREATE TABLE` statements rather than by any gate.
- **Batch J: retire the file-backed domain store — DONE (`202608110013`).** Not one of the 67, and future
  state 4 rather than an entry in the register — but the item future state 5 names as the condition holding
  the deferred group, so it comes before them. It found the worst defect of the programme, and this register
  is where the wrong claim was written: the eight `FileAssuraStore` routes were recorded here as "a separate
  question from the 67 — they work". They do not. `FileAssuraStore.load()` refuses in every durable
  deployment class, and one of the eight is `POST /v1/workspaces`. Nothing else created a workspace, every
  protected route resolves its trust scope from the caller's workspace, and a caller without one carries no
  tenant — so forced row-level security matched no row and **161 durable routes were individually correct and
  collectively unreachable**. A durable deployment could not be started at all.

  Two further defects sat behind it. `OrganizationService.createWorkspace` — the durable path, with zero
  callers — minted a fresh tenant per workspace, so its own insert fell outside the caller's scope and was
  refused by `trust_tenants_self`; reproduced live before it was fixed. That also made tenant and workspace
  1:1, contradicting the composite `(tenant_id, workspace_id)` keys every batch from A to I carries. And an
  out-of-scope write reported itself as `PERSISTENCE_UNAVAILABLE`, so the one defect that stopped a deployment
  starting arrived looking like an outage — the mistake `postgres-store.ts` already forbids two blocks earlier
  for the immutability triggers.

  Batch J also re-measured a claim this register propagated. `workspaces` was recorded as the foreign-key
  parent of 93 Engine 06-60 tables; it is **16**, because Batches A-I converged 77 of them. Fifteen of the
  sixteen are the deferred batches' own tables, so the three compatibility tables are blocked on activating
  those — not on the file store. See `docs/persistence/DOMAIN_STORE_RETIREMENT.md`.
- **Batch K: `enterprise-intelligence` (6) — DONE (`202608110014`).** The first of the deferred group, and
  the cleanest closure in the register: nothing outside the batch references it, nothing inside references
  anything outside except the deprecated workspace table, and the single intra-set key is
  `kpi_values.kpi_definition_id`.

  Its discovery repeated Batch G's, twice, and the second instance is worse. `202608030008` put blanket
  append-only triggers on all six tables, and two of the six are aggregates their engines transition:
  `EnterpriseKpiEngine.retire` and `PredictiveExecutionIntelligenceEngine.review`. So a KPI definition could
  never leave ACTIVE, and **a forecast could never be reviewed** — while that package's own header states its
  AI-governance contract as "a forecast can never auto-decide anything; it starts NOT_REVIEWED and a human
  must explicitly accept or reject it". On PostgreSQL the human-in-the-loop step the aggregate exists for was
  unperformable, and every forecast stayed NOT_REVIEWED forever. It is the mirror image of the defect Batch I
  fixed for Engine 20: there the database permitted publishing without review, here it forbade recording one.

  All six also carried `ENABLE ROW LEVEL SECURITY` without `FORCE`, predicated their policies on the
  superseded `current_workspace_id()` and `has_active_workspace_membership()`, and had no unique key beyond
  their primary key — so two concurrent `define` calls could produce two ACTIVE definitions of one KPI with
  different targets, and nothing to say which a dashboard meant.

  Three derived fields become constraints, all of the same class: a field the engine computes from others in
  the same row, which the row can contradict while reading as authoritative. An execution index is
  `overridden` with score 0 exactly when a mandatory gate failed and `failed_gates` matches its own gate list;
  a settlement index is the same shape driven by the dispute hold, so an index cannot read healthy while
  CLAUDE.md's second hard constraint is holding; and a dashboard snapshot holds only widgets its own role may
  see, because `compose` filters them and a stored widget outside the allow-list is a figure the viewer was
  never entitled to — the fixture's own widget is a payable amount.

  Measured after the batch: `workspaces` is down from 16 dependants to **10**, and the policies calling
  `has_active_workspace_membership()` from 16 to **10**. What remains is the nine `enterprise-analytics`
  tables and `workspace_memberships` itself.
- **Batch L: `enterprise-analytics` (9) — DONE (`202608110015`), and the retirement with it
  (`202608110016`).** The last batch in the register, and the one that carries the sharpest instance of the
  pattern every batch since A has found.

  Four of the nine are transitioned, and **every one of the four was broken, in both possible directions at
  once.** Three carried a blanket append-only trigger from `202608030009`, so the transition refused: a
  financial forecast could not be reviewed, a model could not be deprecated, an AI recommendation could not be
  accepted or dismissed. The fourth, `drift_alerts`, carried **no mutation boundary at all** — so
  `acknowledgeDrift` and `resolveDrift` worked, and so did lowering an alert's severity or deleting it.

  These sit in the engine whose own header calls it "the capstone AI-governance engine for the whole
  platform", and the effect was that **every human decision point in the platform's AI governance was
  unperformable on PostgreSQL, while the evidence of model failure was the one thing anybody could edit.**
  `recordEvaluation` raises a drift alert automatically when a score falls below its threshold, so the
  platform could detect that a model had gone wrong, could not take it out of service, and could have the
  record of the failure quietly rewritten. Engine 56's forecasts are FUNDING_DELAY, PAYMENT_FAILURE, LEAKAGE
  and RECONCILIATION_EXCEPTION, so the unreviewable output is about money.

  `evaluation_records.passed` becomes a real CHECK rather than an application invariant, because `score` and
  `threshold` are both in the row — unlike Batch K's `kpi_values.on_track`. It is the most consequential
  constraint of the batch: a row claiming a pass below its own threshold does not merely misreport, it
  suppresses the alert that would have prompted anyone to look.

  **And the retirement.** `202608110016` drops `workspaces`, `workspace_memberships` and `user_identities` —
  the three trust-domain compatibility tables `202608080001` had to retain twelve batches earlier, naming
  `persistence.domain-store-durability` as the condition. The dependant count on `workspaces` went 93
  (recorded, never re-measured) → 16 (Batch J, measured) → 10 (Batch K) → 1 (Batch L), and that one was
  `workspace_memberships`, which by then had no children of its own. The three referenced only each other, so
  they dropped together, along with `has_active_workspace_membership()` and the superseded
  `current_workspace_id()`.
- **Last: `agent-runtime` (9).** Deferred with the intelligence engines. Its nine collections have **no
  tables at all**, so unlike every batch since A this one creates rather than converges — and it holds nothing
  else back, since the compatibility tables are already gone.

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

  > **Wrong, and corrected by Batch J.** They do not work: `FileAssuraStore.load()` refuses in every durable
  > deployment class. And they are not a separate question, because one of them is the only route that creates
  > a workspace — so their failure was what made all 161 durable routes unreachable. This was the most
  > consequential error in this document, and it survived because "they work" was inferred from the routes
  > existing rather than checked against the gate that refuses them.
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
