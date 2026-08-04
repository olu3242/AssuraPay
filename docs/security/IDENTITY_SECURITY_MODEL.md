# Identity Security Model

Sessions store SHA-256 token hashes only and are revocable. Suspended, locked, disabled, deleted, or unverified identities cannot authenticate. HTTP APIs return safe session metadata and set raw tokens only as `HttpOnly; Secure; SameSite=Lax` cookies. Authentication audit metadata filters token, password, OTP, and secret-like fields.

## Identity assertions

Identity assertions are short-lived HMAC-SHA256 statements (`v1.<claims>.<signature>`, default TTL two minutes) that carry the subject reference, session, workspace, tenant and assurance level authentication established. They carry **no roles, permissions or memberships**: authentication never implies authorization, so a consumer needing an authorization decision asks the permission engine rather than inferring one from a valid assertion.

Signing keys come from configuration as a keyring (`IDENTITY_ASSERTION_KEYS`, `IDENTITY_ASSERTION_ACTIVE_KEY_ID`) with a 32-character minimum. There is no default secret — an unconfigured deployment fails closed with `ASSERTION_KEYRING_REQUIRED` rather than signing with a known value. Each assertion records the `keyId` that signed it, so a key rotates by adding the new one, moving the active id, and retiring the old one once assertions signed with it have expired.

Signatures are compared in constant time after a length check. Every assertion carries a single-use nonce: `verifyIdentityAssertion` checks signature and validity window only, while `consumeIdentityAssertion` also burns the nonce through a replay guard and is the entry point for any path where an assertion authorises an action. The guard prunes on the verifier's clock, not wall-clock, because pruning on a separate clock could expire a nonce the verifier still considers live and silently re-admit a replay.

The audit trail records a non-reversible SHA-256 fingerprint of the assertion, never the assertion itself. `InMemoryTrustStore` does strip credential-shaped metadata keys, but the issuing service never hands it a token in the first place, so the trail cannot hold live credentials after a change to that filter.

