# Agreement Three-Path Intake Certification

Certification target: `DIRECT_DESCRIPTION`, `INFORMAL_ARTIFACT`, and `FORMAL_DOCUMENT` must converge to the same readiness and canonical authoring boundary.

Automated domain coverage includes all three ready paths, missing-term blocking, provenance enforcement, conversion ordering and idempotent already-converted behavior.

Release gates still required before merge/deployment: repository unit suite; integration suite; migration/static checks; live PostgreSQL migration/RLS proof; Next.js production build; accessibility; browser E2E through authenticated API/UI; existing agreement activation/regression suite. A gate not executed in CI/live infrastructure is BLOCKED, never PASS by assertion.

Security invariants: workspace isolation; server-derived authority; source provenance; no autonomous acceptance/activation/payment; no raw sensitive document body in intake persistence; immutable provenance after conversion.

Status until CI/live gates execute: `THREE_PATH_INTAKE_IMPLEMENTED_AWAITING_FULL_CERTIFICATION`.
