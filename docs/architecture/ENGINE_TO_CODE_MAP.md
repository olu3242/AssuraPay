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
| Audit and evidence ledger | Foundation only | Integrity-chained audit adapter and append-only PostgreSQL contract |
| Configuration engine | Contract only | Environment configuration and seed snapshot |
| Contract lifecycle | Implemented | Domain service and API routes |
| Blueprint and milestone | Implemented | Domain service and milestone read model |
| Definition of done | Implemented | Milestone DoD approval gate |
| Evidence management | Implemented | Evidence upload and completeness read model |
| Validation and acceptance | Implemented | Validation results and acceptance decisions |
| Completion certification | Implemented | Certificate issuance and verification |
| Payment eligibility | Implemented | Eligibility assessment from certificate |
