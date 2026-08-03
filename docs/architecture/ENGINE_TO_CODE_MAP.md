# Engine to Code Map

| Engine | MVP status | Implementation location |
| --- | --- | --- |
| Identity and digital trust | Conditional implementation | `packages/identity`, auth APIs, identity/session migration |
| Organization and multi-tenant | Conditional implementation | `packages/organizations`, workspace APIs, tenancy/RLS migrations |
| Roles, permissions and governance | Conditional implementation | `packages/permissions`, permission API, governance migration |
| Party verification | Conditional implementation | `packages/parties`, party APIs, deterministic provider and migration |
| Legal governance | Conditional implementation | `packages/legal`, legal APIs and migration |
| Audit and evidence ledger | Foundation only | Integrity-chained audit adapter and append-only PostgreSQL contract |
| Configuration engine | Contract only | Environment configuration and seed snapshot |
| Contract lifecycle | Implemented | Domain service and API routes |
| Blueprint and milestone | Implemented | Domain service and milestone read model |
| Definition of done | Implemented | Milestone DoD approval gate |
| Evidence management | Implemented | Evidence upload and completeness read model |
| Validation and acceptance | Implemented | Validation results and acceptance decisions |
| Completion certification | Implemented | Certificate issuance and verification |
| Payment eligibility | Implemented | Eligibility assessment from certificate |
