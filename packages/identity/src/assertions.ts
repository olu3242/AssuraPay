import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AssuranceLevel, TrustPersistence } from '@assurapay/shared';

/**
 * Engine 01 — HMAC identity assertions.
 *
 * An assertion is a short-lived, signed statement that a subject authenticated
 * and holds a session, carrying the workspace context and assurance level that
 * authentication established.
 *
 * It deliberately carries **no roles, permissions or memberships**. CLAUDE.md:
 * authentication never implies authorization. A consumer that needs an
 * authorization decision asks the permission engine; it may not infer one from a
 * valid assertion.
 */

const ASSERTION_VERSION = 'v1';

/** Rejects secrets short enough to brute-force offline. */
const MINIMUM_SECRET_LENGTH = 32;

const DEFAULT_TTL_MS = 120_000;

/** Ordered weakest to strongest, for minimum-assurance comparisons. */
const ASSURANCE_ORDER: AssuranceLevel[] = [
  'IAL0_UNVERIFIED',
  'IAL1_BASIC',
  'IAL2_VERIFIED',
  'IAL3_HIGH_ASSURANCE',
];

export type IdentityAssertionErrorCode =
  | 'ASSERTION_MALFORMED'
  | 'ASSERTION_UNSUPPORTED_VERSION'
  | 'ASSERTION_UNKNOWN_KEY'
  | 'ASSERTION_SIGNATURE_INVALID'
  | 'ASSERTION_EXPIRED'
  | 'ASSERTION_NOT_YET_VALID'
  | 'ASSERTION_REPLAYED'
  | 'ASSERTION_ASSURANCE_INSUFFICIENT'
  | 'ASSERTION_SUBJECT_REQUIRED'
  | 'ASSERTION_SESSION_REQUIRED'
  | 'ASSERTION_KEYRING_REQUIRED'
  | 'ASSERTION_SECRET_TOO_WEAK'
  | 'ASSERTION_ACTIVE_KEY_UNKNOWN';

/**
 * Failures carry a stable code, never a formatted sentence, so callers and logs
 * can branch on them. Detail is attached separately and is safe to log: it never
 * contains a token, a secret or a signature.
 */
export class IdentityAssertionError extends Error {
  readonly code: IdentityAssertionErrorCode;
  readonly detail?: string;

  constructor(code: IdentityAssertionErrorCode, detail?: string) {
    super(code);
    this.name = 'IdentityAssertionError';
    this.code = code;
    this.detail = detail;
  }
}

/** Claims an assertion asserts. Authorization data is intentionally absent. */
export type IdentityAssertionClaims = {
  /** Tenant-neutral subject reference — never an email or other identifier. */
  subject: string;
  sessionId: string;
  identityAssuranceLevel: AssuranceLevel;
  workspaceId?: string;
  tenantId?: string;
  /** Single-use value; the replay guard consumes it. */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** Which keyring entry signed this, so keys can rotate without downtime. */
  keyId: string;
};

/**
 * A signing keyring rather than a single secret, so a key can be rotated by
 * adding the new one, moving `activeKeyId`, and retiring the old one once every
 * assertion signed with it has expired.
 */
export type AssertionKeyring = {
  activeKeyId: string;
  keys: Record<string, string>;
};

export type CreateAssertionInput = {
  subject: string;
  sessionId: string;
  identityAssuranceLevel: AssuranceLevel;
  workspaceId?: string;
  tenantId?: string;
  ttlMs?: number;
  /** Injected for deterministic tests. */
  now?: Date;
  nonce?: string;
};

export type VerifyAssertionOptions = {
  now?: Date;
  /** Absorbs clock skew between issuer and verifier. */
  clockToleranceMs?: number;
  /** Rejects an assertion weaker than this level. */
  minimumAssuranceLevel?: AssuranceLevel;
};

function base64UrlEncode(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64');
}

/**
 * Serialises claims with sorted keys and omitted optionals.
 *
 * The signature covers these exact bytes, so issuer and verifier must agree on
 * them regardless of the order the claims object was built in.
 */
function canonicalise(claims: IdentityAssertionClaims): string {
  const source = claims as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    ordered[key] = source[key];
  }
  return JSON.stringify(ordered);
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(payload).digest());
}

function resolveSecret(keyring: AssertionKeyring, keyId: string): string {
  const secret = keyring.keys[keyId];
  if (!secret) {
    throw new IdentityAssertionError('ASSERTION_UNKNOWN_KEY', `keyId=${keyId}`);
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new IdentityAssertionError(
      'ASSERTION_SECRET_TOO_WEAK',
      `keyId=${keyId} requires at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

/**
 * Non-reversible reference to a token, for audit correlation. A SHA-256 prefix
 * over a token containing a random nonce cannot be reversed or guessed.
 */
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function assuranceAtLeast(
  actual: AssuranceLevel,
  minimum: AssuranceLevel,
): boolean {
  return ASSURANCE_ORDER.indexOf(actual) >= ASSURANCE_ORDER.indexOf(minimum);
}

/** Issues a signed assertion. Never logs or returns the signing secret. */
export function createIdentityAssertion(
  input: CreateAssertionInput,
  keyring: AssertionKeyring,
): { token: string; claims: IdentityAssertionClaims } {
  if (!input.subject?.trim()) {
    throw new IdentityAssertionError('ASSERTION_SUBJECT_REQUIRED');
  }
  if (!input.sessionId?.trim()) {
    throw new IdentityAssertionError('ASSERTION_SESSION_REQUIRED');
  }
  if (!keyring?.activeKeyId) {
    throw new IdentityAssertionError('ASSERTION_KEYRING_REQUIRED');
  }

  const secret = resolveSecret(keyring, keyring.activeKeyId);
  const issuedAt = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

  const claims: IdentityAssertionClaims = {
    subject: input.subject.trim(),
    sessionId: input.sessionId.trim(),
    identityAssuranceLevel: input.identityAssuranceLevel,
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    nonce: input.nonce ?? randomUUID(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    keyId: keyring.activeKeyId,
  };

  const payload = base64UrlEncode(Buffer.from(canonicalise(claims), 'utf8'));
  return {
    token: `${ASSERTION_VERSION}.${payload}.${sign(payload, secret)}`,
    claims,
  };
}

/**
 * Verifies signature and validity window and returns the claims.
 *
 * This does **not** check replay — a nonce can only be consumed once, which
 * requires state. Use `consumeIdentityAssertion` on any path where an assertion
 * authorises an action; this function is for inspection.
 */
export function verifyIdentityAssertion(
  token: string,
  keyring: AssertionKeyring,
  options: VerifyAssertionOptions = {},
): IdentityAssertionClaims {
  if (!keyring?.keys) {
    throw new IdentityAssertionError('ASSERTION_KEYRING_REQUIRED');
  }

  const segments = (token ?? '').split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new IdentityAssertionError('ASSERTION_MALFORMED', 'expected three segments');
  }

  const [version, payload, signature] = segments;
  if (version !== ASSERTION_VERSION) {
    throw new IdentityAssertionError('ASSERTION_UNSUPPORTED_VERSION', version);
  }

  let claims: IdentityAssertionClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString('utf8')) as IdentityAssertionClaims;
  } catch {
    throw new IdentityAssertionError('ASSERTION_MALFORMED', 'payload is not JSON');
  }

  if (
    typeof claims?.keyId !== 'string' ||
    typeof claims?.subject !== 'string' ||
    typeof claims?.nonce !== 'string' ||
    typeof claims?.expiresAt !== 'string' ||
    typeof claims?.issuedAt !== 'string'
  ) {
    throw new IdentityAssertionError('ASSERTION_MALFORMED', 'claims are incomplete');
  }

  const expected = sign(payload, resolveSecret(keyring, claims.keyId));
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  // Length is compared first because timingSafeEqual throws on a mismatch.
  if (
    provided.length !== computed.length ||
    !timingSafeEqual(provided, computed)
  ) {
    throw new IdentityAssertionError('ASSERTION_SIGNATURE_INVALID');
  }

  const now = (options.now ?? new Date()).getTime();
  const tolerance = options.clockToleranceMs ?? 0;
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);

  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    throw new IdentityAssertionError('ASSERTION_MALFORMED', 'unparseable timestamps');
  }
  if (now + tolerance < issuedAt) {
    throw new IdentityAssertionError('ASSERTION_NOT_YET_VALID');
  }
  if (now - tolerance >= expiresAt) {
    throw new IdentityAssertionError('ASSERTION_EXPIRED');
  }

  if (
    options.minimumAssuranceLevel &&
    !assuranceAtLeast(claims.identityAssuranceLevel, options.minimumAssuranceLevel)
  ) {
    throw new IdentityAssertionError(
      'ASSERTION_ASSURANCE_INSUFFICIENT',
      `${claims.identityAssuranceLevel} < ${options.minimumAssuranceLevel}`,
    );
  }

  return claims;
}

/** Single-use nonce tracking. Replay resistance needs state; this holds it. */
export interface AssertionReplayGuard {
  /**
   * Throws ASSERTION_REPLAYED when the nonce has already been consumed.
   *
   * `now` is the same instant the verifier judged the validity window against.
   * A guard that pruned on its own clock could expire a nonce the verifier still
   * considers live, which would silently re-admit a replay.
   */
  consume(nonce: string, expiresAt: string, now?: Date): void;
}

/**
 * Process-local replay guard. Entries are pruned once expired, so the set stays
 * bounded by the assertion TTL rather than growing without limit.
 *
 * A multi-instance deployment needs a shared guard; this one is correct only
 * within a single process.
 */
export class InMemoryAssertionReplayGuard implements AssertionReplayGuard {
  private readonly seen = new Map<string, number>();

  consume(nonce: string, expiresAt: string, now: Date = new Date()): void {
    const instant = now.getTime();
    this.prune(instant);
    if (this.seen.has(nonce)) {
      throw new IdentityAssertionError('ASSERTION_REPLAYED', `nonce=${nonce}`);
    }
    const parsed = Date.parse(expiresAt);
    this.seen.set(nonce, Number.isNaN(parsed) ? instant : parsed);
  }

  sizeAt(now: Date = new Date()): number {
    this.prune(now.getTime());
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }
}

/**
 * Verifies an assertion and consumes its nonce, so the same assertion cannot
 * authorise two actions. This is the entry point for any acting path.
 */
export function consumeIdentityAssertion(
  token: string,
  keyring: AssertionKeyring,
  guard: AssertionReplayGuard,
  options: VerifyAssertionOptions = {},
): IdentityAssertionClaims {
  const claims = verifyIdentityAssertion(token, keyring, options);
  guard.consume(claims.nonce, claims.expiresAt, options.now);
  return claims;
}

/**
 * Builds a keyring from configuration. There is no default secret: an
 * unconfigured deployment fails closed rather than signing with a known value.
 *
 * `IDENTITY_ASSERTION_KEYS` is `keyId:secret` pairs separated by commas;
 * `IDENTITY_ASSERTION_ACTIVE_KEY_ID` selects the signing key.
 */
export function loadAssertionKeyring(
  env: Record<string, string | undefined>,
): AssertionKeyring {
  const raw = env.IDENTITY_ASSERTION_KEYS?.trim();
  const activeKeyId = env.IDENTITY_ASSERTION_ACTIVE_KEY_ID?.trim();

  if (!raw || !activeKeyId) {
    throw new IdentityAssertionError(
      'ASSERTION_KEYRING_REQUIRED',
      'set IDENTITY_ASSERTION_KEYS and IDENTITY_ASSERTION_ACTIVE_KEY_ID',
    );
  }

  const keys: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const keyId = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (keyId && secret) keys[keyId] = secret;
  }

  if (!keys[activeKeyId]) {
    throw new IdentityAssertionError('ASSERTION_ACTIVE_KEY_UNKNOWN', activeKeyId);
  }
  for (const keyId of Object.keys(keys)) resolveSecret({ activeKeyId, keys }, keyId);

  return { activeKeyId, keys };
}

/**
 * Store-backed issuing and consumption, so every assertion decision lands in the
 * append-only audit trail.
 *
 * The token is never handed to the store. InMemoryTrustStore does strip metadata
 * keys that look like credentials, but relying on that would make the audit trail
 * one regex edit away from holding live assertions. A non-reversible fingerprint
 * is recorded instead, which is enough to correlate repeated attempts.
 */
export class IdentityAssertionService {
  constructor(
    private readonly store: TrustPersistence,
    private readonly keyring: AssertionKeyring,
    private readonly guard: AssertionReplayGuard = new InMemoryAssertionReplayGuard(),
  ) {}

  issue(
    input: CreateAssertionInput,
    correlationId: string,
  ): { token: string; claims: IdentityAssertionClaims } {
    const issued = createIdentityAssertion(input, this.keyring);

    this.store.audit({
      actorId: issued.claims.subject,
      eventType: 'IdentityAssertionIssued',
      aggregateType: 'IdentityAssertion',
      aggregateId: issued.claims.nonce,
      correlationId,
      workspaceId: issued.claims.workspaceId,
      tenantId: issued.claims.tenantId,
      metadata: {
        keyId: issued.claims.keyId,
        assurance: issued.claims.identityAssuranceLevel,
        expiresAt: issued.claims.expiresAt,
        assertionFingerprint: fingerprint(issued.token),
      },
    });

    this.store.emit({
      aggregateType: 'IdentityAssertion',
      aggregateId: issued.claims.nonce,
      eventType: 'IdentityAssertionIssued',
      eventVersion: 1,
      payload: { subject: issued.claims.subject, sessionId: issued.claims.sessionId },
      correlationId,
      workspaceId: issued.claims.workspaceId,
      tenantId: issued.claims.tenantId,
    });

    return issued;
  }

  consume(
    token: string,
    correlationId: string,
    options: VerifyAssertionOptions = {},
  ): IdentityAssertionClaims {
    try {
      const claims = consumeIdentityAssertion(token, this.keyring, this.guard, options);
      this.store.audit({
        actorId: claims.subject,
        eventType: 'IdentityAssertionAccepted',
        aggregateType: 'IdentityAssertion',
        aggregateId: claims.nonce,
        correlationId,
        workspaceId: claims.workspaceId,
        tenantId: claims.tenantId,
        metadata: { keyId: claims.keyId, assurance: claims.identityAssuranceLevel },
      });
      return claims;
    } catch (error) {
      const code =
        error instanceof IdentityAssertionError ? error.code : 'ASSERTION_MALFORMED';
      this.store.audit({
        actorId: 'anonymous',
        eventType: 'IdentityAssertionRejected',
        aggregateType: 'IdentityAssertion',
        aggregateId: 'unknown',
        correlationId,
        metadata: { reason: code, assertionFingerprint: fingerprint(token ?? '') },
      });
      throw error;
    }
  }
}
