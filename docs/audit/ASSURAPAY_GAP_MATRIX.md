# AssuraPay Maturity Matrix

This matrix replaces the original implemented/not-implemented gap framing. Detailed maturity stages and gates are defined in `docs/product/EXECUTION_ASSURANCE_MATURITY_MODEL.md`.

| Capability | Current maturity | Current evidence | Stage 2 maturity gate |
| --- | --- | --- | --- |
| Workspace and tenant model | Medium | Workspace and organization domain services and APIs | Authenticated tenant context and enforced isolation |
| Contract lifecycle | High | Creation, submission, approval, and tests | Production persistence, authorization, and audit |
| Blueprint, milestone, and DoD | High | Governed creation, approval, activation, and tests | Role-aware enterprise workflow and immutable versions |
| Evidence, validation, and acceptance | High | Hash checks, completeness, criteria results, authority gates | Durable evidence storage, chain of custody, and field security |
| Completion certification | High | Issuance, verification, revocation, and eligibility invalidation | Production certificate trust and immutable audit evidence |
| Payment eligibility | High | Certification-backed assessment and blocker API | Authorized, persisted enterprise policy evaluation |
| Settlement assurance | Medium | Entitlement, invoice, funding, release, instruction, and duplicate controls | Live provider states, reconciliation, returns, and reversals |
| Intelligence | Medium | Scores, KPIs, dashboards, projections, reports, and governed AI review | Production data lineage, role-aware analytics, and monitoring |
| UI and APIs | Medium | Demonstration pages and bounded API routes | Complete accessible, role-aware enterprise workflows |
| Financial-provider connectivity | Low | Provider-neutral identifiers and domain abstraction | Registry, certification, adapters, routing, and callbacks |
| Security and trust | Low | Domain constraints and documented permission model | Authentication, RBAC, ABAC, SoD, encryption, and policy audit |
| Operations | Low | Tests, typecheck, build, and CI foundation | Observability, retry, replay, dead letters, DR, and SLOs |
