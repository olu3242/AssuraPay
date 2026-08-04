import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ASSERTION_HEADER,
  IdentityAssertionError,
  IdentityGateway,
  IdentityGatewayError,
  InMemoryAssertionReplayStore,
  createIdentityAssertion,
  loadGatewayConfig,
  resolveRequestContext,
  type AssertionKeyring,
  type AssertionReplayStore,
  type AuthenticatedPrincipal,
  type IdentityGatewayConfig,
} from './index';

const SECRET = 'g'.repeat(48);
const keyring: AssertionKeyring = { activeKeyId: 'key-1', keys: { 'key-1': SECRET } };
const NOW = new Date('2026-08-04T12:00:00.000Z');

const config: IdentityGatewayConfig = {
  issuer: 'assurapay-identity',
  audience: 'assurapay-web',
  requireDistributedReplayProtection: false,
};

const principal: AuthenticatedPrincipal = {
  subject: 'subject-1',
  sessionId: 'session-1',
  identityAssuranceLevel: 'IAL2_VERIFIED',
  workspaceId: 'workspace-1',
  tenantId: 'tenant-1',
};

/** Minimal stand-in for a durable store, to exercise the distributed contract. */
class FakeDistributedReplayStore implements AssertionReplayStore {
  readonly guarantee = 'distributed' as const;
  private readonly seen = new Set<string>();
  readonly calls: string[] = [];

  consumeIfAbsent(nonce: string): boolean {
    this.calls.push(nonce);
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

function build(
  overrides: Partial<IdentityGatewayConfig> = {},
  store: AssertionReplayStore = new InMemoryAssertionReplayStore(),
) {
  const trustStore = new InMemoryTrustStore();
  const gateway = new IdentityGateway(trustStore, keyring, store, {
    ...config,
    ...overrides,
  });
  return { trustStore, gateway, store };
}

function requestWith(token: string) {
  return { headers: { get: (name: string) => (name === ASSERTION_HEADER ? token : null) } };
}

function auditRecords(store: InMemoryTrustStore) {
  return store.list<{ eventType: string; metadata: Record<string, unknown> }>(
    'auditRecords',
  );
}

describe('Engine 01 identity gateway — construction and configuration', () => {
  it('requires an issuer and an audience', () => {
    const trustStore = new InMemoryTrustStore();
    for (const broken of [{ issuer: '' }, { audience: '  ' }]) {
      expect(
        () =>
          new IdentityGateway(trustStore, keyring, new InMemoryAssertionReplayStore(), {
            ...config,
            ...broken,
          }),
      ).toThrow('GATEWAY_CONFIGURATION_UNAVAILABLE');
    }
  });

  it('refuses a process-local replay store when distributed protection is required', () => {
    expect(() =>
      build({ requireDistributedReplayProtection: true }),
    ).toThrow('GATEWAY_REPLAY_PROTECTION_INSUFFICIENT');
  });

  it('accepts a distributed replay store when distributed protection is required', () => {
    const { gateway } = build(
      { requireDistributedReplayProtection: true },
      new FakeDistributedReplayStore(),
    );
    expect(gateway.replayProtection).toBe('distributed');
  });

  it('reports the guarantee it actually has, never a stronger one', () => {
    expect(build().gateway.replayProtection).toBe('process-local');
  });

  it('loads configuration from the environment and fails closed without it', () => {
    expect(() => loadGatewayConfig({})).toThrow('GATEWAY_CONFIGURATION_UNAVAILABLE');
    expect(() =>
      loadGatewayConfig({ IDENTITY_ASSERTION_ISSUER: 'i' }),
    ).toThrow('GATEWAY_CONFIGURATION_UNAVAILABLE');

    const loaded = loadGatewayConfig({
      IDENTITY_ASSERTION_ISSUER: 'assurapay-identity',
      IDENTITY_ASSERTION_AUDIENCE: 'assurapay-web',
    });
    expect(loaded.issuer).toBe('assurapay-identity');
    expect(loaded.requireDistributedReplayProtection).toBe(false);
  });

  it('requires distributed replay protection in production unless explicitly accepted', () => {
    const base = {
      IDENTITY_ASSERTION_ISSUER: 'i',
      IDENTITY_ASSERTION_AUDIENCE: 'a',
      NODE_ENV: 'production',
    };
    expect(loadGatewayConfig(base).requireDistributedReplayProtection).toBe(true);

    // A single-process deployment may accept it, but must say so out loud.
    expect(
      loadGatewayConfig({
        ...base,
        IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY: 'true',
      }).requireDistributedReplayProtection,
    ).toBe(false);
  });
});

describe('Engine 01 identity gateway — issuance', () => {
  it('issues from an authenticated principal and binds issuer and audience', () => {
    const { gateway } = build();
    const { claims } = gateway.issue(principal, 'c1', { now: NOW });

    expect(claims.subject).toBe('subject-1');
    expect(claims.issuer).toBe('assurapay-identity');
    expect(claims.audience).toBe('assurapay-web');
    expect(claims.identityAssuranceLevel).toBe('IAL2_VERIFIED');
  });

  it('rejects a principal with no subject or session', () => {
    const { gateway } = build();
    expect(() => gateway.issue({ ...principal, subject: ' ' }, 'c')).toThrow(
      'GATEWAY_PRINCIPAL_INVALID',
    );
    expect(() => gateway.issue({ ...principal, sessionId: '' }, 'c')).toThrow(
      'GATEWAY_PRINCIPAL_INVALID',
    );
  });

  it('rejects an unsupported assurance level rather than signing it', () => {
    const { gateway } = build();
    expect(() =>
      gateway.issue(
        { ...principal, identityAssuranceLevel: 'IAL9_GOD_MODE' as never },
        'c',
      ),
    ).toThrow('GATEWAY_PRINCIPAL_INVALID');
  });

  it('rejects ambiguous tenant context when configuration demands it', () => {
    const { gateway } = build({ requireTenantContext: true });
    expect(() => gateway.issue({ ...principal, tenantId: undefined }, 'c')).toThrow(
      'GATEWAY_TENANT_CONTEXT_REQUIRED',
    );
    expect(() => gateway.issue({ ...principal, workspaceId: '' }, 'c')).toThrow(
      'GATEWAY_TENANT_CONTEXT_REQUIRED',
    );
  });

  it('uses the configured lifetime', () => {
    const { gateway } = build({ assertionTtlMs: 5_000 });
    const { claims } = gateway.issue(principal, 'c', { now: NOW });
    expect(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt)).toBe(5_000);
  });

  it('accepts no caller-supplied claims object, so nothing can be smuggled in', () => {
    const { gateway } = build();
    const hostile = {
      ...principal,
      roles: ['admin'],
      permissions: ['settlement:release'],
      memberships: ['workspace-9'],
    } as AuthenticatedPrincipal;

    const { claims } = gateway.issue(hostile, 'c', { now: NOW });
    for (const forbidden of ['roles', 'permissions', 'memberships']) {
      expect(claims).not.toHaveProperty(forbidden);
    }
  });
});

describe('Engine 01 identity gateway — verification', () => {
  it('verifies a gateway-issued assertion', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });
    expect(gateway.verify(token, { now: NOW }).subject).toBe('subject-1');
  });

  it('does not consume the nonce, so an acting path can still use it once', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    gateway.verify(token, { now: NOW });
    gateway.verify(token, { now: NOW });
    expect(() => gateway.consume(token, 'c', { now: NOW })).not.toThrow();
  });

  it('rejects a missing assertion', () => {
    const { gateway } = build();
    for (const absent of ['', '   ']) {
      expect(() => gateway.consume(absent, 'c')).toThrow('GATEWAY_ASSERTION_MISSING');
    }
    expect(() => gateway.authenticate(requestWith(''), 'c')).toThrow(
      'GATEWAY_ASSERTION_MISSING',
    );
  });

  it('rejects an assertion minted for a different audience', () => {
    const { gateway } = build();
    const foreign = createIdentityAssertion(
      { ...principal, issuer: config.issuer, audience: 'other-service', now: NOW },
      keyring,
    );
    expect(() => gateway.verify(foreign.token, { now: NOW })).toThrow(
      'ASSERTION_AUDIENCE_MISMATCH',
    );
  });

  it('rejects an assertion from a different issuer', () => {
    const { gateway } = build();
    const foreign = createIdentityAssertion(
      { ...principal, issuer: 'someone-else', audience: config.audience, now: NOW },
      keyring,
    );
    expect(() => gateway.verify(foreign.token, { now: NOW })).toThrow(
      'ASSERTION_ISSUER_MISMATCH',
    );
  });

  it('rejects an assertion that simply omits the bound fields', () => {
    // Fail closed: an absent audience must not pass an audience expectation.
    const { gateway } = build();
    const unbound = createIdentityAssertion({ ...principal, now: NOW }, keyring);
    expect(() => gateway.verify(unbound.token, { now: NOW })).toThrow(
      'ASSERTION_ISSUER_MISMATCH',
    );
  });

  it('rejects tenant, workspace and session mismatches', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    expect(() =>
      gateway.verify(token, { now: NOW, expectedTenantId: 'tenant-2' }),
    ).toThrow('ASSERTION_TENANT_MISMATCH');
    expect(() =>
      gateway.verify(token, { now: NOW, expectedWorkspaceId: 'workspace-2' }),
    ).toThrow('ASSERTION_WORKSPACE_MISMATCH');
    expect(() =>
      gateway.verify(token, { now: NOW, expectedSessionId: 'session-2' }),
    ).toThrow('ASSERTION_SESSION_MISMATCH');
  });

  it('accepts matching tenant, workspace and session', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });
    expect(
      gateway.verify(token, {
        now: NOW,
        expectedTenantId: 'tenant-1',
        expectedWorkspaceId: 'workspace-1',
        expectedSessionId: 'session-1',
      }).subject,
    ).toBe('subject-1');
  });

  it('rejects a purpose mismatch and an assertion with no purpose', () => {
    const { gateway } = build();
    const scoped = gateway.issue(principal, 'c', { purpose: 'read', now: NOW });
    expect(() => gateway.verify(scoped.token, { now: NOW, purpose: 'release' })).toThrow(
      'ASSERTION_PURPOSE_MISMATCH',
    );

    const unscoped = gateway.issue(principal, 'c', { now: NOW });
    expect(() => gateway.verify(unscoped.token, { now: NOW, purpose: 'read' })).toThrow(
      'ASSERTION_PURPOSE_MISMATCH',
    );
  });

  it('rejects an insufficient assurance level', () => {
    const { gateway } = build();
    const weak = gateway.issue(
      { ...principal, identityAssuranceLevel: 'IAL1_BASIC' },
      'c',
      { now: NOW },
    );
    expect(() =>
      gateway.verify(weak.token, { now: NOW, minimumAssuranceLevel: 'IAL2_VERIFIED' }),
    ).toThrow('ASSERTION_ASSURANCE_INSUFFICIENT');
  });

  it('propagates malformed, expired, premature and unknown-key rejections', () => {
    const { gateway } = build({ assertionTtlMs: 1_000 });
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    expect(() => gateway.verify('garbage', { now: NOW })).toThrow(IdentityAssertionError);
    expect(() =>
      gateway.verify(token, { now: new Date(NOW.getTime() + 2_000) }),
    ).toThrow('ASSERTION_EXPIRED');
    expect(() =>
      gateway.verify(token, { now: new Date(NOW.getTime() - 2_000) }),
    ).toThrow('ASSERTION_NOT_YET_VALID');

    const foreign = new IdentityGateway(
      new InMemoryTrustStore(),
      { activeKeyId: 'key-2', keys: { 'key-2': 'h'.repeat(48) } },
      new InMemoryAssertionReplayStore(),
      config,
    );
    expect(() => foreign.verify(token, { now: NOW })).toThrow('ASSERTION_UNKNOWN_KEY');
  });
});

describe('Engine 01 identity gateway — consumption and replay', () => {
  it('consumes once and rejects the second attempt', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    expect(gateway.consume(token, 'c', { now: NOW }).subject).toBe('subject-1');
    expect(() => gateway.consume(token, 'c', { now: NOW })).toThrow('ASSERTION_REPLAYED');
  });

  it('exercises the atomic store contract rather than check-then-insert', () => {
    const distributed = new FakeDistributedReplayStore();
    const { gateway } = build({ requireDistributedReplayProtection: true }, distributed);
    const { token, claims } = gateway.issue(principal, 'c', { now: NOW });

    gateway.consume(token, 'c', { now: NOW });
    expect(distributed.calls).toEqual([claims.nonce]);

    expect(() => gateway.consume(token, 'c', { now: NOW })).toThrow('ASSERTION_REPLAYED');
    expect(distributed.calls).toHaveLength(2);
  });

  it('does not reopen a still-valid assertion when other nonces expire', () => {
    const store = new InMemoryAssertionReplayStore();
    const { gateway } = build({ assertionTtlMs: 60_000 }, store);
    const live = gateway.issue(principal, 'c', { now: NOW });

    store.consumeIfAbsent('unrelated', new Date(NOW.getTime() + 10).toISOString(), NOW);
    gateway.consume(live.token, 'c', { now: NOW });

    // Pruning the expired unrelated nonce must not forget the live one.
    const later = new Date(NOW.getTime() + 1_000);
    expect(() => gateway.consume(live.token, 'c', { now: later })).toThrow(
      'ASSERTION_REPLAYED',
    );
  });

  it('uses the injected clock for consumption, not wall-clock', () => {
    const { gateway } = build();
    const past = new Date('2020-01-01T00:00:00.000Z');
    const { token } = gateway.issue(principal, 'c', { now: past });

    gateway.consume(token, 'c', { now: past });
    expect(() => gateway.consume(token, 'c', { now: past })).toThrow('ASSERTION_REPLAYED');
  });
});

describe('Engine 01 identity gateway — identity context', () => {
  it('projects verified claims into a request context', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });
    const context = gateway.authenticate(requestWith(token), 'correlation-1', {
      now: NOW,
    });

    expect(context.actorUserId).toBe('subject-1');
    expect(context.sessionId).toBe('session-1');
    expect(context.identityAssuranceLevel).toBe('IAL2_VERIFIED');
    expect(context.activeWorkspaceId).toBe('workspace-1');
    expect(context.tenantId).toBe('tenant-1');
    expect(context.correlationId).toBe('correlation-1');
  });

  it('never populates memberships, because a signature cannot prove membership', () => {
    const { gateway } = build();
    const { token, claims } = gateway.issue(principal, 'c', { now: NOW });

    expect(gateway.authenticate(requestWith(token), 'c', { now: NOW }).memberships).toEqual(
      [],
    );
    expect(resolveRequestContext(claims, 'c').memberships).toEqual([]);
  });

  it('consumes the assertion when producing an acting-path context', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    expect(
      gateway.consumeRequestContext(requestWith(token), 'c', { now: NOW }).actorUserId,
    ).toBe('subject-1');
    expect(() =>
      gateway.consumeRequestContext(requestWith(token), 'c', { now: NOW }),
    ).toThrow('ASSERTION_REPLAYED');
  });
});

describe('Engine 01 identity gateway — authorization separation', () => {
  const FORBIDDEN = [
    'role',
    'roles',
    'permission',
    'permissions',
    'membership',
    'grant',
    'grants',
    'scope',
    'scopes',
    'policy',
    'policies',
    'entitlement',
    'entitlements',
    'authorization',
    'capabilities',
  ];

  it('keeps authorization-shaped names out of the claims and the encoded assertion', () => {
    const { gateway } = build();
    const { token, claims } = gateway.issue(principal, 'c', { now: NOW });
    const encoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');

    for (const forbidden of FORBIDDEN) {
      expect(claims).not.toHaveProperty(forbidden);
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('keeps authorization-shaped names out of the identity context', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });
    const context = gateway.authenticate(requestWith(token), 'c', { now: NOW });
    const serialised = JSON.stringify(context);

    for (const forbidden of FORBIDDEN) {
      // memberships is a required RequestContext field, so assert it stays empty
      // rather than absent; everything else must be absent entirely.
      if (forbidden === 'membership') continue;
      expect(context).not.toHaveProperty(forbidden);
      if (forbidden !== 'memberships') expect(serialised).not.toContain(forbidden);
    }
    expect(context.memberships).toEqual([]);
  });

  it('cannot elevate assurance above what was signed', () => {
    const { gateway } = build();
    const { token } = gateway.issue(
      { ...principal, identityAssuranceLevel: 'IAL1_BASIC' },
      'c',
      { now: NOW },
    );
    expect(
      gateway.authenticate(requestWith(token), 'c', { now: NOW })
        .identityAssuranceLevel,
    ).toBe('IAL1_BASIC');
  });

  it('exposes no assertion exchange surface', () => {
    const { gateway } = build();
    expect(() => gateway.exchange()).toThrow('GATEWAY_EXCHANGE_UNSUPPORTED');
  });
});

describe('Engine 01 identity gateway — audit and secret handling', () => {
  it('records issuance and consumption without the assertion or signature', () => {
    const { gateway, trustStore } = build();
    const { token } = gateway.issue(principal, 'c1', { now: NOW });
    gateway.consume(token, 'c2', { now: NOW });

    const records = auditRecords(trustStore);
    expect(records.map((record) => record.eventType)).toEqual([
      'IdentityAssertionIssued',
      'IdentityAssertionConsumed',
    ]);

    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(token.split('.')[2]);
    expect(serialised).not.toContain(SECRET);
  });

  it('records the replay guarantee that actually applied', () => {
    const { gateway, trustStore } = build();
    const { token } = gateway.issue(principal, 'c1', { now: NOW });
    gateway.consume(token, 'c2', { now: NOW });

    const consumed = auditRecords(trustStore).find(
      (record) => record.eventType === 'IdentityAssertionConsumed',
    );
    expect(consumed?.metadata.replayProtection).toBe('process-local');
  });

  it('records a bounded sanitized rejection', () => {
    const { gateway, trustStore } = build();
    // Well-formed but wrongly signed, so the signature check is what rejects it.
    const { token } = gateway.issue(principal, 'setup', { now: NOW });
    const [version, payload] = token.split('.');
    const forged = `${version}.${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    expect(() => gateway.consume(forged, 'c', { now: NOW })).toThrow();

    const rejected = auditRecords(trustStore).filter(
      (record) => record.eventType === 'IdentityAssertionRejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata.reason).toBe('ASSERTION_SIGNATURE_INVALID');
    expect(JSON.stringify(rejected)).not.toContain(payload);
  });

  it('records a malformed assertion as malformed, not as a signature failure', () => {
    const { gateway, trustStore } = build();
    expect(() => gateway.consume('v1.notbase64json.sig', 'c', { now: NOW })).toThrow();
    expect(auditRecords(trustStore)[0].metadata.reason).toBe('ASSERTION_MALFORMED');
  });

  it('records a missing assertion without inventing an actor', () => {
    const { gateway, trustStore } = build();
    expect(() => gateway.authenticate(requestWith(''), 'c')).toThrow();

    const records = auditRecords(trustStore);
    expect(records).toHaveLength(1);
    expect(records[0].metadata.reason).toBe('GATEWAY_ASSERTION_MISSING');
  });

  it('hands the store no metadata key that looks like a credential', () => {
    const { gateway, trustStore } = build();
    const { token } = gateway.issue(principal, 'c1', { now: NOW });
    gateway.consume(token, 'c2', { now: NOW });

    for (const record of auditRecords(trustStore)) {
      for (const key of Object.keys(record.metadata)) {
        expect(key).not.toMatch(/password|token|otp|secret|account|identityNumber/i);
      }
    }
  });

  it('keeps assertion contents and secrets out of error messages', () => {
    const { gateway } = build();
    const { token } = gateway.issue(principal, 'c', { now: NOW });

    try {
      gateway.verify(token, { now: new Date(NOW.getTime() + 600_000) });
      throw new Error('expected rejection');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('ASSERTION_EXPIRED');
      expect(message).not.toContain(token);
      expect(message).not.toContain(SECRET);
    }
  });

  it('produces a deterministic non-reversible fingerprint', () => {
    const { gateway, trustStore } = build();
    gateway.issue(principal, 'c1', { now: NOW });
    const first = auditRecords(trustStore)[0].metadata.assertionFingerprint as string;

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain(SECRET);
  });

  it('raises a typed gateway error, distinct from an assertion error', () => {
    const { gateway } = build();
    expect(() => gateway.consume('', 'c')).toThrow(IdentityGatewayError);
    expect(() => gateway.verify('garbage', { now: NOW })).toThrow(IdentityAssertionError);
  });
});
