# Wave 6 Batch E activation

**Status: IMPLEMENTED.** Records what the first batch of the durability gap did — the six
performance-blueprint aggregates of canonical Engines 21–25 — and what it deliberately did not do.

Follows `docs/persistence/DURABILITY_GAP_ANALYSIS.md`, which registers sixty-seven unmapped
collections and sequences them. Batch E is the first entry in that sequence.

## Why this batch is first

Three of these six aggregates are **canonical chain links**: `performanceBlueprints`,
`blueprintMilestones` and `dodPackages`. Six aggregates of work repair three of the four broken links
at the front of the chain, which is the best ratio of central-claim repair to effort in the whole
register.

The chain census in `durability-coverage.test.ts` moves from **7 of 11 to 10 of 11**. Only
`agreements` remains, and Batch F closes it.

Before this batch, the durable half of the chain referenced a half that did not exist: an
`ExecutionWorkspace` carried a `milestoneId` and a `Milestone` could not be stored. Every one of these
six was refused by `PostgresTrustStore` with `PERSISTENCE_COLLECTION_NOT_MAPPED`, so there is nothing
to backfill and routing each collection to its table is the read and write cutover in one change —
the same position Batches A–D each started from.

## The closure is the six, measured

Computed against a live migrated instance. Every outbound foreign key from these six goes inside the
six or to `workspaces`, which convergence replaces, and **no table outside the six references any of
them**. `performance_blueprints.contract_id` points at the agreements model Batch F will converge and
carries no constraint today, so converting it breaks nothing.

All six held zero rows, re-verified at apply time; the migration raises
`WAVE6_BATCH_E_AUTHORITY_REFUSED` naming the populated table and changes nothing.

## `version` already meant something else, and that shaped the batch

`performance_blueprints.version` and `dod_packages.version` **already exist as domain fields**.
`PerformanceBlueprintEngine.draft` sets `version = existing.length + 1` — this is blueprint revision 3
*of a contract*, not row revision 3 of a record — and it is never updated: a new revision is a new row
and the old one becomes `SUPERSEDED`.

Batches A–D added `version INTEGER` for optimistic concurrency and made the governed-transition
trigger require it to advance on every UPDATE. Doing that here would conflate two meanings in one
column: superseding a blueprint would have to "advance" its revision number, making revision 3 become
revision 4 while still being the row that revision 4 supersedes.

So the concurrency column is **`row_version`**, on all six rather than only the two that collide —
one name across the batch means no per-table exception to remember. The domain `version` joins the
immutable list, because which revision a row *is* cannot change.

### The shared trigger was generalised, not cloned

`enforce_governed_aggregate_transition` hard-coded `version`. It now accepts an optional first
argument, `concurrency=<column>`, and defaults to `version` when the marker is absent — so all 35
previously-governed tables are unaffected and Batch E passes the marker. A second near-identical
function would have been the `runtime/duplicate-abstraction` finding this repository already carries
one of.

**This nearly shipped a serious regression.** `TG_ARGV` is zero-based, and the first draft sliced from
index 1 when no marker was present — which silently drops the *first* immutable column, always `id`.
That would have made the primary key mutable on all 35 aggregates the earlier batches govern, while
every trigger still appeared to be in place. Caught by testing the slice semantics directly
(`TG_ARGV[1:n]` on `('id','a')` yields `{a}`), fixed to start at 0, and then proved behaviourally:
the full 254-test PostgreSQL suite passes, including the Batch A–D assertions that `id` and other
facts are immutable.

## Five of six carried a boundary that contradicted their engines

All six had a blanket `<table>_append_only` trigger. **Four are transitioned** — a blueprint is
activated and superseded, a scope item and a deliverable are confirmed, a package is published and
superseded — so the blanket trigger would have refused every one of those. Fifth instance of this
defect, after five tables in `202608100001`, three in `202608100002` and one in `202608110002`.

`blueprint_milestones` and `milestone_sequence_edges` stay append-only, and that was **checked rather
than assumed**: `BlueprintMilestone.status` declares a `CANCELLED` value and **nothing in the
repository ever writes it**. A table is append-only because of what the engines do, not because of
what its type allows.

## Read before written, which changed what got added

Most of what a first draft would add was already there. `202608030004` already carries
`CHECK (quantity > 0)`, `CHECK (budget_amount_minor > 0)`,
`CHECK (value_allocation_percent > 0 AND value_allocation_percent <= 100)` and
`CHECK (predecessor_id <> successor_id)`. Adding them again would be two constraints for one rule —
and the allocation bound a first draft reaches for, `>= 0`, is **weaker** than the one already
present, so it would have read as tightening while loosening.

What was genuinely absent, and is now enforced:

- **The governed currency set**, for the first time outside the settlement batches.
  `blueprint_milestones.currency` accepted any string. MONETARY_INVARIANTS governs representation
  wherever an amount exists, not only where it moves.
- **Ordered milestone dates** — neither date was bounded, so a milestone could be due before it
  started and every downstream calculation would inherit the inversion.
- **A tenant-scoped sequence-edge key.** `UNIQUE (predecessor_id, successor_id)` predates tenancy and
  is global — the same shape as the global `UNIQUE (certificate_number)` Batch A found. Not a live
  defect, because milestone identifiers already make the pair unique, but a global constraint on
  tenant data is one deployment away from refusing a second tenant's legitimate write.
- **The uniqueness the engines enforce by counting**: one `ACTIVE` blueprint per contract, one
  `PUBLISHED` package per milestone, one blueprint revision per contract and version, one package
  revision per milestone and version. Every one is a rule an engine checks by reading rows first,
  which two concurrent requests both pass.
- **Tenancy and FORCE row-level security** on all six, which carried `ENABLE` without `FORCE` — a
  boundary that does not constrain the table owner.

## What was delivered

| Piece | Where |
|---|---|
| 6 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-e.ts` |
| 6 compile-time conformance assertions | `packages/performance-blueprint/src/persisted-contracts.test.ts` |
| 6 relational repositories | `packages/database/src/batch-e-repository.ts` |
| Store routing for all 6 collections | `packages/database/src/postgres-store.ts` |
| Convergence, invariants, boundaries, trigger generalisation | `supabase/migrations/202608110004_wave6_batch_e_performance_blueprint.sql` |
| Readiness requirement for the 6 tables | `packages/database/src/migrations.ts` |
| 23 live-PostgreSQL certification tests | `packages/database-testing/src/wave6-batch-e-repository.postgres.test.ts` |
| Baseline ratcheted 67 → 61 | `packages/database-testing/src/durability-coverage.test.ts` |

## Two column types the settlement batches never met

- **`DATE`** is read as `::text`, not rebuilt from a driver `Date` — a `Date` is an instant, and
  turning one back into a calendar date means choosing a zone to read it in. The Batch A lesson,
  applied where it recurs.
- **`numeric`** arrives as a string like `bigint`, but `quantity` and `value_allocation_percent` are
  genuinely fractional — 2.5 tonnes, 12.5% — so they are read as finite numbers rather than forced to
  integers. Money keeps the stricter reader: a budget beyond the exactly representable range is
  refused rather than rounded.

## What is not claimed

- **The blueprint's total value allocation is not enforced.** `activate` bounds it at 100% across
  every `SCHEDULED` milestone, which is a cross-row sum over a set with **no completion signal**:
  milestones are added one at a time and the total is only meaningful at activation. A deferred
  constraint trigger of the kind Batch C used for journal balance would fire at COMMIT of whichever
  transaction happened to add a milestone, refusing a partial plan that is legitimately partial.
  Closing it needs an explicit "plan complete" transition the domain does not have. Recorded rather
  than approximated.
- **Acyclicity of the sequence graph is not enforced beyond a self-edge.** A cycle of length two or
  more is a property of the whole graph.
- **No optimistic concurrency at the application boundary.** Unchanged from every prior batch.
- **`performance_blueprints.contract_id` has no foreign key yet.** Its parent is Batch F's.
- **Sixty-one collections remain unmapped**, and the coverage gate holds that number as a ceiling.
- **No historical migration is modified** — `202608110004` is forward-only and additive.

## One pre-existing test updated

Batch D's suite asserted `REQUIRED_DOMAIN_AGGREGATE_TABLES` has exactly 35 entries. True when
written, false the moment another batch lands. It now asserts the durable claim — that the wave 4–5
plan's own registries total 35, and that every one of those tables is required — which stays true as
the register is worked through. The same correction Batch C made to Batch B's suite, for the same
reason.

## Evidence

- 23 live-PostgreSQL tests: three chain links durable and 41 tables required, TEXT identity and FORCE
  on all six, the populated-table refusal, exact round-trip of a blueprint including its revision, the
  row counter advancing while the revision does not, a refused revision change, a refused
  non-advancing write naming `row_version`, post-terminal refusal, exact money and calendar dates, a
  fractional quantity, an unsupported currency refused through the store *and* a direct statement, an
  inverted date range, a self-edge and a duplicate edge, a second `ACTIVE` blueprint, a duplicate
  revision, a second `PUBLISHED` package, a cross-tenant parent reference, cross-tenant invisibility,
  permitted confirmations, a terminal-state refusal, an immutable planned fact, a refused DELETE, and
  append-only enforcement in both store and database.
- 24 unit tests and 6 compile-time conformance proofs in `performance-blueprint`.
- Full gates: typecheck 0, lint clean, **790** default, **254** PostgreSQL, **78** runtime,
  `repo:certify` **11/11**.
