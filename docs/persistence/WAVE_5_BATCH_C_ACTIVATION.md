# Wave 5 Batch C activation

**Status: IMPLEMENTED.** Records what `persistence.domain-store-durability` did for Batch C — the
seven settlement-and-money-movement aggregates of canonical Engines 44, 47, 48 and 50 — and what it
deliberately did not do.

Governed by `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md`,
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` and
`docs/finance/MONETARY_INVARIANTS.md`. Follows `docs/persistence/WAVE_5_BATCH_B_ACTIVATION.md`,
whose migration converged two of these seven tables and said Batch C would activate them.

Batch B was the first batch to *carry* money. Batch C is the batch where money **moves**, and where
the one invariant the whole programme could not express anywhere else finally has a home.

## The entry gate: a decided double-entry mechanism

The accepted decision will not let Batch C begin without "a decided double-entry enforcement
mechanism — constraint, deferred trigger, or transactional posting procedure". Deciding it was the
first work, and the decision is recorded in the migration header as well as here.

**The ledger was single-entry with a double-entry vocabulary.** `LedgerEntry` has always been typed
`DEBIT | CREDIT`, but `ReconciliationLedgerEngine.record` posted **one leg at a time**, and both of
its call sites posted a lone `DEBIT`. Nothing had ever written a matching pair. So enforcing balance
was never only a schema change — it required the engine to post pairs.

The alternatives, and why they lose:

| Mechanism | Why not |
|---|---|
| `CHECK` constraint | Cannot see other rows. Balance is a property of a *set*, so a `CHECK` can only restate one row's own amount. |
| Row-level `AFTER INSERT` trigger | Fires *between* the legs. It would refuse the first leg of every balanced pair, making correct behaviour impossible rather than merely unchecked. |
| Posting procedure alone | Evadable by the direct `INSERT` that Batches A and B exist to defend against. MONETARY_INVARIANTS names "enforcing balance only in TypeScript" a prohibited shortcut, and a procedure a console session can bypass is that shortcut wearing a SQL hat. |
| **Deferred constraint trigger** ✅ | `DEFERRABLE INITIALLY DEFERRED` fires at COMMIT, when the whole posting is visible. An unbalanced state *inside* a transaction is permitted; an unbalanced *committed* state is impossible, for every writer. |

The journal key is `(tenant_id, payment_instruction_id, currency)` — carrying currency because
MONETARY_INVARIANTS requires a journal to balance independently per currency. It needs **no new
grouping column**: every posting must itself balance, so the running total over all postings for an
instruction stays balanced, and inventing a `journal_id` the domain type does not have would be
inventing state.

The trigger reads `ledger_entries` as the caller, **not** `SECURITY DEFINER`. Under FORCE row-level
security it therefore sees exactly the caller's tenant and workspace — which is the whole journal,
because an instruction's postings cannot span workspaces — and it gains no authority the caller
lacks.

### What this required of the engine

`record` (one leg) is replaced by `post` (one balanced journal transaction: an amount, a debit
description and a credit description). Both legs go through `store.transaction`, so they reach the
database as one unit and the deferred trigger sees them together. The single transaction is
load-bearing, not an optimisation: posting the legs in separate transactions is refused by the
database, correctly.

This is a **behaviour change to a money-movement engine**, and it is a correction rather than an
invention — posting balanced pairs is Engine 48's canonical behaviour, and single-leg posting was the
defect. Per CLAUDE.md, the non-custody suite is extended rather than merely re-run: two new
assertions prove the ledger engine takes no provider gateway at all (a record-keeping engine that
could reach a provider would be a second money-movement path) and that both legs commit as one unit.

The event changed with it: `LedgerEntryRecorded` (per leg) became `LedgerJournalPosted` (per
journal), emitted **after** the commit that proved the journal balances. An event announcing a
posting the database went on to refuse would be an event for something that never happened.

## The closure was self-contained, and that was measured

Batch B had to converge two Batch C tables because foreign keys ran in both directions across the
boundary. Batch C's own closure was computed the same way, against a live migrated instance:

| Key | |
|---|---|
| `ledger_entries.payment_instruction_id → payment_instructions(id)` | inside |
| `reconciliation_records.payment_instruction_id → payment_instructions(id)` | inside |
| `financial_closure_certificates.final_settlement_account_id → final_settlement_accounts(id)` | inside |

Every inbound key originates inside the five, and every outbound one goes inside them or to
`workspaces`, which convergence replaces. **No Batch D table references them** —
`disputes.release_request_id` and `dispute_holds.release_request_id` are bare `UUID` columns with no
constraint, so nothing breaks. The convertible unit is exactly the five tables the historical set
left unconverged, and the migration refuses on any inbound key from outside it.

`funding_commitments` and `fund_reservations` are converged already. This migration **activates**
them — grants, repositories, routes, readiness — which is the other half of "converging a table is
not activating it" being executable. Batch B's `BATCH_B_CONVERGED_NOT_ACTIVATED` now names two tables
that `REQUIRED_DOMAIN_AGGREGATE_TABLES` *does* contain, and a test asserts exactly that: Batch B
never claimed them, Batch C does.

All seven hold zero rows, re-verified at apply time. The migration raises
`WAVE5_BATCH_C_AUTHORITY_REFUSED` naming the populated table and changes nothing.

## What was delivered

| Piece | Where |
|---|---|
| 7 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-c.ts` |
| 7 compile-time conformance assertions | `packages/{settlement-assurance,settlement-execution}/src/persisted-contracts-batch-c.test.ts` |
| 7 relational repositories | `packages/database/src/batch-c-repository.ts` |
| Store routing for all 7 collections | `packages/database/src/postgres-store.ts` |
| Balanced journal posting | `packages/settlement-execution/src/index.ts` (`ReconciliationLedgerEngine.post`) |
| Double entry, tenancy, uniqueness, arithmetic, mutation boundaries | `supabase/migrations/202608110001_wave5_batch_c_settlement_ledger.sql` |
| `PERSISTENCE_LEDGER_UNBALANCED` | `packages/database/src/store-error.ts` |
| Readiness requirement for the 7 tables | `packages/database/src/migrations.ts` |
| 27 live-PostgreSQL certification tests | `packages/database-testing/src/wave5-batch-c-repository.postgres.test.ts` |

As with A and B there is **nothing to backfill**: `PostgresTrustStore` refused all seven collections
with `PERSISTENCE_COLLECTION_NOT_MAPPED`, so Engines 44 and 47–50 could not persist to PostgreSQL at
all. Routing each collection to its table is the read cutover and the write cutover in one change.

## The unbalanced refusal needed its own error code

`PERSISTENCE_LEDGER_UNBALANCED`, not `PERSISTENCE_TRANSACTION_FAILED`. Deferred triggers fire at
COMMIT — inside `sql.begin` but outside every statement — so the failure arrived at the store's
transaction wrapper *raw* and was being blanket-wrapped as a transaction failure. That reads as an
outage and invites a retry that can never succeed. The wrapper now translates first and only falls
back to `PERSISTENCE_TRANSACTION_FAILED` for a genuinely unrecognised failure, which also means
unique, foreign-key and check violations that fire at commit now surface accurately.

## Six more invariants the database now enforces

1. **Tenancy** on five more tables, replacing `workspace_id UUID REFERENCES workspaces(id)` — the
   deprecated compatibility table — with `trust_tenants`/`trust_workspaces` and FORCE row-level
   security.

2. **A foreign key from `payment_instructions.release_request_id`, which had none at all.** The third
   instance of this defect, after `authorization_decisions.release_request_id` in Batch B. An
   instruction could name a release request that did not exist, in this tenant or any other — for a
   money-movement record, an instruction with no authority behind it. Restored carrying currency, so
   an instruction cannot claim in a currency its release request did not authorise.

3. **Reconciliation uniqueness**, which the exit gate names:
   `(tenant_id, payment_instruction_id, provider_statement_reference)`. Without it the same provider
   statement line reconciles twice and both rows look authoritative. Plus non-negative amounts, and
   `matched` **derived** rather than accepted — a record asserting a match its own amounts contradict
   is not reproducible, and reconciliation outcomes must be reproducible from the persisted record.

4. **Tenant-scoped idempotency.** `UNIQUE (workspace_id, idempotency_key)` predates tenancy.
   Deliberately **not** widened to include `provider_key` despite MONETARY_INVARIANTS speaking of
   "operation scope": `PaymentExecutionEngine.issue` deduplicates on the key *regardless of
   provider*, so a per-provider key would admit a second instruction the engine intends to
   deduplicate — the database would be looser than the behaviour it enforces.

5. **Settlement arithmetic.** `outstanding = total_entitlement − total_settled`, replacing three
   independent bounds that permitted an account claiming to owe more than it was ever entitled to.
   Plus `(status = 'CLOSED') = (closed_at IS NOT NULL)`, because a closure with no time cannot be
   placed in the audit chain and the closure certificate cites the account as evidence. Plus one
   `ISSUED` certificate per account as a partial unique index — the engine counts rows before
   issuing, which two concurrent requests both pass.

6. **Mutation boundaries.** `payment_instructions` carried **no trigger at all** and permitted
   arbitrary UPDATE and DELETE on a money-movement record. `final_settlement_accounts` and
   `financial_closure_certificates` carried blanket append-only triggers that would have refused the
   transitions their engines perform — closing an account, revoking a certificate — the same defect
   corrected in `202608100001` and `202608100002`. `ledger_entries` and `reconciliation_records` are
   genuinely append-only and stay so, asserted rather than assumed, as are Batch B's two governed
   pairs.

### The defect this batch nearly introduced in reverse

`FAILED` reads like a terminal state for a payment instruction. It is not:
`PaymentExecutionEngine.submit` accepts `DRAFT` **or** `FAILED`, so a provider rejection is
retryable and `attempts` climbs. Naming `FAILED` terminal — which the first draft of this migration
did — would have made **every retry impossible**: the mirror image of the blanket-append-only defect
found in Batches A and B, and just as invisible until a provider rejected a payment in production.
Only `REVERSED` is terminal, and a test asserts the retry path survives.

## Non-custody, re-certified

The exit gate requires it, and nothing here weakens it. No column in this batch represents a balance
AssuraPay controls: `funding_commitments.external_custody_reference` and
`payment_instructions.provider_reference` name the licensed provider's own records. A ledger posting
is a *record* of money the provider moved, not an instruction to move it — proved by the ledger
engine taking no gateway at all. `external_custody_reference` is immutable under the
governed-transition trigger, because a writer that could repoint it could relabel whose funds these
are.

## Two gaps recorded rather than papered over

Closing either needs a change to a domain type, and this capability is persistence:

- **`ReconciliationRecord` has two amounts and no currency field.** Neither the schema nor the column
  can require one. The amounts are only ever compared to each other for a single instruction, so they
  inherit that instruction's currency in practice — but nothing enforces it. With a currency column
  the composite key to `payment_instructions` would carry it, exactly as `ledger_entries` does.
- **`PaymentInstruction` has an `idempotencyKey` and no payload digest.** MONETARY_INVARIANTS requires
  that reusing a key with a different semantic payload *fails*, which needs a stored digest to
  compare against. Uniqueness is enforced; semantic-equality-on-retry is not. Today
  `issue` returns the existing instruction for a repeated key, so a mismatched retry is silently
  accepted as the original rather than refused.

## What is not claimed

- **No optimistic concurrency at the application boundary.** Unchanged from A and B: `version` is
  maintained and the database requires it to advance, but `TrustPersistence.replace` takes a record
  and none of these records carries the version it was read at.
- **The balance trigger fires on INSERT, not UPDATE.** It does not need to: `ledger_entries` is
  append-only in both the store and the database, so a posted amount cannot be edited into an
  imbalance. That pairing is load-bearing, and a test asserts the append-only trigger survives —
  dropping it would silently make the balance guarantee escapable.
- **No FX and no conversion events.** Cross-currency postings are refused, not converted.
  MONETARY_INVARIANTS puts FX out of scope unless active canonical behaviour requires it, and none
  does.
- **Batch D is untouched**, as are Engines 49 and 51–60 and `persistence.generic-record-retirement`.
  `trust_records` is unchanged and remains authoritative for the trust aggregates.
- **No historical migration is modified** — `202608110001` is forward-only and additive.

## Two pre-existing tests updated, not weakened

Both were correct when written and became false *because* Batch C activated tables they asserted were
inactive:

- The Batch B suite asserted `REQUIRED_DOMAIN_AGGREGATE_TABLES` excludes `fund_reservations` and
  `funding_commitments`. It now asserts the durable claim — that **`BATCH_B_TABLES`** excludes them —
  which stays true as later batches land.
- `postgres-store.postgres.test.ts` proved the not-mapped refusal by naming a collection.
  That has now broken twice (`releaseRequests` at Batch B, `paymentInstructions` at Batch C), so the
  candidate is **derived** from `POSTGRES_TRUST_COLLECTIONS` instead, and fails with a stated reason
  if every candidate becomes mapped.

## Evidence

- 27 live-PostgreSQL tests in `wave5-batch-c-repository.postgres.test.ts`: the deferred trigger's
  flags, a balanced journal written leg by leg, a lone debit refused through the store *and* through
  a direct statement, legs that disagree on amount, per-currency balance, a later posting refused
  against a balanced running journal, exact `bigint` round-trip, currency agreement with the release
  request, a ghost release request, tenant-scoped idempotency, a reconciliation whose outcome its
  amounts contradict, duplicate statement reconciliation, settlement arithmetic, an untimed closure,
  a concurrent second closure certificate, a cross-tenant parent reference, cross-tenant
  invisibility, the retry path surviving `FAILED`, post-terminal refusal, an immutable instructed
  amount, a refused DELETE, append-only enforcement in both store and database, and an immutable
  external custody reference.
- 19 unit tests across the two engine packages, 7 compile-time conformance proofs, and 2 new
  non-custody assertions.
