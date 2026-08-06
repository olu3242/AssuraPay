# Monetary invariants

**Status: ACCEPTED.** Owner decision, recorded for
`docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md`. Governs settlement-related
persistence for canonical Engines 41–50 unless a stricter constitutional rule applies.

Nothing here is implemented yet. Wave 5 financial migration is deferred; this exists so that when
it starts, the invariants are decided rather than discovered. Recording them now is what unblocks
the Wave 4 batch from having to guess at a financial boundary it does not cross.

## Why this document exists

`docs/certification/ENGINES_31_50_CERTIFICATION_GAP_MATRIX.md` measured that the database
currently enforces **no** monetary invariant for Engines 41–50. Amounts live inside a JSONB
payload on `trust_records`, which has no amount column, no currency column, and no constraint.
Every rule below is therefore a rule to be *established*, not one to be preserved.

## Representation

| Rule | Enforcement |
|---|---|
| Amounts are integer minor units | column type `bigint` |
| No binary floating point, anywhere | column type; `numeric` also rejected for amounts |
| Every amount carries an ISO 4217 currency code | `NOT NULL` currency column, `CHECK` against the governed list |
| Amount and currency validate together | composite check; a row cannot hold one without the other |
| Scale derives from the governed currency definition | never from caller input |
| Unsupported or ambiguous currency is rejected | `CHECK` on the supported set |

## Amount semantics

Base contractual, claim, invoice, entitlement, funding, release and payment amounts are
**non-negative** — `CHECK (amount_minor >= 0)`.

A signed economic change is never a mutation of the original amount. Signed effects use an
explicit record: adjustment, correction, reversal, refund, chargeback, write-off, or compensating
entry. Consequences:

- Original posted monetary facts are **immutable**.
- A correction preserves a foreign key to the fact it corrects.
- A reversal preserves a foreign key to the posting it reverses.
- A partial reversal is explicit and **bounded by the remaining reversible amount** — enforced,
  not merely checked in the application, because the bound depends on other rows.

## Currency consistency

- A journal transaction balances **independently per currency**.
- Amounts in different currencies are never summed into one balance without an explicit governed
  conversion event.
- FX is **out of scope** unless active canonical behaviour already requires it. Where a conversion
  is recorded it must carry: source currency, source amount, target currency, target amount, rate,
  rate source, rate timestamp, rounding result, and the actor or system authority.

## Identity and idempotency

- Monetary commands require **tenant-scoped** idempotency keys.
- Uniqueness includes tenant and operation scope — a unique index on
  `(tenant_id, operation, idempotency_key)`, not on the key alone.
- Reusing a key with a different semantic payload **fails**. This needs a stored payload digest to
  compare against; a key alone cannot detect it.
- A retried payment, release, posting, or reconciliation command creates **no duplicate economic
  effect**.

## Authority and segregation

Calculation, approval, authorization, release, execution, reconciliation and dispute resolution
remain distinct authorities wherever the canonical engine model separates them. The actor who
proposes or calculates a monetary effect does **not** thereby gain authority to approve or release
it.

**No change under this decision may weaken the non-custody boundary.** AssuraPay instructs a
licensed provider; it never holds, pools, or gains signing authority over end-user funds. The
existing `settlement-*.non-custody.test.ts` suites remain the gate.

## Finality and correction

- Posted ledger entries are immutable.
- Finalised settlement records are never edited destructively.
- Corrections use linked compensating records.
- Reconciliation outcomes are reproducible from persisted records.
- Every final monetary state is explainable through an auditable chain of source facts and
  postings.

## What the database must enforce

An invariant that PostgreSQL can enforce must not exist only as an application check. At minimum:

integer representation · required currency · amount bounds · valid state values · tenant-scoped
uniqueness · foreign-key linkage · immutable posted records · reversal linkage · idempotency
uniqueness · journal balancing · reconciliation uniqueness where canonical semantics permit.

## Affected tables

From the gap matrix, the tables that will need work when Wave 5 starts. All already type money as
`bigint` minor units — the representation rule is satisfied on the *dead* tables and must survive
activation.

| Table | Money columns | Missing today |
|---|---|---|
| `ledger_entries` | `amount_minor` | currency column, balance enforcement, live writers |
| `payment_instructions` | `amount_minor` | live writers |
| `financial_entitlements` | 6 × `*_amount_minor` | live writers |
| `invoices` | `amount_minor` | live writers |
| `reconciliation_records` | 2 × `*_amount_minor` | uniqueness, live writers |
| `fund_reservations` | `reserved_amount_minor` | live writers |
| `release_requests` | `requested_amount_minor` | live writers |

## Prohibited shortcuts

Storing an amount as `numeric`, `real`, or a JSON number. Deriving scale from a caller. Mutating a
posted amount. Representing a refund by negating an original. Enforcing balance only in
TypeScript. Reusing an idempotency key across tenants. Granting one role both proposal and release
authority.
