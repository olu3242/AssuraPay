# AssuraPay Multi-Currency Architecture

## Status

Implementation branch: `feat/multi-currency-governed-fx`.

The capability extends AssuraPay's existing exact-money and non-custodial settlement architecture. It does not introduce customer balances, pooled funds, signing authority, or an AssuraPay-operated FX dealing account.

## Canonical concepts

Four currencies are deliberately distinct:

1. **Contract currency** — denomination of the commercial obligation.
2. **Funding/payment currency** — currency supplied by the payer or funding institution.
3. **Settlement currency** — currency the beneficiary receives.
4. **Reporting currency** — analytics/display denomination only.

They may be identical. When they differ, the relationship must be represented by an explicit governed conversion event. Mixed currencies are never summed directly.

## Exact money

`@assurapay/multi-currency` is the canonical currency/FX domain package.

Money is `{ amountMinor: bigint, currency: CurrencyCode }`.

The currency registry owns minor-unit exponent and support status. Callers cannot choose scale. Canonical monetary calculations never use JavaScript floating point.

Initial governed set:

| Currency | Exponent |
|---|---:|
| USD | 2 |
| CAD | 2 |
| GBP | 2 |
| EUR | 2 |
| NGN | 2 |
| GHS | 2 |
| KES | 2 |
| ZAR | 2 |
| JPY | 0 |
| BHD | 3 |

The architecture can expand to the wider ISO 4217 registry without changing the Money contract.

## Exact FX rates

An FX rate is a positive rational number:

`{ numerator: bigint, denominator: bigint }`

This representation keeps the conversion deterministic and auditable without binary floating point. Rounding is explicit (`HALF_UP` or `DOWN`) and occurs at the target minor-unit boundary.

## Quote lifecycle

`QUOTED -> ACCEPTED -> AUTHORIZED`

Terminal/refusal states include `EXPIRED` and `REJECTED`.

Acceptance after quote expiry does not proceed. Acceptance and authorization are maker-checker separated by the domain engine. Final quote states are protected from destructive mutation in PostgreSQL.

## Conversion lifecycle

`INSTRUCTED -> CONFIRMED`

Unhappy-path terminal states include `FAILED` and `REVERSED`.

`INSTRUCTED` means AssuraPay has created/orchestrated an instruction to the external provider. It does not mean the money moved. `CONFIRMED` requires provider evidence/reference and remains subject to the existing settlement reconciliation rules.

## Provider capability routing

Provider selection is constrained by:

- source currency;
- destination currency;
- supported pair;
- settlement rail;
- FX capability;
- quote capability.

The current router is deterministic: among capable providers it sorts by provider id. Commercial ranking by price, SLA, jurisdiction, risk and relationship policy belongs in the provider-policy layer and must remain explainable.

## Persistence

Migration `202609070001_multi_currency_governed_fx.sql` adds:

- `fx_quotes`
- `fx_conversions`
- `provider_currency_capabilities`
- `reporting_currency_preferences`

All tables are tenant/workspace scoped with forced RLS. Exact rate components are positive bigint values. Base amounts are non-negative bigint minor units. The database enforces quote expiry ordering, same-currency identity rate, maker-checker separation, final-state immutability and tenant/workspace idempotency.

## Flow Orchestration OS

The canonical commercial flow now includes a domain-event gate:

`Release approved -> SettlementCurrencyRouteAuthorized -> PaymentInstructionSubmitted`

The Flow OS does not calculate or authorize FX itself. A settlement-domain capability emits `SettlementCurrencyRouteAuthorized` after either:

- **same currency** — policy has proved FX is not required; or
- **cross currency** — required quote, acceptance, authorization and provider route are complete.

This keeps the Flow OS as coordinator rather than a second financial source of truth.

## Ledger invariant

Every journal balances independently by currency. A USD debit and NGN credit are never presented as a balanced journal transaction. An FX conversion links currency-specific facts through the explicit quote/conversion record.

## Reporting currency

Reporting conversion never mutates source financial facts. Historical reporting must preserve the selected rate policy and rate provenance.

## Non-custody boundary

AssuraPay may validate money, request/record a provider quote, enforce policy, collect governed approval, send an authorized instruction and reconcile provider evidence.

AssuraPay does not hold, pool or convert customer funds as principal. Licensed providers execute regulated money movement and FX activity.

## Remaining convergence work before certification

The core domain, persistence and Flow OS gate are implemented on this branch. Certification still requires wiring the capability into existing release/payment/reconciliation repositories and governed HTTP routes, provider adapters, browser conversion review UX, PostgreSQL migration execution and the full non-custody/security/browser gates.
