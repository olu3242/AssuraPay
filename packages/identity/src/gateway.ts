import type { AssuranceLevel, RequestContext, TrustPersistence } from '@assurapay/shared';
import {
  IdentityAssertionError,
  consumeIdentityAssertion,
  createIdentityAssertion,
  fingerprint,
  verifyIdentityAssertion,
  type AssertionKeyring,
  type AssertionReplayStore,
  type IdentityAssertionClaims,
  type VerifyAssertionOptions,
} from './assertions';

/**
 * Engine 01 — production identity gateway.
 *
 * The governed boundary that turns a transport request into a verified
 * `RequestContext`. It composes the assertion primitive and owns no cryptography,
 * token format, replay bookkeeping or key management of its own.
 *
 * ## The identity boundary
 *
 * The gateway establishes only identity facts that a signature proves. It does not
 * assign roles, infer permissions, resolve memberships, grant scopes, evaluate
 * policy or authorize anything. CLAUDE.md: authentication never implies
 * authorization.
 *
 * That has a concrete consequence. `RequestContext.memberships` is authorization
 * input, so the gateway always emits an **empty** membership list — a signature
 * proving who someone is cannot also prove what workspaces they belong to. Callers
 * needing workspace scope must have membership resolved by the organizations and
 * permission engines. `requireActiveWorkspace` therefore fails closed on a
 * gateway-issued context until that authority has run, which is the correct
 * outcome rather than a gap.
 *
 * ## What is deliberately absent
 *
 * There is no assertion exchange or attenuation surface. The governing capability
 * specification does not define attenuation semantics, and an undefined exchange
 * path is a privilege-transfer primitive with no rules attached, so it is
 * intentionally unsupported rather than guessed at.
 */

export type IdentityGatewayErrorCode =
  | 'GATEWAY_ASSERTION_MISSING'
  | 'GATEWAY_CONFIGURATION_UNAVAILABLE'
  | 'GATEWAY_REPLAY_PROTECTION_INSUFFICIENT'
  | 'GATEWAY_PRINCIPAL_INVALID'
  | 'GATEWAY_TENANT_CONTEXT_REQUIRED'
  | 'GATEWAY_EXCHANGE_UNSUPPORTED';

/**
 * Failures carry a stable code and never quote an assertion, signature, secret or
 * header value. Assertion-layer failures propagate as `IdentityAssertionError`
 * with their own codes, so a caller can branch on the precise reason.
 */
export class IdentityGatewayError extends Error {
  readonly code: IdentityGatewayErrorCode;
  readonly detail?: string;

  constructor(code: IdentityGatewayErrorCode, detail?: string) {
    super(code);
    this.name = 'IdentityGatewayError';
    this.code = code;
    this.detail = detail;
  }
}

/** Header the gateway reads the assertion from. */
export const ASSERTION_HEADER = 'x-assurapay-identity-assertion';

/**
 * An already-authenticated principal, established upstream by the identity
 * engine. The gateway signs identity facts drawn from this; it never authenticates.
 */
export type AuthenticatedPrincipal = {
  /** Tenant-neutral subject reference, not an email. */
  subject: string;
  sessionId: string;
  identityAssuranceLevel: AssuranceLevel;
  workspaceId?: string;
  tenantId?: string;
};

export type IdentityGatewayConfig = {
  /** Signed into every assertion and required on every verification. */
  issuer: string;
  audience: string;
  assertionTtlMs?: number;
  clockToleranceMs?: number;
  /**
   * When true, a replay store that is not `distributed` is refused at
   * construction. Production sets this, so a multi-replica deployment cannot run
   * on process-local replay protection.
   */
  requireDistributedReplayProtection: boolean;
  /** Workspace and tenant context must be present on every issued assertion. */
  requireTenantContext?: boolean;
};

/** Expectations a protected path adds on top of the configured issuer/audience. */
export type IdentityVerificationExpectations = {
  minimumAssuranceLevel?: AssuranceLevel;
  expectedTenantId?: string;
  expectedWorkspaceId?: string;
  expectedSessionId?: string;
  purpose?: string;
  now?: Date;
};

/**
 * Translates verified claims into a typed identity context.
 *
 * Exported separately from the gateway because it is a pure projection with no
 * authority of its own: given claims, it decides nothing. `memberships` is always
 * empty — see the identity boundary note above.
 */
export function resolveRequestContext(
  claims: IdentityAssertionClaims,
  correlationId: string,
): RequestContext {
  return {
    actorUserId: claims.subject,
    sessionId: claims.sessionId,
    identityAssuranceLevel: claims.identityAssuranceLevel,
    activeWorkspaceId: claims.workspaceId,
    tenantId: claims.tenantId,
    // Authentication proves identity, not membership. Populating this from a
    // signature would let an assertion grant workspace access.
    memberships: [],
    correlationId,
  };
}

export class IdentityGateway {
  constructor(
    private readonly store: TrustPersistence,
    private readonly keyring: AssertionKeyring,
    private readonly replayStore: AssertionReplayStore,
    private readonly config: IdentityGatewayConfig,
  ) {
    if (!config?.issuer?.trim() || !config?.audience?.trim()) {
      throw new IdentityGatewayError(
        'GATEWAY_CONFIGURATION_UNAVAILABLE',
        'issuer and audience are required',
      );
    }

    // Fail closed at construction rather than silently degrading at request time.
    if (
      config.requireDistributedReplayProtection &&
      replayStore.guarantee !== 'distributed'
    ) {
      throw new IdentityGatewayError(
        'GATEWAY_REPLAY_PROTECTION_INSUFFICIENT',
        `replay store guarantee is "${replayStore.guarantee}" but distributed protection is required`,
      );
    }
  }

  /** The replay guarantee this gateway actually provides, for reporting. */
  get replayProtection(): AssertionReplayStore['guarantee'] {
    return this.replayStore.guarantee;
  }

  /**
   * Issues an assertion for an already-authenticated principal.
   *
   * Approved identity fields are copied mechanically. A caller cannot supply a
   * claims object, so it cannot smuggle in a field the gateway does not know about.
   */
  async issue(
    principal: AuthenticatedPrincipal,
    correlationId: string,
    options: { purpose?: string; now?: Date } = {},
  ): Promise<{ token: string; claims: IdentityAssertionClaims }> {
    if (!principal?.subject?.trim() || !principal?.sessionId?.trim()) {
      throw new IdentityGatewayError(
        'GATEWAY_PRINCIPAL_INVALID',
        'subject and sessionId are required',
      );
    }
    if (!ASSURANCE_LEVELS.has(principal.identityAssuranceLevel)) {
      throw new IdentityGatewayError(
        'GATEWAY_PRINCIPAL_INVALID',
        `unsupported assurance level: ${String(principal.identityAssuranceLevel)}`,
      );
    }
    if (
      this.config.requireTenantContext &&
      (!principal.tenantId?.trim() || !principal.workspaceId?.trim())
    ) {
      throw new IdentityGatewayError(
        'GATEWAY_TENANT_CONTEXT_REQUIRED',
        'tenantId and workspaceId are required by configuration',
      );
    }

    const issued = createIdentityAssertion(
      {
        subject: principal.subject,
        sessionId: principal.sessionId,
        identityAssuranceLevel: principal.identityAssuranceLevel,
        workspaceId: principal.workspaceId,
        tenantId: principal.tenantId,
        issuer: this.config.issuer,
        audience: this.config.audience,
        purpose: options.purpose,
        ttlMs: this.config.assertionTtlMs,
        now: options.now,
      },
      this.keyring,
    );

    await this.audit('IdentityAssertionIssued', issued.claims, correlationId, {
      purpose: options.purpose ?? 'unscoped',
    });

    return issued;
  }

  /**
   * Verifies an assertion without consuming it, for inspection and for the
   * per-request identity of read paths. The nonce survives, so a later acting path
   * can still consume the same assertion exactly once.
   */
  async verify(
    token: string,
    expectations: IdentityVerificationExpectations = {},
  ): Promise<IdentityAssertionClaims> {
    return verifyIdentityAssertion(
      await this.requireToken(token),
      this.keyring,
      this.verifyOptions(expectations),
    );
  }

  /**
   * Verifies and consumes an assertion. This is the entry point for a protected
   * acting path: the nonce is burned, so the same assertion cannot authorise a
   * second action.
   */
  async consume(
    token: string,
    correlationId: string,
    expectations: IdentityVerificationExpectations = {},
  ): Promise<IdentityAssertionClaims> {
    const present = await this.requireToken(token, correlationId);
    try {
      const claims = consumeIdentityAssertion(
        present,
        this.keyring,
        this.replayStore,
        this.verifyOptions(expectations),
      );
      await this.audit('IdentityAssertionConsumed', claims, correlationId, {
        replayProtection: this.replayStore.guarantee,
      });
      return claims;
    } catch (error) {
      await this.reject(error, present, correlationId);
      throw error;
    }
  }

  /**
   * Verified identity context for a request, without consuming the assertion.
   * Read paths call this; acting paths call `consumeRequestContext`.
   */
  async authenticate(
    request: { headers: { get(name: string): string | null } },
    correlationId: string,
    expectations: IdentityVerificationExpectations = {},
  ): Promise<RequestContext> {
    const token = request.headers.get(ASSERTION_HEADER);
    const present = await this.requireToken(token, correlationId);
    try {
      const claims = verifyIdentityAssertion(
        present,
        this.keyring,
        this.verifyOptions(expectations),
      );
      return resolveRequestContext(claims, correlationId);
    } catch (error) {
      await this.reject(error, present, correlationId);
      throw error;
    }
  }

  /** Verified identity context for an acting path, consuming the assertion. */
  async consumeRequestContext(
    request: { headers: { get(name: string): string | null } },
    correlationId: string,
    expectations: IdentityVerificationExpectations = {},
  ): Promise<RequestContext> {
    const claims = await this.consume(
      request.headers.get(ASSERTION_HEADER) ?? '',
      correlationId,
      expectations,
    );
    return resolveRequestContext(claims, correlationId);
  }

  /**
   * Assertion exchange is intentionally unsupported. Attenuation rules are not
   * defined by the governing capability specification, and an exchange surface
   * without them would transfer privilege under no constraint.
   */
  exchange(): never {
    throw new IdentityGatewayError(
      'GATEWAY_EXCHANGE_UNSUPPORTED',
      'attenuation semantics are not defined by the capability specification',
    );
  }

  private async requireToken(token: string | null | undefined, correlationId?: string): Promise<string> {
    const present = token?.trim();
    if (present) return present;

    if (correlationId) {
      await this.store.audit({
        actorId: 'anonymous',
        eventType: 'IdentityAssertionRejected',
        aggregateType: 'IdentityAssertion',
        aggregateId: 'unknown',
        correlationId,
        metadata: { reason: 'GATEWAY_ASSERTION_MISSING' },
      });
    }
    throw new IdentityGatewayError('GATEWAY_ASSERTION_MISSING');
  }

  /** Configured bindings always apply; a caller may only add expectations. */
  private verifyOptions(
    expectations: IdentityVerificationExpectations,
  ): VerifyAssertionOptions {
    return {
      now: expectations.now,
      clockToleranceMs: this.config.clockToleranceMs,
      minimumAssuranceLevel: expectations.minimumAssuranceLevel,
      expectedIssuer: this.config.issuer,
      expectedAudience: this.config.audience,
      expectedPurpose: expectations.purpose,
      expectedTenantId: expectations.expectedTenantId,
      expectedWorkspaceId: expectations.expectedWorkspaceId,
      expectedSessionId: expectations.expectedSessionId,
    };
  }

  private async audit(
    eventType: string,
    claims: IdentityAssertionClaims,
    correlationId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.store.audit({
      actorId: claims.subject,
      eventType,
      aggregateType: 'IdentityAssertion',
      aggregateId: claims.nonce,
      correlationId,
      workspaceId: claims.workspaceId,
      tenantId: claims.tenantId,
      metadata: {
        assertionFingerprint: fingerprint(`${claims.nonce}:${claims.keyId}`),
        keyId: claims.keyId,
        issuer: claims.issuer,
        audience: claims.audience,
        assurance: claims.identityAssuranceLevel,
        expiresAt: claims.expiresAt,
        ...extra,
      },
    });
  }

  /**
   * Records a rejection with a bounded, sanitized reason. The fingerprint is
   * computed here, before the event reaches the store, so the raw assertion never
   * crosses that boundary and the record does not rely on downstream masking.
   */
  private async reject(error: unknown, token: string, correlationId: string): Promise<void> {
    const reason =
      error instanceof IdentityAssertionError || error instanceof IdentityGatewayError
        ? error.code
        : 'ASSERTION_MALFORMED';

    await this.store.audit({
      actorId: 'anonymous',
      eventType: 'IdentityAssertionRejected',
      aggregateType: 'IdentityAssertion',
      aggregateId: 'unknown',
      correlationId,
      metadata: { reason, assertionFingerprint: fingerprint(token) },
    });
  }
}

const ASSURANCE_LEVELS = new Set<AssuranceLevel>([
  'IAL0_UNVERIFIED',
  'IAL1_BASIC',
  'IAL2_VERIFIED',
  'IAL3_HIGH_ASSURANCE',
]);

/**
 * Builds gateway configuration from the environment. Fails closed: there is no
 * default issuer or audience, and production requires distributed replay
 * protection unless a deployment explicitly accepts single-process semantics.
 */
export function loadGatewayConfig(
  env: Record<string, string | undefined>,
): IdentityGatewayConfig {
  const issuer = env.IDENTITY_ASSERTION_ISSUER?.trim();
  const audience = env.IDENTITY_ASSERTION_AUDIENCE?.trim();

  if (!issuer || !audience) {
    throw new IdentityGatewayError(
      'GATEWAY_CONFIGURATION_UNAVAILABLE',
      'set IDENTITY_ASSERTION_ISSUER and IDENTITY_ASSERTION_AUDIENCE',
    );
  }

  const singleProcessAccepted =
    env.IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY === 'true';

  return {
    issuer,
    audience,
    assertionTtlMs: env.IDENTITY_ASSERTION_TTL_MS
      ? Number(env.IDENTITY_ASSERTION_TTL_MS)
      : undefined,
    clockToleranceMs: env.IDENTITY_ASSERTION_CLOCK_TOLERANCE_MS
      ? Number(env.IDENTITY_ASSERTION_CLOCK_TOLERANCE_MS)
      : undefined,
    requireDistributedReplayProtection:
      env.NODE_ENV === 'production' && !singleProcessAccepted,
    requireTenantContext: env.IDENTITY_ASSERTION_REQUIRE_TENANT === 'true',
  };
}
