# Agreement Intake API contract

Canonical authenticated routes for the three-path intake slice:

- `POST /api/v1/agreement-intakes` — create a DIRECT_DESCRIPTION, INFORMAL_ARTIFACT or FORMAL_DOCUMENT intake.
- `GET /api/v1/agreement-intakes/:id` — read workspace-scoped intake/readiness.
- `POST /api/v1/agreement-intakes/:id/clarifications/:clarificationId/resolve` — resolve one required gap.
- `POST /api/v1/agreement-intakes/:id/convert` — create/link the canonical Agreement only when READY_FOR_REVIEW.

Implementation MUST reuse the existing AssuraPay request-context, route-permission, trust-app, idempotency and error-mapping boundaries. Tenant/workspace/actor identity comes only from authenticated server context. Client-supplied authority fields are ignored/rejected. Artifact/document sources are secure references, never raw sensitive document persistence in the intake row. Conversion delegates to `AgreementIntakeConvergenceService` and the existing `ContractAuthoringEngine`.

HTTP acceptance: 401 unauthenticated; 403 unauthorized/cross-workspace; 404 hidden inaccessible aggregate; 409 lifecycle/idempotency conflict; 422 missing/ambiguous required terms. No route may activate, approve, certify or pay.
