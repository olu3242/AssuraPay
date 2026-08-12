# Wave 5 Batch B activation

**Status: IMPLEMENTED.** Records what `persistence.domain-store-durability` did for Batch B —
the seven entitlement-and-claim aggregates of canonical Engines 41–43 and 45–46 — and what it
deliberately did not do.

Governed by `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md`,
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` and
`docs/finance/MONETARY_INVARIANTS.md`. Follows `docs/persistence/WAVE_4_BATCH_A_ACTIVATION.md`,
whose migration created the two trigger functions this one reuses.

Batch B is the first batch that carries money. That is the whole difference in character from
Batch A: the monetary invariants stop being a document engines are expected to honour and become
constraints a console session cannot evade.

## The batch boundary in the plan does not survive the schema

The accepted decision lists `fundReservations` and `fundingCommitments` in **Batch C**. The
foreign keys, computed against a live migrated instance rather than read off the plan, disagree:

| Key | Direction |
|---|---|
| `release_requests.fund_reservation_id → fund_reservations(id)` | Batch B depends on Batch C |
| `fund_reservations.invoice_id → invoices(id)` | Batch C depends on Batch B |
| `fund_reservations.funding_commitment_id → funding_commitments(id)` | and on one more |

`invoices` has an inbound key from a Batch C table and `release_requests` an outbound one.
Converting either side's identity from `UUID` to `TEXT` breaks the constraint on the other, so the
transitive closure of Batch B under foreign keys — **in both directions**, because a type change on
either end breaks the key — is exactly nine tables. There is no smaller convertible unit.

So `202608100002` converges all nine and **activates only seven**. `fund_reservations` and
`funding_commitments` are left in precisely the state `202608090001` left Batch A in: fit to
receive their aggregates, with no repository routing to them and no readiness requirement naming
them. Batch C activates them.

**Converging a table is not activating it.** The distinction is not a comment — it is executable,
so it cannot drift:

- `BATCH_B_CONVERGED_NOT_ACTIVATED` in `packages/domain-contracts/src/batch-b.ts` names the two;
- `REQUIRED_DOMAIN_AGGREGATE_TABLES` contains the seven and not those two, so readiness asserts
  only what the store actually depends on;
- a test asserts that no collection routes to either, and that readiness excludes both.

The safety argument for converting nine identity columns in place is that all nine hold zero rows.
That is re-verified at apply time, not assumed: the migration raises
`WAVE5_BATCH_B_AUTHORITY_REFUSED` naming the populated table and changes nothing. It refuses for a
second reason too — any inbound foreign key from a table *outside* the closure, which would mean
the closure was computed against a different schema than the one being migrated.

## What was delivered

| Piece | Where |
|---|---|
| 7 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-b.ts` |
| Money primitives: currency code, positive/signed minor units, approval count | `packages/domain-contracts/src/primitives.ts` |
| 7 compile-time conformance assertions | `packages/{settlement-assurance,settlement-execution}/src/persisted-contracts.test.ts` |
| 7 relational repositories | `packages/database/src/batch-b-repository.ts` |
| Store routing for all 7 collections | `packages/database/src/postgres-store.ts` |
| Tenancy, currency, non-negativity, segregation, mutation boundaries | `supabase/migrations/202608100002_wave5_batch_b_settlement_authority.sql` |
| Readiness requirement for the 7 tables | `packages/database/src/migrations.ts` |
| 25 live-PostgreSQL certification tests | `packages/database-testing/src/wave5-batch-b-repository.postgres.test.ts` |

As with Batch A there is **nothing to backfill**: `PostgresTrustStore` never routed these seven
collections anywhere, so every `append`, `replace` and `list` for a payment eligibility,
entitlement, invoice, release request or approval was refused with
`PERSISTENCE_COLLECTION_NOT_MAPPED`. Engines 41–46 could not persist to PostgreSQL at all. Routing
the collection to its table is the read cutover and the write cutover in one change, with no window
in which two models are authoritative.

## Six invariants that existed only in TypeScript, or not at all

Each is now enforced by the database, and each has a test that proves the refusal **through a
direct statement** rather than only through the store — because the point of moving an invariant
into PostgreSQL is that it holds for a caller the application does not mediate.

### 1. Tenancy

Nine tables were scoped on `workspace_id UUID REFERENCES workspaces(id)` — the deprecated
compatibility table — with no tenant column at all. They now reference `trust_tenants` and
`trust_workspaces`, with a composite key forcing the pair to agree, and FORCE row-level security
predicated on `trust_current_tenant()`/`trust_current_workspace()`. `ENABLE` alone does not
constrain the table owner; `FORCE` does.

### 2. Cross-tenant references

Every aggregate-to-aggregate key inside the closure is now tenant-composite:
`(tenant_id, parent_id) → (tenant_id, id)`. This closes a hole row-level security cannot:
**foreign key checks run as the table owner and are not subject to RLS**, so a single-column key
would have let a row in tenant A reference a parent in tenant B while the policy hid that parent
from the caller. Eight such keys were restored composite, and a ninth is new:
`authorization_decisions.release_request_id` had **no foreign key at all**, while the engine reads
the release request it names — so an authorization could be raised against a release request that
does not exist, in this tenant or any other.

### 3. Currency agreement between an aggregate and its claim

MONETARY_INVARIANTS: amounts in different currencies are never summed into one balance without an
explicit governed conversion event. An invoice claiming against an entitlement in another currency
is that unsummable case, and it was expressible only in application code. It is a property of two
rows, so it is a composite key rather than a `CHECK`:
`(tenant_id, financial_entitlement_id, currency) → (tenant_id, id, currency)`. Carrying currency in
the key means one constraint enforces tenant agreement and currency agreement together.

A composite key needs a **declared** `UNIQUE` on exactly the referenced columns — PostgreSQL will
not infer `(tenant_id, id, currency)` from a single-column primary key on `id`.

### 4. The governed currency set

`currency TEXT NOT NULL` accepted any string. NGN and USD are the only codes any canonical
behaviour uses, so those two are the governed set, named once in `SUPPORTED_CURRENCIES` and
asserted against the column's `CHECK` by a test. An unsupported code is refused rather than stored.

The schema uses `z.string().refine(…)` rather than `z.enum(['NGN','USD'])` deliberately: an enum
infers the union `'NGN' | 'USD'`, which is not *identical* to the domain type's `string`, and the
conformance proof would fail on a difference that is not a defect.

### 5. Deduction non-negativity, and arithmetic that follows from its parts

`financial_entitlements` checked its gross (`> 0`) and its net (`>= 0`) and left retention, tax and
penalty unconstrained — so a negative retention could inflate the net payable past the gross. All
three are now non-negative, and `financial_entitlements_net_follows_from_parts` requires
`net = gross + variations − retention − tax − penalty` in the column, not only in the schema.

`variations_amount_minor` stays **signed**. A variation may legitimately reduce an entitlement, and
MONETARY_INVARIANTS constrains base contractual, claim, invoice, entitlement, funding, release and
payment amounts — which a variation delta is not.

### 6. Segregation of duties

"The actor who proposes or calculates a monetary effect does not thereby gain authority to approve
or release it." `FinancialApprovalAuthorityEngine` raises `SEGREGATION_OF_DUTIES_VIOLATION` when
the approver is the requester; that refusal lived in TypeScript and a console session evaded it.
It compares an approval against the authorization it approves, so no `CHECK` and no single-record
schema can express it — `enforce_approval_segregation()` reads the authorization's `requested_by`
`FOR SHARE` and raises, or raises `APPROVAL_AUTHORIZATION_NOT_FOUND` if the authorization is
unreachable in the caller's tenant.

For the same reason segregation is **not** unit-tested in
`packages/settlement-execution/src/persisted-contracts.test.ts`. A cross-row invariant asserted only
in a unit test would be asserted in the one place it cannot hold.

## Mutation boundaries

Six of the nine are transitioned by their canonical engines; three never are. Three of the six
carried a blanket `<table>_append_only` trigger that would have refused the transitions their
engines perform — the same defect `202608100001` corrected for Batch A, corrected the same way and
with the functions that migration already created:

- `financial_entitlements` (terminal `CONFIRMED`), `invoices` (`APPROVED`/`REJECTED`),
  `release_requests` (`CANCELLED`), `authorization_decisions` (`AUTHORIZED`/`REJECTED`),
  `fund_reservations` (`RELEASED`/`CANCELLED`), `funding_commitments` (`CONFIRMED`/`CANCELLED`)
  carry a governed-transition and terminal-state pair. DELETE is refused, the columns recording
  what happened cannot change, `version` must advance, and a row in a terminal state cannot be
  touched again.
- `payment_eligibilities`, `approval_thresholds` and `financial_approval_decisions` keep their
  blanket append-only trigger, and the migration **asserts** it survived rather than assuming it —
  a future migration dropping one would leave a settlement aggregate with no mutation boundary, and
  the only symptom would be a write that quietly succeeded.

The blanket trigger is *replaced*, never supplemented: leaving it alongside the governed one would
refuse every transition and make the new rules unreachable.

Two more uniqueness rules became tenant-scoped, because both predate tenancy:
`invoices_workspace_number_unique` is now `(tenant_id, workspace_id, invoice_number)`, and
`financial_approval_decisions_one_per_approver_unique` prevents one approver counting twice toward
a threshold.

## Where tenancy comes from

Unchanged from Batch A, and for the same reason: none of the seven domain types carries a
`tenantId`. The tenant is taken from the ambient trust scope, the same scope the policies read; a
write with no scope is refused with `PERSISTENCE_SCOPE_INVALID` rather than left to fail as a bare
policy rejection; and a record naming a workspace other than the caller's is refused explicitly,
because on a read path such a row is merely invisible, which reads as absence rather than as a
boundary violation. `requireBatchATenant` was renamed `requireRelationalTenant` and now serves both
batches — one rule, not two copies of it.

## Money crosses the driver boundary as a string

postgres.js returns `bigint` and `numeric` as strings. The Batch B reader therefore converts
rather than casts, and refuses instead of rounding: a value that is not numeric, not finite, or not
a *safe* integer raises `PERSISTENCE_RECORD_CORRUPT` naming the column. Silently returning
`9007199254740993` as `9007199254740992` would be a rounding bug in a money field that no test
downstream could detect.

Exact round-trip is asserted against the columns (`::text`) as well as through the store, so a
rounding bug in the reader is visible, and a negative variation and the exact net it produces are
asserted separately.

## Deployment consequence

**A trust runtime that serves Batch B runs in the `public` schema**, for the reason already stated
for Batch A: the seven tables are created by `202608030008` and `202608030009`, which belong to the
historical per-engine set, and one of that set's functions is `SECURITY DEFINER` with
`SET search_path=public`, so the set is not schema-relocatable. Batch B adds no new constraint
beyond the one Batch A already made explicit.

## What is not claimed

- **No optimistic concurrency at the application boundary.** Unchanged from Batch A: `version` is
  maintained and the database requires it to advance, but `TrustPersistence.replace` takes a record
  and none of these records carries the version it was read at. Two concurrent transitions both
  succeed and the later wins. Closing this needs a change to the persistence contract.
- **`fund_reservations` and `funding_commitments` are converged, not activated.** No repository
  routes to them, readiness does not name them, and the two live-PostgreSQL seeds that need a
  reservation write those tables directly. Claiming Batch C from this work would be claiming a
  capability that has no reader and no writer.
- **No release path was changed.** This capability is persistence. `ReleaseRequest` gaining a
  durable home does not make any release certified-work-backed that was not already; the
  authority chain is enforced by Engines 45–47 exactly as before.
- **The conformance assertions are enforced by `pnpm typecheck`, not `pnpm build`** — same reason as
  Batch A: `apps/web/tsconfig.json` compiles with `strict: false`, and without `strictNullChecks`
  zod's `addQuestionMarks` treats every key as optional, so an identity assertion against a type
  with required fields resolves to `never`. The proofs live in test files the application never
  imports and the root strict config does check.
- **Batches C and D are untouched**, as are Engines 44 and 47–60, `docs/finance/`'s ledger work,
  and `persistence.generic-record-retirement`.
- **`trust_records` is unchanged** and remains authoritative for the trust aggregates.

## Evidence

- 25 live-PostgreSQL tests in `wave5-batch-b-repository.postgres.test.ts`: the
  activation/convergence distinction including the populated-closure refusal, TEXT identity and
  FORCE RLS on all nine, exact money round-trip through the columns, negative variations, tenancy
  from scope, cross-tenant invisibility, and direct-statement refusal of an unsupported currency, a
  negative deduction, arithmetic that does not follow from its parts, a cross-currency invoice, a
  cross-tenant parent reference, a self-approval, a duplicate approver, a cross-tenant
  authorization, a post-terminal change, an immutable amount change and a DELETE.
- 18 unit tests across the two engine packages, plus 7 compile-time conformance proofs.
