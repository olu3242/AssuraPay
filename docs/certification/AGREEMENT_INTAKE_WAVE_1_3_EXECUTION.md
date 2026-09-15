# Agreement Intake — Waves 1–3 executable handoff

## Wave 1: clean convergence
Use current `main` as the only base. Create `feat/agreement-intake-e2e-v2`. Port only the eight production/test/migration files listed in `AGREEMENT_INTAKE_CLEAN_CONVERGENCE_REQUIRED.md`. Preserve current-main versions of every unrelated file. The old PR #49 remains evidence/source only.

## Wave 2: domain completion
Wire `AgreementIntakeConvergenceService` to the existing canonical `ContractAuthoringEngine` through an adapter rather than a second aggregate. Conversion contract:
1. load workspace-scoped intake server-side;
2. require `READY_FOR_REVIEW`;
3. create canonical agreement with deterministic idempotency key `agreement-intake:<intakeId>`;
4. persist provenance (`intakeId`, sourceType, sourceHash, artifact ids, correlation id) in audit/event metadata;
5. only after authoring succeeds mark intake `CONVERTED` with canonical agreement id;
6. retries return the existing canonical agreement;
7. failure leaves intake unconverted.

AI/extraction remains proposal-only. No AI path may accept, sign, activate, approve completion, waive evidence, or release payment.

## Wave 3: production persistence and governed API
Implement the repository/persistence adapter against the existing database abstraction; do not create an alternate DB client. Apply the two intake migrations and certify RLS using two tenants/workspaces.

Expose authenticated canonical routes:
- `POST /api/v1/agreement-intakes`
- `GET /api/v1/agreement-intakes/[id]`
- `POST /api/v1/agreement-intakes/[id]/clarifications/[clarificationId]`
- `POST /api/v1/agreement-intakes/[id]/convert`

Route requirements:
- derive tenant/workspace/actor from authenticated RequestContext;
- reuse existing route permission/error/idempotency conventions;
- reject client authority fields;
- artifact/formal paths use secure stored artifact references, not raw persistent document bodies;
- conversion calls the Wave-2 convergence service;
- cross-workspace reads/writes return not-found/denied without leaking existence;
- audit create, clarification resolution and conversion.

## Required tests before Wave 4
- all three source types reach `READY_FOR_REVIEW` when complete;
- incomplete direct description cannot convert;
- artifact/document terms without provenance fail;
- clarification resolution advances readiness deterministically;
- canonical authoring failure does not mark converted;
- duplicate conversion is idempotent;
- cross-workspace access denied;
- RLS tenant/workspace isolation proven in live PostgreSQL;
- package tests, typecheck and production build pass.

Status may become `WAVES_1_3_COMPLETE` only when these runtime tests execute successfully. Documentation or mocks alone are insufficient.
