# Wave 4 Batch A activation

**Status: IMPLEMENTED.** Records what `persistence.domain-store-durability` did for Batch A —
the sixteen execution-and-evidence aggregates of canonical Engines 31–40 — and what it
deliberately did not do.

Governed by `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` and
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md`. Follows
`202608090001_wave4_trust_authority`, which converged the tables' identity, tenancy and
row-level security but left them with no reader and no writer.

## The correction that changes the sequencing

The accepted decision describes the migration as *backfill from `trust_records` → validate →
switch reads → stop generic writes*, and reserves generic-row retirement for a later
capability. **For Batch A there is nothing to backfill.**

`PostgresTrustStore` never routed these sixteen collections anywhere. They are absent from
`GOVERNED_DOCUMENTS`, so every `append`, `replace` and `list` for an execution workspace, work
item, defect or completion certificate was refused with `PERSISTENCE_COLLECTION_NOT_MAPPED`.
Engines 31–40 could not persist to PostgreSQL at all; they worked only against
`InMemoryTrustStore`.

So the gap matrix's phrase "all 35 wave 4–5 aggregates persist as unvalidated JSONB payloads in
`trust_records`" is true of the *conceptual* model and false of the durable one. `trust_records`
holds zero rows for these collections on every database, because the only writer that could have
put them there refused them.

Consequences, all of which simplify the work rather than complicate it:

- No backfill, and no quarantine set, because there are no source rows.
- No read cutover distinct from the write cutover: routing the collection to its table is both,
  in one change, with no window in which two models are authoritative.
- No dual write to bound, and nothing for `persistence.generic-record-retirement` to retire here.
- Zero-loss rollback is reverting the change, not reverting a read source.

## What was delivered

| Piece | Where |
|---|---|
| 16 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-a.ts` |
| Shared primitives: identifier, instant, calendar date, minor units, required text | `packages/domain-contracts/src/primitives.ts` |
| 16 compile-time conformance assertions | `packages/{execution-orchestration,completion-assurance}/src/persisted-contracts.test.ts` |
| 16 relational repositories | `packages/database/src/batch-a-repository.ts` |
| Store routing for all 16 collections | `packages/database/src/postgres-store.ts` |
| Governed mutation boundaries and per-workspace uniqueness | `supabase/migrations/202608100001_wave4_batch_a_governed_transitions.sql` |
| Readiness requirement for the 16 tables | `packages/database/src/migrations.ts` (`REQUIRED_DOMAIN_AGGREGATE_TABLES`, `REQUIRED_STORE_TABLES`) |
| 26 live-PostgreSQL certification tests | `packages/database-testing/src/wave4-batch-a-repository.postgres.test.ts` |

A new package, `@assurapay/domain-contracts`, depending on nothing but `zod`. It exists because
both the engine packages that own the domain types and `@assurapay/database`, which persists
them, must import the same schema — and putting the schemas in either would have created a
dependency cycle. It exports no engine class, so it maps to no catalog engine and adds no
`catalog/unmapped-engine-package` finding.

## Option D needed none of its escape hatch

Every field of all sixteen domain types has an explicit column. There is **no `payload` blob and
no extension envelope** in Batch A. The structured sub-objects that exist — evidence files,
chains of custody, checklists, findings, conditions, standards, change impact — are `jsonb`
columns whose contents are validated by the aggregate's own schema, not open metadata.

## Three defects the activation found

Each would have surfaced in production on the first request, and each is now covered by a test
that fails without the fix.

### 1. Five tables forbade the transitions their engines perform

`202608030006` and `202608030007` put blanket `<table>_append_only` triggers on eleven tables.
For six that matches canonical behaviour exactly. For five it does not: evidence packages are
verified, defects move through IN_REWORK/RESOLVED/CLOSED, inspections record findings, acceptance
decisions are superseded, and certificates are revoked. The blanket trigger would have refused
every one of those.

The comment `202608090001` carried — that the triggers "already protect … which is the behaviour
these aggregates require" — was wrong about those five. Schema authority resolves the conflict in
the engine's favour (rank 5 beats rank 9), but not by abandoning immutability. The blanket
refusal is replaced by an explicit one:

- DELETE is refused on all sixteen tables;
- the columns that record what happened cannot change;
- `version` must advance, so two writers cannot both claim the same next version;
- a row in a terminal lifecycle state cannot be touched again.

Five more tables — `execution_workspaces`, `work_items`, `issue_records`,
`corrective_action_plans`, `change_requests` — had **no trigger at all** and permitted arbitrary
UPDATE and DELETE. They now carry the same governed boundary. All sixteen are covered: six by the
original append-only trigger, ten by a governed-transition and terminal-state pair.

### 2. Two unique constraints were global where the engine's rule is per workspace

`UNIQUE (certificate_number)` on `completion_certificates` was the serious one.
`CompletionCertificationEngine` numbers certificates per workspace, so `CERT-000001` is the first
certificate *in a workspace* — and the second workspace in any deployment would have failed to
issue its first certificate. `UNIQUE (milestone_id)` on `execution_workspaces` forbade two
tenants from ever executing against the same milestone identifier.

Both are now scoped to `(tenant_id, workspace_id, …)`. Two engine invariants that lived only in
application code became partial unique indexes, because both are cross-row properties a `CHECK`
cannot express:

- one `CERTIFIED` certificate per work item — the engine counts rows before issuing, which two
  concurrent requests both pass;
- one `ACTIVE` acceptance decision per work item.

### 3. A `DATE` column would have silently truncated an ISO datetime

`Inspection.scheduledFor` and `CorrectiveActionPlan.dueDate` are typed `string`, so an ISO
datetime typechecks; the `DATE` columns would accept one and discard the time. The schema requires
`YYYY-MM-DD` and refuses a datetime, which matches every canonical call site and satisfies the
authority document's "never silently coerce". Reads cast `::text` rather than rebuilding a
calendar date from a driver `Date`, which would mean choosing a zone to read it in.

## Where tenancy comes from

None of the sixteen domain types carries a `tenantId` — they carry `workspaceId` only, which was
sufficient while `workspaces` was the authority and is not now that `tenant_id NOT NULL REFERENCES
trust_tenants` is. The tenant is taken from the ambient trust scope, the same scope the policies
read, and a write with no scope is refused with `PERSISTENCE_SCOPE_INVALID` rather than left to
fail as a bare policy rejection. A record naming a workspace other than the caller's scope is
refused explicitly, because on a read path such a row is merely invisible, which reads as absence
rather than as a boundary violation.

## Two consequences worth stating plainly

**A trust runtime that serves Batch A runs in the `public` schema.** The sixteen tables are
created by `202608030006` and `202608030007`, which belong to the historical per-engine set, and
one of that set's functions is `SECURITY DEFINER` with `SET search_path=public` — so the set is
not schema-relocatable. Making those migrations required makes that a runtime contract rather than
an accident. The two integration suites that used a schema-isolated harness now use a whole
database with the full set applied; measured cost is about a second per database.

**Readiness now covers them.** `REQUIRED_STORE_TABLES` is the union of the trust tables and the
sixteen. A store that routes a collection to a table it does not require at startup discovers the
absence on the first write, having already told the caller the host was ready.

## What is not claimed

- **No optimistic concurrency at the application boundary.** `version` is maintained and the
  database requires it to advance, but `TrustPersistence.replace` takes a record and none of these
  records carries the version it was read at, so there is no expected value to predicate the
  UPDATE on. Two concurrent transitions both succeed and the later wins. Closing this needs a
  change to the persistence contract — a separate capability.
- **The conformance assertions are enforced by `pnpm typecheck`, not by `pnpm build`.**
  `apps/web/tsconfig.json` compiles with `strict: false`, and without `strictNullChecks` zod's
  `addQuestionMarks` treats every key as optional, so an identity assertion against a type with
  required fields resolves to `never`. The proofs therefore live in test files, which the
  application never imports and the root strict config does check.
- **Batches B, C and D are untouched.** So are Engines 41–60, the financial ledger work in
  `docs/finance/`, and `persistence.generic-record-retirement`.
- **`trust_records` is unchanged** and remains authoritative for the trust aggregates.

## Evidence

- 26 live-PostgreSQL tests in `wave4-batch-a-repository.postgres.test.ts`, covering round-trip
  through columns, tenancy from scope, cross-tenant invisibility, schema refusal at the boundary,
  redaction of failing values, unsupported schema version, permitted transitions, immutable facts,
  refused DELETE, non-advancing version, terminal state, append-only enforcement in both the store
  and the database, and each of the four uniqueness rules.
- `151` PostgreSQL tests overall, `680` default, `78` runtime, `repo:certify` 11/11,
  reconciliation findings unchanged at 15.
