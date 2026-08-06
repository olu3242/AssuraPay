# Engines 31–50 — certification gap matrix

Assessment only. No production aggregate was migrated, no relational table removed, no generic
record deleted, no migration modified.

Canonical identity source: `docs/ENGINE_CATALOG.md`. Every engine below is named as the
catalogue names it. The noncanonical taxonomy circulated in earlier prompts is **not** used,
aliased, or reconciled here.

Generated evidence:

- `artifacts/certification/engines-31-50-inventory.json`
- `artifacts/certification/engines-31-50-gap-matrix.json`
- `artifacts/certification/engines-31-50-schema-readiness.json`

Regenerate with `node scripts/assessment/engines-31-50-inventory.mjs` and
`node scripts/assessment/schema-readiness.mjs`.

## The headline

Engines 31–50 are **implemented, wired, permission-covered and running on the certified
PostgreSQL trust path**. The defect is not missing engines or missing adapters.

The defect is that **all 35 wave 4–5 aggregates are stored as unvalidated JSONB payloads in the
generic `trust_records` table, while purpose-built relational tables for those same aggregates
exist with every constraint the aggregates need — and no production reader or writer.**

The integrity machinery was built. It is attached to the tables nothing uses.

## Canonical engines and where they live

| # | Canonical name | Package | Class |
|---|---|---|---|
| 31 | Execution Orchestration | `packages/execution-orchestration` | `ExecutionOrchestrationEngine` |
| 32 | Progress Measurement | `packages/execution-orchestration` | `ProgressMeasurementEngine` |
| 33 | Evidence Management | `packages/execution-orchestration` | `EvidenceManagementEngine` |
| 34 | Validation & Acceptance Testing | `packages/execution-orchestration` | `ValidationAcceptanceTestingEngine` |
| 35 | Quality Assurance | `packages/execution-orchestration` | `QualityAssuranceEngine` |
| 36 | Inspection & Field Verification | `packages/completion-assurance` | `InspectionEngine` |
| 37 | Issue, Risk & Corrective Action | `packages/completion-assurance` | `IssueRiskCorrectiveActionEngine` |
| 38 | Change Control | `packages/completion-assurance` | `ChangeControlEngine` |
| 39 | Acceptance & Decision | `packages/completion-assurance` | `AcceptanceDecisionEngine` |
| 40 | Completion Certification | `packages/completion-assurance` | `CompletionCertificationEngine` |
| 41 | Payment Eligibility | `packages/settlement-assurance` | `PaymentEligibilityEngine` |
| 42 | Financial Entitlement | `packages/settlement-assurance` | `FinancialEntitlementEngine` |
| 43 | Invoice & Claim Management | `packages/settlement-assurance` | `InvoiceClaimEngine` |
| 44 | Escrow & Funding Assurance | `packages/settlement-assurance` | `EscrowFundingAssuranceEngine` |
| 45 | Conditional Release Orchestration | `packages/settlement-assurance` | `ConditionalReleaseOrchestrationEngine` |
| 46 | Financial Approval & Authority | `packages/settlement-execution` | `FinancialApprovalAuthorityEngine` |
| 47 | Payment Execution & Treasury Integration | `packages/settlement-execution` | `PaymentExecutionEngine` |
| 48 | Reconciliation & Financial Ledger | `packages/settlement-execution` | `ReconciliationLedgerEngine` |
| 49 | Dispute, Claim & Appeal Resolution | `packages/settlement-execution` | `DisputeResolutionEngine` |
| 50 | Final Settlement & Financial Closure | `packages/settlement-execution` | `FinalSettlementEngine` |

Measured: 20/20 classes declared, 20/20 registered in `apps/web/lib/trust-app.ts`, 20/20 on
`TrustPersistence`, **0** using `FileAssuraStore`, **0** issuing raw SQL.

## Persistence topology, as it actually runs

```
Canonical Engine (31–50)
  → TrustPersistence                      (interface, asynchronous, 6 methods)
  → RuntimeTrustStore                      apps/web/lib/persistence.ts
  → PostgresTrustStore                     packages/database/src/postgres-store.ts
  → trust_records                          one table, 35 collections, JSONB payload
```

`trust_records` columns: `collection, record_id, tenant_id, workspace_id, principal_id, status,
effective_from, effective_to, revoked_at, version, payload, payload_digest, created_at,
updated_at`.

There is **no amount column, no currency column, no aggregate-specific foreign key, and no
aggregate-specific check or unique constraint.** Everything domain-specific lives inside
`payload`.

## Duplicate-model classification

All 35 collections, measured by the scanner:

| Classification | Count |
|---|---|
| `RELATIONAL_TABLE_DEAD` | **35** |
| `GENERIC_ONLY_VALID` | 0 |
| `DUAL_WRITE_PRESENT` | **0** |
| `DUAL_READ_PRESENT` | 0 |

Every one of the 35 has a purpose-built relational table created by a historical migration, and
none of those tables has a production reader or writer. **There is no dual write** — the
duplication is a live model and a dead model, not two competing live ones. That makes the
migration path safer than a dual-write reconciliation would be.

## What JSONB prevents the database from enforcing

The purpose-built tables carry the constraints; `trust_records` does not.

| Table (dead) | Checks | FKs | Unique | Append-only trigger | Money columns |
|---|---|---|---|---|---|
| `ledger_entries` | 2 | 2 | 0 | **yes** | `amount_minor bigint` |
| `payment_instructions` | 2 | 1 | 1 | – | `amount_minor bigint` |
| `financial_entitlements` | 3 | 2 | 0 | – | 6 × `*_amount_minor bigint` |
| `invoices` | 2 | 2 | 1 | – | `amount_minor bigint` |
| `reconciliation_records` | 0 | 2 | 0 | – | 2 × `*_amount_minor bigint` |
| `fund_reservations` | 2 | 3 | 0 | – | `reserved_amount_minor bigint` |
| `release_requests` | 3 | 4 | 0 | – | `requested_amount_minor bigint` |

Money is modelled correctly as `bigint` minor units — no floating point. `ledger_entries` even
carries an append-only trigger. **All of it is inert**, because the ledger entries the platform
actually writes go into `trust_records`, which has no such trigger and no amount column to
constrain.

## Financial integrity: application-enforced versus database-enforced

| Invariant | Database-enforced today |
|---|---|
| Currency precision | **No** — no currency column on the written table |
| Non-negative amounts | **No** — no amount column |
| Signed adjustment rules | **No** |
| Balanced debits and credits | **No** — no journal structure, no constraint, no posting procedure |
| Journal immutability | **No** — the append-only trigger is on the dead `ledger_entries` |
| Unique idempotency keys | Partly — `trust_idempotency_keys` exists, per-command coverage unverified |
| Payment-instruction uniqueness | **No** — the unique constraint is on the dead table |
| Reconciliation uniqueness | **No** |
| Reversal / dispute linkage | **No** — the FKs are on dead tables |
| Settlement finality | **No** — no immutability on the written row |
| Tenant-scoped financial identity | **Yes** — `trust_records` FORCE RLS, tenant + workspace policy |
| Release authorization separation | Application only |
| Approval authority | Application only |
| Escrow non-custody boundary | Application only, but covered by `settlement-*.non-custody.test.ts` |

**Double-entry integrity is not claimed and cannot be.** No constraint, deferred trigger, or
transactional posting procedure enforces balance on the table that receives the entries.

## RLS and isolation

Measured against a live database with all 24 migrations applied:

- `trust_records` — RLS enabled, **FORCE**, 1 policy set. Tenant and workspace scoped.
- The purpose-built tables for the same aggregates — RLS enabled, **not forced**, 1 policy each.
  They are among the 102 `ENABLE`-without-`FORCE` tables recorded in
  `docs/architecture/SCHEMA_OWNERSHIP.md`. Inert while dead; a hazard the moment anything writes
  them, because `ENABLE` does not constrain the table owner.

**One authority finding worth acting on.** A grant on `trust_records` is a grant over *all 35
collections at once* — evidence packages, ledger entries, disputes, completion certificates.
Purpose-built tables would allow a caller to be granted evidence access without ledger access;
the generic table cannot express that. Generic storage therefore confers **broader authority
than the per-aggregate model would**, and no policy can narrow it without a `collection`
predicate per grant.

## Certification gap matrix

30 layers × 20 engines = 600 assessments. Full detail in
`artifacts/certification/engines-31-50-gap-matrix.json`.

| Status | Count |
|---|---|
| `CERTIFIED` | 270 |
| `PARTIALLY_CERTIFIED` | 124 |
| `NOT_CERTIFIED` | 170 |
| `NOT_APPLICABLE` | 36 |
| `BLOCKED` | 0 |

Certified across all 20: canonical identity, package boundary, public contracts, runtime
registration, dependency declaration, authorization, route-permission mapping, tenant isolation,
workspace isolation, PostgreSQL durability, audit trail, integration coverage, end-to-end
coverage.

Not certified across all 20:

- **aggregate-schema-validation** — 0 Zod schemas; `payload` is unvalidated JSONB
- **relational-integrity** — no per-aggregate FK, unique or check constraint
- **live-postgresql-coverage** — **42 of 42** store instantiations in the 14 wave 4–5 test files
  use `InMemoryTrustStore`; there is no `*.postgres.test.ts` in any wave 4–5 package. The 39
  passing tests prove domain logic, not durability.
- **observability**, **error-taxonomy**, **retry-recovery** — no wave 4–5 coverage;
  `persistence.operational-resilience` is absent from the repository
- **event-consumption** — no consumer observed
- **financial-integrity** (41–50) — see above
- **production-readiness** — derived from the above

## Schema readiness

Exact, measured:

| Status | Count |
|---|---|
| `TYPE_EXISTS_SCHEMA_MISSING` | **35** |
| `SCHEMA_READY` | 0 |
| `TYPE_CONTAINS_ANY` | **0** |
| `TYPE_NOT_EXPORTED` | **0** |
| `DOMAIN_DEFINITION_MISSING` | **0** |
| `DOCUMENTATION_ONLY` | 0 |
| `CONFLICTING_DEFINITIONS` | 0 |

**All 35 aggregates have exported domain types containing no `any`.** Zod schemas: **0** in the
entire `packages` tree, against CLAUDE.md's statement that Zod schemas mirror
`docs/DATA_SCHEMA.md` as the source of truth.

This is materially better than the position for the `Snapshot` collections used by
`FileAssuraStore` (35/35 `any[]`, 5 with no exported type). Those are a **different set** and
belong to a different capability. An earlier report of mine conflated them; the numbers above are
the wave 4–5 truth.

The only missing input for a relational migration is runtime validation, not domain definition.
