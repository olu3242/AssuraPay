# Monetary invariants

**Status: ACCEPTED AND ACTIVE.** Governs settlement-related persistence for canonical Engines 41–50 and the governed multi-currency/FX capability unless a stricter constitutional rule applies.

## Representation

| Rule | Enforcement |
|---|---|
| Amounts are integer minor units | `bigint` / TypeScript `bigint` |
| No binary floating point for canonical money | type and persistence boundary |
| Every amount carries an ISO 4217 currency code | governed currency registry plus database checks |
| Amount and currency validate together | money value object / schema constraints |
| Scale derives from the governed currency definition | never from caller input |
| Unsupported or ambiguous currency is rejected | fail closed |
| FX rates are exact | positive integer numerator/denominator; never binary floating point |

## Amount semantics

Base contractual, claim, invoice, entitlement, funding, release and payment amounts are non-negative.

A signed economic change is never a mutation of the original amount. Signed effects use an explicit record: adjustment, correction, reversal, refund, chargeback, write-off, or compensating entry.

Consequences:

- Original posted monetary facts are immutable.
- A correction preserves linkage to the fact it corrects.
- A reversal preserves linkage to the posting it reverses.
- A partial reversal is explicit and bounded by the remaining reversible amount.

## Currency consistency

- A journal transaction balances independently per currency.
- Amounts in different currencies are never summed into one balance without an explicit governed conversion event.
- Contract currency, funding/payment currency, settlement currency and reporting currency are distinct concepts and must not be silently conflated.
- Same-currency settlement uses the normal payment path and must not invoke an external FX operation.
- Cross-currency settlement requires an authorized settlement currency route before a payment instruction may be submitted.

## Governed FX

FX is an active canonical capability through `@assurapay/multi-currency` and the durable FX schema.

Every quote/conversion preserves at minimum:

- source currency and source amount;
- target currency and target amount;
- exact rate numerator and denominator;
- rate source;
- observation timestamp;
- quote expiry;
- rounding mode/result provenance;
- provider identity;
- acceptance and independent authorization where required;
- provider execution reference for confirmed conversion;
- tenant/workspace scope and idempotency identity.

An expired quote cannot be newly accepted. Acceptance and authorization are segregated. A provider instruction is not settlement evidence. Confirmation requires provider-originated evidence/reference according to the settlement execution boundary.

## Reporting currency

Reporting currency is a presentation/analytics policy. It never rewrites source contractual, ledger, payment or settlement facts.

Historical reporting must preserve the chosen rate policy, such as transaction date, settlement date, period end or period average. Recomputing history with today's rate is not an implicit default.

## Identity and idempotency

- Monetary commands require tenant-scoped idempotency keys.
- Uniqueness includes tenant/workspace and operation scope.
- Reusing an idempotency identity with a different semantic payload fails closed.
- A retried quote, payment, release, posting, conversion confirmation or reconciliation command creates no duplicate economic effect.

## Authority and segregation

Calculation, quote acceptance, FX authorization, release approval, payment execution, reconciliation and dispute resolution remain distinct authorities wherever the canonical engine model separates them.

The actor who accepts a governed FX quote does not thereby gain authority to authorize the same conversion when maker-checker separation is required.

**No change under this decision may weaken the non-custody boundary.** AssuraPay may calculate, record, govern, orchestrate, instruct and reconcile. It never holds, pools, converts as principal, or gains signing authority over end-user funds. Licensed financial/payment providers perform regulated money movement and FX execution.

## Finality and correction

- Posted ledger entries are immutable.
- Finalised settlement and conversion records are never edited destructively.
- Corrections use linked compensating records.
- Reconciliation outcomes are reproducible from persisted records.
- Every final monetary state is explainable through an auditable chain of source facts, quotes, authorizations, provider evidence and postings.

## Database enforcement

An invariant PostgreSQL can enforce must not exist only as an application check. At minimum:

integer representation · required currency · supported currency · amount bounds · positive exact-rate components · valid lifecycle states · tenant/workspace uniqueness · immutable final records · segregation-compatible state · quote expiry validity · foreign-key linkage · idempotency uniqueness · journal balancing · reconciliation uniqueness where canonical semantics permit.

## Multi-currency persistence

The governed FX capability persists:

- `fx_quotes`
- `fx_conversions`
- `provider_currency_capabilities`
- `reporting_currency_preferences`

Settlement-related tables continue to preserve their own currency-qualified monetary facts. Cross-currency settlement links those facts through an explicit FX quote/conversion rather than replacing or mutating the original denomination.

## Prohibited shortcuts

Storing canonical money as `numeric`, `real`, JavaScript `number`, or an untyped JSON number. Deriving currency scale from a caller. Mutating a posted amount. Silently converting currencies. Summing mixed currencies directly. Treating a reporting conversion as a source ledger fact. Reusing stale quotes. Hiding provider fees/spread inside an unexplained rate. Treating an AssuraPay instruction as proof that money moved. Reusing an idempotency identity across tenants. Granting one role incompatible proposal/authorization/release authority.