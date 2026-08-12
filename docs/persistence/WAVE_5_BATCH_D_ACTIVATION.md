# Wave 5 Batch D activation

**Status: IMPLEMENTED.** Records what `persistence.domain-store-durability` did for Batch D — the
five dispute-and-remediation aggregates of canonical Engine 49 — and what it deliberately did not do.

Governed by `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md`,
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` and
`docs/finance/MONETARY_INVARIANTS.md`. Follows
`docs/persistence/WAVE_5_BATCH_C_ACTIVATION.md`.

The last batch. With it, all **35** aggregates of the wave 4–5 plan have a durable home, and
CLAUDE.md's second hard constraint stops being a sentence in a document.

## Hold enforcement was the exit gate, and it was enforced nowhere

> "Every release is certified-work-backed. No unconditional 'release now' path exists. Release
> requires a valid Completion Certificate, Payment Eligibility record, approved Financial
> Entitlement, funding confirmation, authority approval **and no active hold**." — CLAUDE.md

Before `202608110002`, "no active hold" was enforced by nothing:

- **`DisputeResolutionEngine.isHeld` exists, computes the right answer, and no code path calls it.**
  Not the release orchestration engine, not the payment execution engine, not a route. It is a
  correct function with no callers.
- **`FinalSettlementEngine.close` takes `noOpenDisputes: boolean` as a parameter.** The caller
  asserts that nothing blocks closure — which is the weakest possible form of the constraint: the
  party who wants the money released is the one who declares nothing is stopping it.
- **A dispute hold had no durable home at all.** `disputeHolds` was absent from `GOVERNED_DOCUMENTS`,
  so `PostgresTrustStore` refused it with `PERSISTENCE_COLLECTION_NOT_MAPPED`. Holds existed only in
  `InMemoryTrustStore` — which is to say they did not survive a restart.

A hold is a **cross-row** property: it lives in a different table than the thing it blocks. So no
`CHECK` and no schema can express it, and MONETARY_INVARIANTS is explicit that an invariant PostgreSQL
can enforce must not exist only as an application check. It gets triggers, at all three points where a
hold must bite:

| Point | Trigger | Why |
|---|---|---|
| `release_requests` reaching `CONDITIONS_MET` | `release_requests_no_active_hold` | the release decision itself |
| `payment_instructions` on any INSERT | `payment_instructions_no_active_hold` | the money movement — an instruction could otherwise be issued against a request that reached `CONDITIONS_MET` *before* the hold was placed |
| `final_settlement_accounts` reaching `CLOSED` | `final_settlement_accounts_no_active_hold` | closing over a live dispute is the same violation wearing a different noun, and it is the one place the constraint was a caller-supplied boolean |

The release-request trigger fires on INSERT as well as UPDATE: a request created directly at
`CONDITIONS_MET` would otherwise skip the check entirely.

### Why the linkage keys carry workspace

Both hold functions read `dispute_holds` **as the caller**, not as `SECURITY DEFINER`. Under FORCE
row-level security that means they see only the caller's tenant *and workspace* — so a hold in the
same tenant but another workspace would be invisible, the count would come back zero, and the release
would proceed past a hold that exists.

Rather than granting the trigger elevated authority, the linkage keys force a hold into the same
workspace as the release request it holds:

```sql
FOREIGN KEY (tenant_id, workspace_id, release_request_id)
  REFERENCES release_requests (tenant_id, workspace_id, id)
```

That makes the caller's own scope provably sufficient, so the trigger needs no authority the caller
lacks. It required adding `UNIQUE (tenant_id, workspace_id, id)` to `release_requests`, additively.

## Two defects, and the second one freezes money forever

### 1. `disputes` carried no trigger at all

While `DisputeResolutionEngine` transitions it `OPEN → MEDIATION → DECIDED → APPEALED → CLOSED`.
Arbitrary UPDATE and DELETE were permitted — and since a dispute is what places a hold, **deleting a
dispute is how a blocked release gets unblocked without anybody resolving anything**. It now carries a
governed-transition and terminal-state pair: `CLOSED` is terminal, DELETE is refused, and the release
request under dispute, the kind, the description and the raiser cannot change.

### 2. `dispute_holds` carried a blanket append-only trigger

While `DisputeResolutionEngine.close` releases every active hold by writing
`active = false, released_at = now()`. **That UPDATE would have been refused. A hold could never be
lifted.** A dispute could be raised and never closed, and the release request it holds would be
blocked permanently — funds committed at the provider, work certified, and no path to release them.

This is the fourth instance of the blanket-append-only defect — five tables in `202608100001`, three
in `202608100002`, one here — and it is the worst of them. The others refused a state transition. This
one refuses *the removal of a block on money*, which fails in the direction that looks like caution
and is actually a permanent freeze. It is the one defect in the programme whose symptom would have
been indistinguishable from correct behaviour right up to the moment somebody asked why a settled,
certified milestone had never paid.

Corrected with the functions `202608100001` created. A released hold is **terminal on
`active = false`** — `to_jsonb(OLD) ->> 'active'` renders a boolean as `'true'`/`'false'`, so the
existing terminal-state function needed no change. Re-activating a released hold would block a release
with no new dispute behind it, which is a hold nobody raised.

## What was delivered

| Piece | Where |
|---|---|
| 5 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-d.ts` |
| 5 compile-time conformance assertions | `packages/settlement-execution/src/persisted-contracts-batch-d.test.ts` |
| 5 relational repositories | `packages/database/src/batch-d-repository.ts` |
| Store routing for all 5 collections | `packages/database/src/postgres-store.ts` |
| Hold enforcement, linkage, mutation boundaries | `supabase/migrations/202608110002_wave5_batch_d_dispute_linkage.sql` |
| `PERSISTENCE_RELEASE_HELD` | `packages/database/src/store-error.ts` |
| Readiness requirement for the 5 tables | `packages/database/src/migrations.ts` |
| 23 live-PostgreSQL certification tests | `packages/database-testing/src/wave5-batch-d-repository.postgres.test.ts` |

## The held refusal needed its own error code

`PERSISTENCE_RELEASE_HELD`, not `PERSISTENCE_CORRUPT_RECORD` or `PERSISTENCE_UNAVAILABLE`. A hold
refusing a release is **the constraint working**, not a failure — and a caller must be able to report
"this release is held" rather than "something went wrong". A retry is never the right response: a hold
is lifted by resolving the dispute that placed it, not by writing past it.

That is now the third refusal in this programme to earn a distinct code because the generic one would
have been actively misleading: `PERSISTENCE_HISTORY_IMMUTABLE` (Batch A),
`PERSISTENCE_LEDGER_UNBALANCED` (Batch C), `PERSISTENCE_RELEASE_HELD` (Batch D).

## The closure was the five, and nothing references them

Computed against a live migrated instance, as for B and C. Every outbound key from these five goes to
`disputes` (inside the closure) or to `workspaces` (which convergence replaces), and **no table
outside the five references any of them**. The cleanest closure in the programme — which is *why*
Batch D is last and not first: it depends on B and C for its linkage targets, and nothing depends on
it.

`disputes.release_request_id` and `dispute_holds.release_request_id` had **no foreign key at all** —
the fourth and fifth instances of that defect, after `authorization_decisions` in Batch B and
`payment_instructions` in Batch C. A hold against a release request that does not exist blocks
nothing while reading in every report as protection that was in place.

All five held zero rows, re-verified at apply time; the migration raises
`WAVE5_BATCH_D_AUTHORITY_REFUSED` naming the populated table and changes nothing.

## Three more invariants the database now enforces

- **A released hold records when it was released** — `(NOT active) = (released_at IS NOT NULL)`.
  Without it a hold could be deactivated with no time the block was lifted, and the audit chain could
  not say how long money was held.
- **One active hold per dispute per release request**, as a partial unique index. `raise` places
  exactly one; a second active row could only come from a retry or a direct statement, and it would
  have to be released twice to unblock the release.
- **One decision per dispute.** `decide` requires `OPEN` or `MEDIATION` and moves the dispute to
  `DECIDED`, so a second decision is unreachable through the engine — and two decisions on one
  dispute leave which one resolved it undecidable.

Evidence, positions and decisions stay append-only in both the store and the database: a retraction is
a new record, never an edit, because a dispute's record of who said what is the material an appeal is
decided on.

## What is not claimed

- **The engine still does not call `isHeld`, and `close` still takes `noOpenDisputes`.** The database
  refuses regardless, so the constraint holds for every writer — but the application learns about the
  hold from a `PERSISTENCE_RELEASE_HELD` failure rather than by checking first. Wiring `isHeld` into
  the release path is an engine behaviour change beyond Batch D's aggregates, and it would be an
  improvement in *diagnostics*, not in enforcement. Recorded as the next obvious follow-up rather
  than smuggled into a persistence capability.
- **A held release request can still be *drafted* and *blocked*.** The trigger guards
  `CONDITIONS_MET` specifically, not every write, because a held request must still be able to record
  that it is blocked — otherwise the hold would prevent the system describing the hold.
- **No optimistic concurrency at the application boundary.** Unchanged from A, B and C.
- **Engines 51–60 remain untouched**, as the accepted decision requires, and
  `persistence.generic-record-retirement` has not run. `trust_records` is unchanged and remains
  authoritative for the trust aggregates.
- **No historical migration is modified** — `202608110002` is forward-only and additive.

## One pre-existing test updated, and it told us so itself

`postgres-store.postgres.test.ts` proves that an unmapped collection is refused. Naming one had
already broken twice (`releaseRequests` at Batch B, `paymentInstructions` at Batch C), so Batch C made
the candidate *derived* — with an explicit guard: "every candidate collection is now mapped; pick one
a later batch has not activated".

Batch D tripped that guard on the first full run, because Batch C's candidates were all Batch D
aggregates. It failed with the stated reason instead of a puzzle, which is exactly what the guard was
for. The candidates now come from the intelligence collections of Engines 51–60, which the accepted
decision defers explicitly — so they cannot be activated by a wave 4–5 batch at all.

## Evidence

- 23 live-PostgreSQL tests in `wave5-batch-d-repository.postgres.test.ts`: all three hold triggers
  present by name, a release request refused at `CONDITIONS_MET` through the store *and* through a
  direct statement, a payment instruction refused outright, a settlement account refused at closure,
  a non-release state change permitted, the hold released (the UPDATE the blanket trigger would have
  refused), the release then proceeding, the instruction then issuing, re-activation refused as
  terminal, exact round-trip, a ghost release request refused for both a dispute and a hold, a second
  active hold refused, a second decision refused, a released hold with no time refused, a repointed
  dispute and two DELETEs refused, append-only enforcement in store and database, a cross-tenant
  reference refused, and cross-tenant invisibility.
- 15 unit tests and 5 compile-time conformance proofs.
- `REQUIRED_DOMAIN_AGGREGATE_TABLES` now holds exactly **35** tables — the whole wave 4–5 plan.
