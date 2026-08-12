# Post-wave-5 follow-ups

**Status: IMPLEMENTED.** Five items the Batch A–D activations named as outstanding, closed together
because each is small and none of them is a new capability.

Follows `docs/persistence/WAVE_4_BATCH_A_ACTIVATION.md` and the three
`WAVE_5_BATCH_*_ACTIVATION.md` documents. Nothing here activates a new aggregate; the wave 4–5 plan
was complete at Batch D.

## 1. The release path now consults the hold

`docs/persistence/WAVE_5_BATCH_D_ACTIVATION.md` recorded, under "What is not claimed":

> "The engine still does not call `isHeld` … the application learns about the hold from a
> `PERSISTENCE_RELEASE_HELD` failure rather than by checking first."

`ConditionalReleaseOrchestrationEngine.evaluate` now adds `DISPUTE_HOLD_ACTIVE` to its `blockers`
array when an active hold names the request. That shape was chosen over throwing because the engine
already has a blocker vocabulary, and it composes exactly with the database:

- the engine marks the request `BLOCKED` with a **named** reason, which the request row records;
- the trigger refuses anyone who tries to force `CONDITIONS_MET` regardless.

Enforcement and explanation are different jobs. The trigger cannot do the second one — a constraint
violation says a write was refused, not which of six release conditions failed — and the engine
cannot do the first, because it only binds callers who came through it.

Read through the store rather than by calling Engine 49: `settlement-assurance` does not depend on
`settlement-execution`, and adding that dependency to ask one question would couple the release path
to the dispute package for no gain. The hold is a record, and reading a record is what the store is
for.

The hold is reported **alongside** every other blocker rather than short-circuiting. A held request
with an unapproved invoice has two problems, and resolving the dispute does not fix the other one — a
check that returned early would send the caller round the loop twice.

## 2 and 3. The two gaps Batch C recorded are closed

Batch C said of both that closing them "needs a change to a domain type, and this capability is
persistence". The domain types changed, so `202608110003` can add the columns.

### `ReconciliationRecord.currency`

A reconciliation held **two money amounts and no unit**. Nothing was wrong in practice, because the
two amounts are only ever compared to each other — but MONETARY_INVARIANTS requires a currency to
travel with every amount, and without the column the key to `payment_instructions` could not carry
currency the way `ledger_entries` does. So a reconciliation could be recorded against an instruction
in a currency the reconciliation never named, and nothing would notice.

`ReconciliationLedgerEngine.reconcile` now loads the instruction and takes its currency, which is
also a second improvement: a reconciliation against an instruction that does not exist fails in the
engine with `NOT_FOUND` instead of at the foreign key. For a reconciliation report that is the
difference between "no such payment" and "database error".

**Backfilled, not guarded**, because the value is derivable: the currency of a reconciliation is the
currency of the instruction it reconciles, which is a column on that instruction. Refusing here would
be refusing to do arithmetic the schema already knows the answer to. A row whose instruction cannot
be found is refused rather than given an invented currency — such a row already violated its foreign
key, and filling it in would make a broken row look sound.

### `PaymentInstruction.payloadDigest`

MONETARY_INVARIANTS: "Reusing a key with a different semantic payload **fails**. This needs a stored
payload digest to compare against; a key alone cannot detect it."

Without it, `issue` returned the existing instruction for **any** repeat of the key — so a retry that
had drifted to a different beneficiary, a different amount, a different release request or a
different provider was silently accepted as the original. That is the single failure mode idempotency
exists to prevent, and it was the behaviour. `issue` now compares and raises
`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`; returning the original would discard the new intent, and storing
a second row would double-instruct the provider.

The digest covers release request, provider, beneficiary, amount and currency — everything that
determines what money moves and to whom. The id and the timestamps are excluded because they differ
on every call by construction. It is immutable under the governed-transition trigger, which is what
makes it evidence: a digest a writer could rewrite would let a drifted retry be made to match after
the fact.

**Guarded, not backfilled**, and the asymmetry with the currency column is the point. The digest is a
SHA-256 over a canonical JSON payload computed by the engine; reproducing it in SQL would mean
reimplementing that canonicalisation in PL/pgSQL and keeping the two byte-identical forever. A digest
that disagreed with the application's would make every legitimate idempotent retry fail as a payload
mismatch — worse than having none. In practice the refusal cannot fire: `payment_instructions` was
dead until `202608110001` activated it, so no deployment has rows.

## 4. The boundary rule is now an assertion, not a habit

Four batches each *discovered* that a table carried `ENABLE ROW LEVEL SECURITY` without `FORCE` — a
boundary that reads as protection and does not constrain the table owner — and each fixed its own
share by hand. Nothing prevented a fifth batch from repeating it, because the rule lived in four
migrations and a habit.

`packages/database-testing/src/store-boundary.postgres.test.ts` states it once, over the store's own
routing table: **if the store writes to a table, that table forces row-level security and predicates
it on the trust scope.** It fails on the table nobody remembered, which is the only kind that matters.

Two things it gets right that a looser version would not:

- **The tenant predicate is checked as a function, not a clause shape.** The trust tables reach
  `trust_current_tenant()` through a subquery on `trust_workspaces`, which is correct; a test
  matching on clause text would have called that a violation. The thirty-five domain aggregates must
  additionally reach `trust_current_workspace()`, because an aggregate belongs to one workspace and a
  tenant-only predicate would show a caller every workspace in its tenant.
- **The single exemption is asserted in reverse.** `trust_migration_ledger` must carry *no* boundary:
  it records what this database has applied, and the migration runner reads it before any tenant scope
  exists, so a tenant predicate would make the runner unable to see its own history. Written as an
  allow-list rather than a name pattern, because an exemption a table can fall into by being named a
  certain way is an exemption the next table gets by accident.

### The census, corrected

The capability registry's notes said 102 tables carry ENABLE without FORCE. Measured against a fully
migrated database it is now **59**, because Batches A–D converted their share. Five tables carry no
boundary at all. All 64 are outside the store's routing table, and the suite asserts that
disjointness — which is the claim that matters.

They are **not** forced by this change, and that is deliberate. `FileAssuraStore` serves Engines 06–30
and 51–60, so those tables have no reader and no writer, exactly as Batches A–D's tables did before
their activation. Forcing row-level security on a dead table would be a change that looks like
security work and delivers none, and it would break the historical policies, which predicate on
`current_workspace_id()` rather than on the trust scope. The number is reported as a ceiling, so
activating another batch can make it fall without editing the test, and nothing can make it rise.

## 5. The capability registry now describes what exists

`persistence.domain-store-durability` has derived as `missing → planned` through all four batches,
and this was reported three times as a stale-probe problem awaiting a decision. Reading the registry's
own `notes` field corrected that: **the capability is genuinely incomplete**, and the lifecycle is
right for a reason the probes obscured rather than caused.

Its declared scope is Engines **06–60**, and it names `FileAssuraStore` — JSON files with demo
seeding, implementing a different contract from `TrustPersistence` — as the thing that must stop being
production-active. Batches A–D delivered Engines 31–50. Twenty-five engines are still served by JSON
files.

So the `notes` are rewritten to state the division exactly: what the four batches delivered, what
remains, the corrected RLS census, and the three trust-domain tables (`workspaces`,
`workspace_memberships`, `user_identities`) that are still present because the Engine 06–60 model
depends on them.

**The probes are left pointing at the superseded shape**, and the reason is now written down rather
than re-litigated each batch: repointing them at `BATCH_A_RELATIONS` through `BATCH_D_RELATIONS` would
flip the derived lifecycle to `implemented` without changing what exists. They should be redrawn when
the remaining scope is designed — which needs a decision about whether Engine 06–60 state becomes
relational at all, and if so what parents its workspace foreign keys — and not before.

`pnpm repo:certify` confirms the lifecycle still derives as `missing`, so this change records a fact
without manufacturing a verdict.

## What is not claimed

- **`FinalSettlementEngine.close` still takes `noOpenDisputes`.** The database refuses closure over a
  live hold regardless, so the constraint holds; the parameter is now decorative rather than
  load-bearing. Removing it changes an exported signature for no gain in enforcement.
- **No optimistic concurrency at the application boundary.** Unchanged from all four batches.
- **The 59 unforced tables are untouched**, for the reason given above.
- **Engines 51–60 remain untouched**, and `persistence.generic-record-retirement` has not run.
- **No historical migration is modified** — `202608110003` is forward-only and additive.

## Evidence

- 5 unit tests for the release-path hold blocker, covering the clean path, the held path, the hold
  reported alongside other blockers, a released hold, and holds belonging to another request or
  another workspace.
- 1 unit test for the idempotency mismatch, covering drift in each of the four payload fields and
  asserting nothing was written on any refusal.
- 4 schema tests in `domain-contracts` for the two new fields, where the schemas are declared.
- 4 live-PostgreSQL tests in `store-boundary.postgres.test.ts`, plus a new assertion in the Batch C
  suite that the reconciliation key now carries currency.
- Full gates on this branch: typecheck 0, lint clean, **766** default, **231** PostgreSQL, **78**
  runtime, `repo:certify` **11/11**, reconciliation findings **15** unchanged.
