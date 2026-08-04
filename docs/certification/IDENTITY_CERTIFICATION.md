# Identity Certification

Unit-certified for hashed/revocable sessions, inactive-account denial, step-up and audit foundations. Durable provider-backed authentication remains conditional.

## Identity assertions

Unit-certified for signature integrity (tampered claims, swapped subject, truncated and padded signatures, foreign key, unknown key id), key rotation across a retired-but-held key, validity window including boundary and clock-skew tolerance, the assurance floor, single-use replay resistance, fail-closed configuration loading, and an audit trail that records a fingerprint rather than the assertion. 39 cases in `packages/identity/src/assertions.test.ts`; run with `pnpm certify:identity`.

Two properties are asserted directly rather than left to review: the claims contain no authorization data, and no metadata key handed to the store matches the credential-shaped pattern.

The in-process replay guard is correct within a single process only. A multi-instance deployment needs a shared guard; that is a persistence concern and is tracked separately.

## Identity gateway

Unit-certified for construction and fail-closed configuration, issuance from a typed authenticated principal, verification with issuer/audience/tenant/workspace/session/purpose/assurance binding, propagation of the assertion layer's malformed, expired, premature and unknown-key rejections, single-use consumption, identity-context projection, authorization separation, and sanitized audit evidence. 45 cases in `packages/identity/src/gateway.test.ts`; run with `pnpm certify:identity`.

Structural invariants asserted rather than reviewed: sixteen authorization-shaped names are absent from issuance input, encoded claims, verified claims and the resulting identity context; `memberships` is always empty; assurance cannot exceed what was signed; no exchange surface exists.

### Replay protection — not certified for distributed deployment

The gateway is certified **only with a process-local replay adapter**. `InMemoryAssertionReplayStore` declares `guarantee: 'process-local'` and is correct within a single process; it says nothing about other replicas.

Production rollout remains **blocked** on a durable atomic replay store. The gateway refuses a non-distributed store at construction whenever configuration requires distributed protection, and `loadGatewayConfig` sets that requirement in production unless a single-process deployment explicitly accepts the limitation via `IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY`. A multi-replica deployment therefore fails closed at startup rather than silently running with weaker guarantees.

The durable adapter cannot honestly be built in this capability: it requires the Postgres repository, which is `persistence.postgres-repository` — a capability that sits *downstream* of this one in the dependency graph. Implementing it here would invert the declared order.

