# Wave 4–5 domain-store durability — architecture decision

**Status: ACCEPTED.** The three decisions this document was waiting on were supplied by the
owner and are recorded in the companion specifications below. The assessment that produced this
document changed nothing: no aggregate was migrated, no table removed, no migration modified.
Implementation proceeds under `persistence.domain-store-durability`.

| Decision | Resolution | Specification |
|---|---|---|
| Monetary invariant set | fixed-scale integer minor units, ISO 4217, non-negative base amounts, signed effects only through explicit adjustment/reversal records, immutable posted values, tenant-scoped idempotency, exact reconciliation | `docs/finance/MONETARY_INVARIANTS.md` |
| Double-entry enforcement | transactionally enforced PostgreSQL posting procedure plus deferred balance validation; application checks supplementary, never authoritative | `docs/finance/DOUBLE_ENTRY_POSTING_MODEL.md` |
| Schema authority | canonical exported domain contracts and Zod schemas derived from engine semantics; the database enforces persistence invariants; `docs/DATA_SCHEMA.md` is supporting evidence, not automatically authoritative | `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` |

The recommendation below — Option D as the target, Option B in batches as the strategy, Option C
rejected on the evidence — is unchanged by these decisions and is now the accepted plan.

Evidence: `docs/certification/ENGINES_31_50_CERTIFICATION_GAP_MATRIX.md` and the three artifacts
under `artifacts/certification/`.

## The problem, stated precisely

All 35 wave 4–5 aggregates persist as unvalidated JSONB payloads in the generic `trust_records`
table. Purpose-built relational tables exist for all 35, carry the constraints the aggregates
need — `bigint` minor-unit money, foreign keys, unique constraints, an append-only trigger on
`ledger_entries` — and have **zero production readers or writers**.

The integrity machinery was built and attached to the wrong tables. Consequences, all measured:

1. The database enforces **no** money, balance, immutability, or linkage invariant for
   Engines 41–50. Double-entry integrity cannot be claimed.
2. A `trust_records` grant confers authority over all 35 collections at once. Per-aggregate
   authority is inexpressible.
3. `payload` is unvalidated. There are 0 Zod schemas repository-wide.
4. Reporting and reconciliation must read JSONB rather than columns.

**There is no dual write.** One live model, one dead model. That is the single most important
fact for sequencing: the migration does not need dual-write reconciliation.

## Options

### Option A — continue generic JSONB

*Advantages:* zero migration; one adapter; schema evolution is free.

*Lost guarantees:* every invariant in the table above. No balance enforcement, no money
constraint, no per-aggregate uniqueness, no immutability, no per-aggregate authority.

*Verdict:* **cannot meet the repository's own certification standard.** `financial-integrity`
and `relational-integrity` are unreachable by construction, and Engine 48 (Reconciliation &
Financial Ledger) cannot honestly be certified. Rejected as a target — though it stays valid for
genuinely polymorphic aggregates, see Option D.

### Option B — aggregate-specific relational repositories, wholesale replacement

*Advantages:* every constraint becomes real; per-aggregate RLS and authority; columnar reporting.

*Costs:* 35 repositories; 35 activations plus backfill; changes to every engine's store calls;
one very large cutover.

*Verdict:* right destination, wrong shape of step. A single cutover across 35 aggregates and 20
engines is the kind of change that cannot be reviewed or rolled back safely.

### Option C — governed dual write

*Verdict:* **rejected on the evidence.** Dual write exists to keep a live model and a second live
model in agreement during transition. Here the second model is dead — 0 readers, 0 writers, 0
rows. Introducing dual write would *create* a divergence risk that does not currently exist, add
an outbox and reconciliation burden, and require divergence detection for a table nobody reads.
It also contradicts the standing invariant that dual writes must be bounded and are never
permanent. The correct step is a one-way backfill with a read cutover.

### Option D — relational core plus JSONB extension envelope

Explicit columns for everything the database, RLS, reporting, or an invariant must see; a
narrowed `payload` for genuinely open extension.

*Explicit columns:* identity, tenant, workspace, principal, lifecycle status, version, timestamps,
every monetary amount as `bigint` minor units, currency, every foreign key, every natural
uniqueness key, every state a check constraint governs, every field a policy predicates on.

*JSONB retained for:* provider payload echoes, free-form findings and narrative, extensible
metadata, and evidence descriptors whose shape is genuinely provider-dependent — with a
`payload_version` column so an envelope change is detectable rather than silent.

*Verdict:* **recommended target.** It is what `trust_records` already gets right for the trust
aggregates (tenant, workspace, status and version are columns; only the remainder is payload),
applied per aggregate instead of once generically.

## Recommendation

- **Target architecture: Option D** — relational core plus a narrowed, versioned JSONB envelope,
  one table per aggregate, activating the existing purpose-built tables rather than creating new
  ones wherever their shape is adequate.
- **Migration strategy: Option B executed in batches, one-way, with a read cutover** — not
  Option C. No dual write, because there is no second live model to keep in step.

## Constraints the migration must satisfy

1. **No existing migration is modified.** Additive only. The 24 in `supabase/migrations` are
   immutable and checksum-verified by the runner.
2. **Order per aggregate:** add missing columns and constraints as `NOT VALID` → backfill from
   `trust_records` → `VALIDATE CONSTRAINT` → force RLS and grant the runtime role → switch reads
   → stop writes to the generic collection → retire the generic rows in a later, separate
   capability.
3. **RLS before application cutover**, never after. A table read by the application before its
   policies are forced is a table with no boundary, which is the defect
   `persistence.rls-certification` corrected.
4. **Backfill is idempotent and tenant-safe** — keyed on the aggregate's natural identity, run
   inside a tenant scope, restartable, and it must refuse rather than coerce a payload it cannot
   map. No silent discard; unmappable rows quarantine with evidence.
5. **Zero-loss rollback:** until the generic rows are retired they remain the fallback, so a read
   cutover is reversible by reverting the read source alone.
6. **Read-after-write** must hold across the cutover for a single request; the switch is per
   aggregate, inside one deployment, not per call site.
7. **Event and audit continuity:** `trust_audit_records` and the outbox are unchanged. Chain
   positions must not fork — the audit chain is per tenant and must stay so.
8. **No duplicate authoritative state:** once reads move, writes to the generic collection stop
   in the same change. A period where both are written is a dual write and is forbidden.
9. **`trust_records` is not removed.** It remains authoritative for the trust aggregates
   (Engines 01–05, 08) and for any wave 4–5 aggregate that stays generic under Option D.

## Proposed batches

Risk-ordered, not table-count-ordered. Financial aggregates come last because their invariants
must be explicit *before* they are enforced.

### Batch A — execution and evidence state · complexity **MEDIUM**

`executionWorkspaces`, `workItems`, `progressRecords`, `evidenceRequirements`,
`evidencePackages`, `validationTests`, `qualityPlans`, `qualityGateResults`, `defects`,
`inspections`, `issueRecords`, `correctiveActionPlans`, `changeRequests`, `changeApprovals`,
`acceptanceDecisions`, `completionCertificates`

Engines 31–40. No money. Entry gate: schema foundation complete. Exit gate: live PostgreSQL
tests per aggregate, forced RLS, cross-tenant denial proven. Rollback: revert read source.

### Batch B — entitlement and claim state · complexity **HIGH**

`paymentEligibilities`, `financialEntitlements`, `invoices`, `releaseRequests`,
`approvalThresholds`, `authorizationDecisions`, `financialApprovalDecisions`

Engines 41–43, 45–46. First money. Entry gate: Batch A certified **and** the monetary invariant
set ratified. Exit gate: money columns are `bigint` minor units with currency, non-negativity
enforced where the domain requires it, approval separation enforced.

### Batch C — settlement and money movement · complexity **VERY_HIGH**

`fundingCommitments`, `fundReservations`, `paymentInstructions`, `ledgerEntries`,
`reconciliationRecords`, `finalSettlementAccounts`, `financialClosureCertificates`

Engines 44, 47, 48, 50. Entry gate: Batch B certified **and** a decided double-entry enforcement
mechanism — constraint, deferred trigger, or transactional posting procedure. Exit gate: balance
enforced by the database, journal immutability enforced on the table actually written,
reconciliation uniqueness enforced, non-custody boundary re-certified.

### Batch D — dispute and remediation · complexity **MEDIUM**

`disputes`, `disputeEvidence`, `disputePositions`, `disputeDecisions`, `disputeHolds`

Engine 49. Depends on B and C for linkage targets. Exit gate: dispute-to-settlement FK integrity
and hold enforcement.

## Proposed implementation backlog

Identifiers only — **not registered**, because registration changes governed backlog state and
this is an assessment.

| Proposed capability | Purpose | Depends on | Explicit non-goals |
|---|---|---|---|
| `persistence.domain-schema-foundation` | Zod schemas for all 35 aggregates from `docs/DATA_SCHEMA.md` and existing exported types; runtime validation at the store boundary | — | no table changes, no migration |
| `persistence.wave4-relational-repositories` | Batch A columns, constraints, forced RLS, repositories | schema foundation | no backfill, no read cutover |
| `persistence.wave4-backfill` | idempotent, tenant-safe, restartable backfill with quarantine | wave4 repositories | no read cutover |
| `persistence.wave4-read-cutover` | switch reads and stop generic writes for Batch A | wave4 backfill | no generic-row deletion |
| `persistence.wave5-financial-integrity` | Batch B: money columns, currency, non-negativity, approval separation | wave4 read cutover | no ledger enforcement |
| `persistence.wave5-ledger-enforcement` | Batch C: database-enforced double entry and journal immutability | wave5 financial integrity | no reconciliation semantics |
| `persistence.wave5-reconciliation` | reconciliation uniqueness, provider-to-internal matching integrity | ledger enforcement | no dispute linkage |
| `persistence.wave5-dispute-linkage` | Batch D | wave5 reconciliation | — |
| `persistence.generic-record-retirement` | retire migrated generic collections under an emptiness guard, as `persistence.schema-ownership-reconciliation` did | all batches certified | never removes `trust_records` |

Sequencing rule: no batch begins before the prior batch's exit gate passes, and no financial
batch begins before its invariant set is explicit. **Engines 51–60 stay untouched until the
persistence boundary is resolved.**

## Decisions the repository cannot settle

1. **The monetary invariant set for Engines 41–50** — which amounts may be negative, the rounding
   policy, the supported currency list, and whether cross-currency settlement is in scope. Not
   derivable from code: today nothing enforces any of it.
2. **The double-entry enforcement mechanism** — check constraint on a balanced posting row,
   deferred constraint trigger across an entry group, or a transactional posting procedure. Each
   has different failure and performance behaviour.
3. **Whether `docs/DATA_SCHEMA.md` is the authority for the 35 schemas** or the existing exported
   types are. They must be reconciled deliberately; where they disagree the disagreement is
   recorded rather than silently resolved.
4. **Acceptance of this document.** It stays `PROPOSED` until governance accepts it.
