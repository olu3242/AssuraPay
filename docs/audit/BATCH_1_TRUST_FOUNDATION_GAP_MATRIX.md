# Batch 1 Trust Foundation Gap Matrix

| Capability | Owning engine | Current implementation | Evidence | Gap | Required action | Test requirement | Certification status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Global identity and authentication | 01 | Missing | No identity package, session model, or auth routes | No revocable authentication context | Add identity domain/service, hashed sessions, devices, step-up, recovery, APIs and UI | Unit, integration, E2E | Not certified |
| Authentication audit | 01 | Placeholder | Governed AI records only | No append-only security audit | Add integrity-chained audit store and auth events | Tamper and secret-leak tests | Not certified |
| Workspace/organization CRUD | 02 | Partial | `AssuraPayService`, basic API routes | Client-supplied tenant/workspace IDs; no lifecycle or membership | Add workspace service, membership, invitations, active context and hierarchy | Cross-tenant and cycle tests | Not certified |
| Database tenant isolation | 02 | Missing | Initial migration has no Batch 1 RLS contract | Application checks alone | Add bounded migrations, RLS policies, indexes and SQL policy tests | Non-zero DB integration tests | Not certified |
| Roles and permissions | 03 | Missing | Documentation only | No deny-by-default evaluator, assignments, field security or explanation | Add permission service and request middleware | Deny/override/scope/field tests | Not certified |
| Delegation and authority | 03 | Missing | None | No limits, expiry, approval or segregation controls | Add immutable assignments, delegation, authority and SoD rules | Abuse and expiry tests | Not certified |
| Party registry | 04 | Missing | Supplier IDs are plain references in settlement records | No governed party lifecycle | Add party package and scoped repositories/APIs/UI | Tenant isolation tests | Not certified |
| Provider-neutral verification | 04 | Missing | None | No provider boundary, immutable result, expiry or manual review | Add interfaces and deterministic adapter | Result immutability/expiry tests | Not certified |
| Sensitive party data | 04 | Missing | Ordinary string references | No tokenization/masking contract | Tokenize references and serialize masked views | Leakage tests | Not certified |
| Versioned legal policies | 05 | Missing | None | No versions, assignments, exact acceptance or signature resolution | Add legal package/APIs/UI | Version/acceptance tests | Not certified |
| Consent and legal holds | 05 | Missing | None | No withdrawal history or lifecycle blocking | Add append-only consent and authority-controlled holds | Hold bypass and history tests | Not certified |
| Event outbox | Shared | Missing | Domain operations write directly to file store | No transactional event evidence | Add append-only versioned outbox abstraction and migration | Idempotency/persistence tests | Not certified |
| Test persistence isolation | Shared | Conflicting | Tests call persistent `FileAssuraStore.load()` | Unit runs dirty tracked seed file | Introduce isolated in-memory/test store behavior | Clean-worktree regression test | Not certified |
