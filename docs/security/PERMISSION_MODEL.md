# Permission Model

The initial foundation focuses on a simple authorization boundary around workspace, contract, milestone, evidence, validation, acceptance, certificate, and payment eligibility operations.

The service layer enforces domain-state gates before allowing state transitions such as activation, certification, and eligibility assessment. Future batches should extend this to role-based and object-scoped permission checks.

## Enforcement

`enforcePermission` is applied at the composition root, never inside an engine. An engine receives an already-authorized context and does not decide whether the caller may act.

It is the counterpart to the identity gateway. The gateway proves who the caller is and deliberately emits an empty `RequestContext.memberships`; enforcement resolves membership from the authoritative `memberships` record and evaluates permission, so authorization is established by data rather than asserted by a signature.

Order of checks, each failing closed: authenticated caller → workspace and tenant present in context → active membership in that workspace proven by the record → permission granted, deny-by-default → no blocking segregation-of-duties conflict. The permission authority is consulted only after membership passes, so a non-member never reaches policy evaluation.

Any membership list on the incoming context is **discarded, never merged**. The gateway supplies none, but a hand-constructed context could, and trusting it would reintroduce the header-trust bypass the gateway removed. Membership is read, never accepted.

`packages/permissions` is a trust-foundation package and may not import `@assurapay/organizations`, so `TrustStoreMembershipReader` reads the shared `memberships` collection through `TrustPersistence` behind a `WorkspaceMembershipReader` interface. A durable implementation can replace it without touching enforcement.

Enforcement adds nothing to the context but resolved memberships: no roles, permissions, grants, scopes, policies, entitlements or capabilities, and it never elevates assurance. Assertion claims are not extended to carry authorization data.

