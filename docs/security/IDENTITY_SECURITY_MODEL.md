# Identity Security Model

Sessions store SHA-256 token hashes only and are revocable. Suspended, locked, disabled, deleted, or unverified identities cannot authenticate. HTTP APIs return safe session metadata and set raw tokens only as `HttpOnly; Secure; SameSite=Lax` cookies. Authentication audit metadata filters token, password, OTP, and secret-like fields.

## Identity assertions

Identity assertions are short-lived HMAC-SHA256 statements (`v1.<claims>.<signature>`, default TTL two minutes) that carry the subject reference, session, workspace, tenant and assurance level authentication established. They carry **no roles, permissions or memberships**: authentication never implies authorization, so a consumer needing an authorization decision asks the permission engine rather than inferring one from a valid assertion.

Signing keys come from configuration as a keyring (`IDENTITY_ASSERTION_KEYS`, `IDENTITY_ASSERTION_ACTIVE_KEY_ID`) with a 32-character minimum. There is no default secret — an unconfigured deployment fails closed with `ASSERTION_KEYRING_REQUIRED` rather than signing with a known value. Each assertion records the `keyId` that signed it, so a key rotates by adding the new one, moving the active id, and retiring the old one once assertions signed with it have expired.

Signatures are compared in constant time after a length check. Every assertion carries a single-use nonce: `verifyIdentityAssertion` checks signature and validity window only, while `consumeIdentityAssertion` also burns the nonce through a replay guard and is the entry point for any path where an assertion authorises an action. The guard prunes on the verifier's clock, not wall-clock, because pruning on a separate clock could expire a nonce the verifier still considers live and silently re-admit a replay.

The audit trail records a non-reversible SHA-256 fingerprint of the assertion, never the assertion itself. `InMemoryTrustStore` does strip credential-shaped metadata keys, but the issuing service never hands it a token in the first place, so the trail cannot hold live credentials after a change to that filter.

## Identity gateway

`IdentityGateway` is the governed boundary that turns a transport request into a verified `RequestContext`. It composes the assertion primitive and owns no cryptography, token format, replay bookkeeping or key management.

Identity comes from a signed assertion carried in `x-assurapay-identity-assertion`. It is never read from request headers describing the caller. The previous `requestContext` implementation trusted `x-assurapay-user-id`, `x-assurapay-session-id`, `x-assurapay-tenant-id`, `x-assurapay-assurance` and `x-assurapay-memberships`, which let any caller claim any identity, tenant, assurance level and membership set on 146 routes. That path is removed.

Issuer and audience are signed and required on every verification, so an assertion minted for one component cannot be replayed at another. Tenant, workspace, session, purpose and assurance are checked as explicit expectations, and every comparison fails closed: an assertion that *omits* a bound field is rejected rather than accepted. Issuance copies approved identity fields from a typed `AuthenticatedPrincipal`; it never signs a caller-supplied claims object, so an unrecognised field cannot ride along.

`RequestContext.memberships` is always empty. A signature proving who someone is cannot also prove which workspaces they belong to, so membership must be resolved by the organizations and permission engines. `requireActiveWorkspace` therefore fails closed on a gateway-issued context until that authority has run.

Verification and consumption are distinct. `authenticate` verifies without burning the nonce and is safe on every request; `consumeRequestContext` burns it and is for paths that act. Replay state is an `AssertionReplayStore` whose single `consumeIfAbsent` operation is atomic — a `has`/`remember` pair is a race two concurrent requests can both win.

**Replay protection is process-local.** The bundled store declares `guarantee: 'process-local'`, and the gateway refuses it at construction when configuration requires distributed protection — which production does by default. A durable atomic store is required before multi-replica rollout; see the certification record.

Assertion exchange and attenuation are intentionally unsupported: the capability specification defines no attenuation rules, and an exchange surface without them transfers privilege under no constraint.

