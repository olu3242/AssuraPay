# Trust schema ownership

Which relational object owns each trust aggregate, and what happened to the objects that
used to claim them.

This document explains the decisions. It is **not** the source of truth — that is
`packages/database/src/schema-ownership.ts`, which architecture validation, runtime readiness
and migration certification all execute. A documentation-only ownership map drifts from the
database the first time either changes, and then reads as authority while being wrong.

## The problem

The repository carried two relational models for the trust domain:

| | |
|---|---|
| The certified model | 10 `trust_*` tables written by `PostgresTrustStore` |
| An earlier model | 31 tables describing the same aggregates |

Both were created by every migration run, so every database carried both. They were not merely
redundant — they disagreed. `audit_records.aggregate_id` was typed `UUID`, while the live store
audits permission keys like `settlement:approve`. The old model could not hold what the
application produces.

## What the evidence showed

Two facts, established against a live instance rather than by reading SQL, decided the scope.

**There were never any dual writes.** The only production module issuing SQL against data is
`packages/database/src/postgres-store.ts`, and it names `trust_*` tables only. `FileAssuraStore`
contains no SQL at all — it is JSON files. Every appearance of a historical table name outside
`supabase/migrations` is in a test.

So the historical model held no rows on any database. This capability is a **retirement, not a
data migration**: nothing was migrated because there was nothing to migrate, and reporting
migrated-row counts would have been fabrication.

**The model is not uniformly removable.** PostgreSQL was the oracle rather than static
analysis — dropping the candidate set is refused, naming
`governed_executions_workspace_id_fkey`. Iterating that refusal fixes the surviving closure at
three tables.

## Dispositions

Every relational object in the database falls into exactly one class. Ownership is total; a
partial map is how the duplicate model survived unnoticed.

### Canonical — 10 tables

`trust_tenants`, `trust_workspaces`, `trust_memberships`, `trust_permission_grants`,
`trust_bootstrap_state`, `trust_records`, `trust_idempotency_keys`, `trust_audit_records`,
`trust_outbox_events`, `trust_migration_ledger`.

All carry forced Row Level Security except `trust_migration_ledger`, which has no tenant and is
identical for everyone — a policy on it would either deny the migration runner its own ledger or
permit everything, which teaches a reader that these policies are decorative.

`trust_records` owns several aggregates. That is not ambiguity: it is one generic record table
keyed by collection, which is how `TrustPersistence` stores identities, sessions, verification
results and legal policy. Each aggregate still has exactly one owning table.

### Retired — 28 tables

Dropped by `202608080001_trust_schema_ownership_reconciliation`. Each was empty, had no
production reader or writer, and had nothing outside the set depending on it.

The migration **re-checks emptiness at apply time and refuses** rather than dropping. "These
tables are empty" is a claim about every database that will ever apply this migration, not just
the ones it was written against, and a migration that assumed it and was wrong would destroy
data in silence. A database with rows here contradicts this capability's evidence and must stop
and be looked at, not be quietly reconciled. The refusal names the table and its row count, and
happens before any `DROP`, inside the runner's single transaction.

`DROP TABLE` lists all twenty-eight in one statement, deliberately **without** `CASCADE`: mutual
foreign keys inside the set resolve because every member is named, while anything outside the
set that depends on them fails the migration loudly instead of being dropped along with them.

### Compatibility — 3 tables

Retained, not canonical, and never written by the trust runtime.

| Table | Why it survives | Retirement condition |
|---|---|---|
| `workspaces` | foreign-key parent of 93 Engine 06–60 tables; dropping it needs `CASCADE`, taking that whole model | `persistence.domain-store-durability` |
| `workspace_memberships` | read by `has_active_workspace_membership()`, which the Engine 06–60 RLS policies call | `persistence.domain-store-durability` |
| `user_identities` | foreign-key parent of `workspace_memberships`, itself retained | `persistence.domain-store-durability` |

Each is marked `DEPRECATED` by `COMMENT ON TABLE` in the database itself, naming the canonical
owner and the retirement condition. The audience is a reader with a `psql` prompt and no access
to this repository — a table that looks canonical and is not is how the duplicate model would
get used.

The retirement condition is a **named capability**, not "eventually". A registry test rejects a
retained object whose condition does not match a capability id, because "temporary" without a
condition is permanent.

### Out of scope — 95 tables

Engine 06–60 domain state, currently owned by `FileAssuraStore` rather than by any relational
object. Classified rather than claimed: asserting ownership of a model nothing reads or writes
would assert durability that does not exist.

**This capability does not touch them.** It also does not fix that 102 of them carry
`ENABLE ROW LEVEL SECURITY` with no `FORCE` — the same defect `persistence.rls-certification`
corrected for the trust tables. That is real, and it is
`persistence.domain-store-durability`'s to resolve, because whether those tables should exist at
all is that capability's question.

## Certified versus safe to serve

`certifySchemaOwnership` reports two different verdicts, and conflating them would be wrong in
both directions.

- **`certified`** — no findings at all. What a deployment gate and the architecture check
  require.
- **`safeToServe`** — no `error` findings. What runtime readiness requires.

The distinction exists for one case. A retained compatibility object that has *since been
dropped* is registry staleness, not danger: it means the dependency keeping it alive is gone,
which is further along than this capability got. Blocking startup on it would mean a database
that had finished the follow-on work could not boot. Everything else — two models for one
aggregate, a canonical table missing or unforced, the runtime holding write privilege on
something it does not own — is an `error` and readiness is false.

Readiness reports findings by **code and table only**. The detail reaches logs, and a policy
expression or a connection string never should.

## What is not claimed

- Platform-wide durability. `FileAssuraStore` remains production-active for Engines 06–60.
- Platform-wide Row Level Security. It covers the trust domain.
- Engine 08 is still **Conditionally implemented**; schema convergence does not supply its
  governed API, permission or KPI surfaces.
