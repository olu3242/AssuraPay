# Engine to Code Map

| Engine | MVP status | Implementation location |
| --- | --- | --- |
| Identity and digital trust | Partially implemented | Shared workspace and tenant context |
| Organization and multi-tenant | Implemented | Workspace and organization services |
| Roles, permissions and governance | Contract only | Permission model documented and enforced in service boundaries |
| Audit and evidence ledger | Partially implemented | Persistent store plus domain events represented via service state |
| Configuration engine | Contract only | Environment configuration and seed snapshot |
| Contract lifecycle | Implemented | Domain service and API routes |
| Blueprint and milestone | Implemented | Domain service and milestone read model |
| Definition of done | Implemented | Milestone DoD approval gate |
| Evidence management | Implemented | Evidence upload and completeness read model |
| Validation and acceptance | Implemented | Validation results and acceptance decisions |
| Completion certification | Implemented | Certificate issuance and verification |
| Payment eligibility | Implemented | Eligibility assessment from certificate |
