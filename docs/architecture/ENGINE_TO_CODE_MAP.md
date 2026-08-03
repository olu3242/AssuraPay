# Engine to Code Map

| Engine | MVP status | Implementation location |
| --- | --- | --- |
| Identity and digital trust | Conditional implementation | `packages/identity`, auth APIs, identity/session migration |
| Organization and multi-tenant | Conditional implementation | `packages/organizations`, workspace APIs, tenancy/RLS migrations |
| Roles, permissions and governance | Conditional implementation | `packages/permissions`, permission API, governance migration |
| Party verification | Conditional implementation | `packages/parties`, party APIs, deterministic provider and migration |
| Legal governance | Conditional implementation | `packages/legal`, legal APIs and migration |
| Execution (06) | Implemented | `packages/governance-core` execution aggregate/history, execution APIs, governance-core migration |
| Milestone (07) | Implemented | `packages/governance-core` milestone DAG/critical path, milestone API, governance-core migration |
| Definition of Done (08) | Implemented | Immutable DoD versions/evaluations and DoD APIs in `packages/governance-core` |
| Certification (09) | Implemented | Human decisions/digital records and certification APIs in `packages/governance-core` |
| Payment Trigger (10) | Implemented | Governed authorization proposals and non-custodial orchestration contract in `packages/governance-core` |
| Contract Authoring (11) | Implemented | `packages/agreement-creation`, authoring APIs and agreement migration |
| Clause Intelligence (12) | Implemented | Published clause baselines, instances and explicit deviations |
| Negotiation (13) | Implemented | Participant-governed immutable proposal rounds |
| Approval Workflow (14) | Implemented | Version-pinned policies, authority, segregation and invalidation |
| Digital Execution (15) | Implemented | Exact-document packages, verified callbacks and execution certificates |
| AI Contract Analysis (16) | Implemented | Governed gateway and source-grounded immutable analysis runs |
| Contract Risk (17) | Implemented | Deterministic versioned risk assessments and validation |
| Contract Version (18) | Implemented | Immutable executed, amended and superseded versions |
| Contract Repository (19) | Implemented | Secure-store contract, classification-filtered search and legal hold |
| Agreement Intelligence (20) | Implemented | Human-reviewed source-grounded published structured versions |
| Audit and evidence ledger | Foundation only | Integrity-chained audit adapter and append-only PostgreSQL contract |
| Configuration engine | Contract only | Environment configuration and seed snapshot |
| Contract lifecycle | Implemented | Domain service and API routes |
| Blueprint and milestone | Implemented | Domain service and milestone read model |
| Definition of done | Implemented | Milestone DoD approval gate |
| Evidence management | Implemented | Evidence upload and completeness read model |
| Validation and acceptance | Implemented | Validation results and acceptance decisions |
| Completion certification | Implemented | Certificate issuance and verification |
| Payment eligibility | Implemented | Eligibility assessment from certificate |
