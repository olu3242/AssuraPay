# Identity Certification

Unit-certified for hashed/revocable sessions, inactive-account denial, step-up and audit foundations. Durable provider-backed authentication remains conditional.

## Identity assertions

Unit-certified for signature integrity (tampered claims, swapped subject, truncated and padded signatures, foreign key, unknown key id), key rotation across a retired-but-held key, validity window including boundary and clock-skew tolerance, the assurance floor, single-use replay resistance, fail-closed configuration loading, and an audit trail that records a fingerprint rather than the assertion. 39 cases in `packages/identity/src/assertions.test.ts`; run with `pnpm certify:identity`.

Two properties are asserted directly rather than left to review: the claims contain no authorization data, and no metadata key handed to the store matches the credential-shaped pattern.

The in-process replay guard is correct within a single process only. A multi-instance deployment needs a shared guard; that is a persistence concern and is tracked separately.

