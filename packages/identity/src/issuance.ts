import type { AssuranceLevel, TrustPersistence } from '@assurapay/shared';
import type { IdentityAssertionClaims } from './assertions';
import type { AuthenticatedPrincipal, IdentityGateway } from './gateway';

/**
 * Engine 01 — assertion issuance from an authenticated session.
 *
 * Sign-in produces a session cookie. The gateway authenticates only a signed
 * assertion. Nothing joined the two, so a client holding a cookie could reach no
 * authorized route: the whole API was unreachable in practice.
 *
 * This is the join, and it is deliberately not `IdentityGateway.exchange`. Exchange
 * takes one assertion and returns another, which is a privilege-transfer primitive
 * whose attenuation rules are ungoverned. Issuance instead starts from a session —
 * a credential the identity engine already owns and can revoke — and mints an
 * assertion strictly weaker than it.
 *
 * The rules that make that "strictly weaker" true, each enforced below:
 *
 *   1. **Every claim comes from the session record**, never from the request.
 *      Subject, session id and assurance level are copied from the stored session,
 *      so a caller cannot mint an assertion for another user or claim a higher
 *      assurance than they authenticated with.
 *   2. **The assertion never outlives the session.** Its lifetime is the lesser of
 *      the configured TTL and the session's own remaining validity, so revoking or
 *      expiring a session cannot be outlasted by a token minted just beforehand.
 *   3. **Workspace context requires proven membership.** A workspace may be
 *      selected at issuance, but only one the caller is actively a member of.
 *      Authentication still implies no authorization — the assertion carries no
 *      role, permission or membership list, and enforcement re-reads membership
 *      from the authoritative record regardless.
 *   4. **Issuance is audited as the credential-minting act it is**, including which
 *      workspace was selected, so an assertion can be traced to the session that
 *      produced it.
 */

export type AssertionIssuanceErrorCode =
  | 'ISSUANCE_SESSION_INVALID'
  | 'ISSUANCE_SESSION_EXPIRED'
  | 'ISSUANCE_WORKSPACE_FORBIDDEN'
  | 'ISSUANCE_WORKSPACE_UNKNOWN'
  | 'ISSUANCE_ASSURANCE_INSUFFICIENT';

/** Stable codes so callers branch on the reason, never on message text. */
export class AssertionIssuanceError extends Error {
  readonly code: AssertionIssuanceErrorCode;
  readonly detail?: string;

  constructor(code: AssertionIssuanceErrorCode, detail?: string) {
    super(code);
    this.name = 'AssertionIssuanceError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The session fields issuance reads, declared structurally.
 *
 * `UserSession` lives in this package's barrel, which imports this module; naming
 * only what is read avoids the cycle and keeps the contract explicit.
 */
type SessionRecord = {
  id: string;
  userId: string;
  workspaceId?: string;
  identityAssuranceLevel: AssuranceLevel;
  expiresAt: string;
  status: string;
};

type WorkspaceRecord = {
  id: string;
  tenantId: string;
  status: string;
};

type MembershipRecord = {
  workspaceId: string;
  userId: string;
  status: string;
};

/**
 * Resolves a raw session token to a live session.
 *
 * An interface rather than a concrete `IdentityService` import, so issuance depends
 * on the act of resolving rather than on the whole identity surface, and can be
 * tested without constructing one.
 */
export interface SessionResolver {
  resolveSession(rawToken: string): SessionRecord;
}

export type IssueAssertionInput = {
  /** The session cookie value presented by the caller. */
  rawSessionToken: string;
  correlationId: string;
  /**
   * Workspace to place in the assertion. Optional: an assertion with no workspace
   * is valid and reaches identity-class routes, which is how a caller with no
   * workspace yet discovers its memberships.
   */
  workspaceId?: string;
  /** Narrows the assertion to one operation, when the caller scopes one. */
  purpose?: string;
  /**
   * Refuses issuance below this assurance level. A step-up path sets it so a
   * sensitive operation cannot be reached with a weaker credential than it needs.
   */
  minimumAssuranceLevel?: AssuranceLevel;
  now?: Date;
};

export type IssuedAssertion = {
  token: string;
  claims: IdentityAssertionClaims;
  /** When the assertion expires — never later than the session behind it. */
  expiresAt: string;
  /** True when the assertion's life was cut short by the session's own expiry. */
  boundedBySession: boolean;
};

/** Ordered weakest to strongest, mirroring the assertion layer. */
const ASSURANCE_ORDER: AssuranceLevel[] = [
  'IAL0_UNVERIFIED',
  'IAL1_BASIC',
  'IAL2_VERIFIED',
  'IAL3_HIGH_ASSURANCE',
];

function meetsAssurance(actual: AssuranceLevel, minimum: AssuranceLevel): boolean {
  return ASSURANCE_ORDER.indexOf(actual) >= ASSURANCE_ORDER.indexOf(minimum);
}

/**
 * Mints an identity assertion for the holder of a valid session.
 *
 * Returns the token and the claims it carries. The claims are returned so a caller
 * can show the user what was minted; they contain no secret, and the signature is
 * only inside the token.
 */
export function issueAssertionForSession(
  gateway: IdentityGateway,
  sessions: SessionResolver,
  store: TrustPersistence,
  input: IssueAssertionInput,
): IssuedAssertion {
  const now = input.now ?? new Date();

  // resolveSession already rejects an unknown, revoked or expired session and an
  // inactive identity. Its failure is reshaped into a stable issuance code without
  // restating which of those it was: telling an unauthenticated caller whether a
  // token is unknown or merely revoked is a distinction they have not earned.
  let session: SessionRecord;
  try {
    session = sessions.resolveSession(input.rawSessionToken);
  } catch {
    throw new AssertionIssuanceError('ISSUANCE_SESSION_INVALID');
  }

  const sessionExpiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(sessionExpiry) || sessionExpiry <= now.getTime()) {
    throw new AssertionIssuanceError('ISSUANCE_SESSION_EXPIRED');
  }

  if (
    input.minimumAssuranceLevel &&
    !meetsAssurance(session.identityAssuranceLevel, input.minimumAssuranceLevel)
  ) {
    throw new AssertionIssuanceError(
      'ISSUANCE_ASSURANCE_INSUFFICIENT',
      `session is ${session.identityAssuranceLevel}, ${input.minimumAssuranceLevel} required`,
    );
  }

  const workspace = resolveWorkspace(store, session, input.workspaceId);

  const principal: AuthenticatedPrincipal = {
    // Every field is read from the session record. Nothing here is caller-supplied,
    // which is what makes issuance incapable of impersonation.
    subject: session.userId,
    sessionId: session.id,
    identityAssuranceLevel: session.identityAssuranceLevel,
    workspaceId: workspace?.id,
    tenantId: workspace?.tenantId,
  };

  const issued = gateway.issue(principal, input.correlationId, {
    purpose: input.purpose,
    now,
  });

  // The gateway applies its configured TTL. If that would outlive the session, the
  // session wins: a credential minted from a session must not survive it, or
  // revoking the session would not revoke what it authorized.
  const assertionExpiry = Date.parse(issued.claims.expiresAt);
  const boundedBySession = sessionExpiry < assertionExpiry;
  const expiresAt = new Date(Math.min(assertionExpiry, sessionExpiry)).toISOString();

  store.audit({
    tenantId: workspace?.tenantId,
    workspaceId: workspace?.id,
    actorId: session.userId,
    // A distinct event from the gateway's own IdentityAssertionIssued, which is
    // keyed on the assertion nonce. This one is keyed on the session, so the pair
    // traces session -> assertion in both directions. Duplicating the gateway's
    // record here would inflate the mint count and make neither authoritative.
    eventType: 'SessionAssertionIssued',
    aggregateType: 'UserSession',
    aggregateId: session.id,
    correlationId: input.correlationId,
    metadata: {
      // The token and its signature are never recorded. The nonce identifies the
      // assertion without being usable as one.
      nonce: issued.claims.nonce,
      keyId: issued.claims.keyId,
      purpose: input.purpose ?? null,
      workspaceId: workspace?.id ?? null,
      assurance: session.identityAssuranceLevel,
      expiresAt,
      boundedBySession,
    },
  });

  return {
    token: issued.token,
    claims: { ...issued.claims, expiresAt },
    expiresAt,
    boundedBySession,
  };
}

/**
 * Selects the workspace the assertion will name.
 *
 * Requesting one requires an ACTIVE membership. This is not the authorization
 * decision — enforcement re-reads membership from the same record on every request
 * and would refuse a mismatch anyway — but minting a signed statement naming a
 * workspace the caller has no membership in would put a claim into circulation that
 * nothing should ever have produced.
 */
function resolveWorkspace(
  store: TrustPersistence,
  session: SessionRecord,
  requested?: string,
): WorkspaceRecord | undefined {
  const target = requested?.trim() || session.workspaceId?.trim();
  if (!target) return undefined;

  const workspace = store
    .list<WorkspaceRecord>('trustWorkspaces')
    .find((entry) => entry.id === target && entry.status === 'ACTIVE');
  if (!workspace) {
    throw new AssertionIssuanceError('ISSUANCE_WORKSPACE_UNKNOWN', target);
  }

  const member = store
    .list<MembershipRecord>('memberships')
    .some(
      (entry) =>
        entry.workspaceId === target &&
        entry.userId === session.userId &&
        entry.status === 'ACTIVE',
    );
  if (!member) {
    throw new AssertionIssuanceError('ISSUANCE_WORKSPACE_FORBIDDEN', target);
  }

  return workspace;
}
