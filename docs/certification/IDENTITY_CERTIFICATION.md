# Identity Certification

Unit-certified for hashed/revocable sessions, inactive-account denial, step-up and audit foundations. Durable provider-backed authentication remains conditional.

## Identity assertions

Unit-certified for signature integrity (tampered claims, swapped subject, truncated and padded signatures, foreign key, unknown key id), key rotation across a retired-but-held key, validity window including boundary and clock-skew tolerance, the assurance floor, single-use replay resistance, fail-closed configuration loading, and an audit trail that records a fingerprint rather than the assertion. 39 cases in `packages/identity/src/assertions.test.ts`; run with `pnpm certify:identity`.

Two properties are asserted directly rather than left to review: the claims contain no authorization data, and no metadata key handed to the store matches the credential-shaped pattern.

The in-process replay guard is correct within a single process only. A multi-instance deployment needs a shared guard, which it now has — see *Replay protection* below; the in-process guard remains the right adapter for a deployment with no database.

## Identity gateway

Unit-certified for construction and fail-closed configuration, issuance from a typed authenticated principal, verification with issuer/audience/tenant/workspace/session/purpose/assurance binding, propagation of the assertion layer's malformed, expired, premature and unknown-key rejections, single-use consumption, identity-context projection, authorization separation, and sanitized audit evidence. 45 cases in `packages/identity/src/gateway.test.ts`; run with `pnpm certify:identity`.

Structural invariants asserted rather than reviewed: sixteen authorization-shaped names are absent from issuance input, encoded claims, verified claims and the resulting identity context; `memberships` is always empty; assurance cannot exceed what was signed; no exchange surface exists.

### Replay protection — certified for distributed deployment

Two things were missing, and both are now closed.

**The control was unreachable.** The gateway always had `consumeRequestContext`, and this package's own tests always proved its refusal, but no HTTP route called it: `actingRequestContext` was exported with zero callers, so all 177 mapped routes authenticated through verify-without-consume and `ASSERTION_REPLAYED` could not be reached over HTTP. One assertion authorised unlimited actions inside its validity window. `authorizedContextForRoute` now consumes whenever the request method acts, after binding the trust scope — the audit record a consumption writes names the caller's tenant, and `trust_audit_records` refuses it when no scope is set. `e2e/browser-approvals-e2e.spec.ts` presents one assertion twice to an acting route and asserts the refusal by name.

**The guarantee was process-local.** `InMemoryAssertionReplayStore` is correct within one process and worth nothing across replicas, so with consumption live a load-balanced deployment would have admitted the same assertion once per instance.

`DurableAssertionReplayStore` (`apps/web/lib/assertion-replay.ts`) closes that over the shared `trust_assertion_nonces` table, added by `202608110026`. Uniqueness is the mechanism: `INSERT ... ON CONFLICT DO NOTHING RETURNING` resolves inside one statement, so of two concurrent callers presenting one nonce exactly one gets a row. It declares `guarantee: 'distributed'` because it is.

The earlier note here — that the durable adapter could not honestly be built in this capability, because it needs the Postgres repository which sits *downstream* in the dependency graph — was right, and determined where it went. It is not in `@assurapay/identity` and not in `@assurapay/database`; it is in the composition root, the one place that already holds both the `AssertionReplayStore` contract and a `SqlClient`, so neither package gained a dependency on the other. The runtime exposes its own pool rather than letting a caller build one, which `persistence-runtime.ts` already warned against: "a pool created in a request handler has no disposal path."

The store is chosen by adapter, not by fallback: a runtime without SQL *is* a non-durable deployment, because `loadPersistenceConfig` refuses an in-memory adapter for every durable class, and there `process-local` is the accurate guarantee rather than a downgrade. Choosing it needs the resolved runtime, which is why the gateway is now built asynchronously — a store that claimed `distributed` before knowing whether it had a database would be the exact misreport `ReplayProtectionGuarantee` exists to prevent.

`IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY` is no longer something a production deployment has to set. It stays as an escape hatch for a deployment that knowingly runs one process without a database, and `playwright.config.ts` deliberately leaves it unset so the browser suite is itself the proof: `NODE_ENV=production` makes distributed protection a requirement, and `IdentityGateway` refuses to construct against a store that does not provide it — so the 22 passing browser cases would fail at the gateway if the durable store were not wired.

Certified by 8 cases in `apps/web/lib/assertion-replay.postgres.test.ts` against real PostgreSQL, including two independent stores standing in for two replicas, and two concurrent callers of which exactly one may win. A check-then-insert implementation passes the sequential cases and fails that one, which is why it is there.

