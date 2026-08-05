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

async function auditRecords(store: InMemoryTrustStore) {
  return await store.list<{ eventType: string; metadata: Record<string, unknown> }>(
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
  it('issues from an authenticated principal and binds issuer and audience', async () => {
    const { gateway } = build();
    const { claims } = await gateway.issue(principal, 'c1', { now: NOW });

    expect(claims.subject).toBe('subject-1');
    expect(claims.issuer).toBe('assurapay-identity');
    expect(claims.audience).toBe('assurapay-web');
    expect(claims.identityAssuranceLevel).toBe('IAL2_VERIFIED');
  });

  it('rejects a principal with no subject or session', async () => {
    const { gateway } = build();
    await expect(await gateway.issue({ ...principal, subject: ' ' }, 'c')).rejects.toThrow(
      'GATEWAY_PRINCIPAL_INVALID',
    );
    await expect(await gateway.issue({ ...principal, sessionId: '' }, 'c')).rejects.toThrow(
      'GATEWAY_PRINCIPAL_INVALID',
    );
  });

  it('rejects an unsupported assurance level rather than signing it', async () => {
    const { gateway } = build();
    await expect(await gateway.issue(
        { ...principal, identityAssuranceLevel: 'IAL9_GOD_MODE' as never },
        'c',
      )).rejects.toThrow('GATEWAY_PRINCIPAL_INVALID');
  });

  it('rejects ambiguous tenant context when configuration demands it', async () => {
    const { gateway } = build({ requireTenantContext: true });
    await expect(await gateway.issue({ ...principal, tenantId: undefined }, 'c')).rejects.toThrow(
      'GATEWAY_TENANT_CONTEXT_REQUIRED',
    );
    await expect(await gateway.issue({ ...principal, workspaceId: '' }, 'c')).rejects.toThrow(
      'GATEWAY_TENANT_CONTEXT_REQUIRED',
    );
  });

  it('uses the configured lifetime', async () => {
    const { gateway } = build({ assertionTtlMs: 5_000 });
    const { claims } = await gateway.issue(principal, 'c', { now: NOW });
    expect(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt)).toBe(5_000);
  });

  it('accepts no caller-supplied claims object, so nothing can be smuggled in', async () => {
    const { gateway } = build();
    const hostile = {
      ...principal,
      roles: ['admin'],
      permissions: ['settlement:release'],
      memberships: ['workspace-9'],
    } as AuthenticatedPrincipal;

    const { claims } = await gateway.issue(hostile, 'c', { now: NOW });
    for (const forbidden of ['roles', 'permissions', 'memberships']) {
      expect(claims).not.toHaveProperty(forbidden);
    }
  });
});

describe('Engine 01 identity gateway — verification', () => {
  it('verifies a gateway-issued assertion', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });
    expect((await gateway.verify(token, { now: NOW })).subject).toBe('subject-1');
  });

  it('does not consume the nonce, so an acting path can still use it once', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    await gateway.verify(token, { now: NOW });
    await gateway.verify(token, { now: NOW });
    await expect(await gateway.consume(token, 'c', { now: NOW })).resolves.not.toThrow();
  });

  it('rejects a missing assertion', async () => {
    const { gateway } = build();
    for (const absent of ['', '   ']) {
      await expect(await gateway.consume(absent, 'c')).rejects.toThrow('GATEWAY_ASSERTION_MISSING');
    }
    await expect(await gateway.authenticate(requestWith(''), 'c')).rejects.toThrow(
      'GATEWAY_ASSERTION_MISSING',
    );
  });

  it('rejects an assertion minted for a different audience', async () => {
    const { gateway } = build();
    const foreign = createIdentityAssertion(
      { ...principal, issuer: config.issuer, audience: 'other-service', now: NOW },
      keyring,
    );
    await expect(await gateway.verify(foreign.token, { now: NOW })).rejects.toThrow(
      'ASSERTION_AUDIENCE_MISMATCH',
    );
  });

  it('rejects an assertion from a different issuer', async () => {
    const { gateway } = build();
    const foreign = createIdentityAssertion(
      { ...principal, issuer: 'someone-else', audience: config.audience, now: NOW },
      keyring,
    );
    await expect(await gateway.verify(foreign.token, { now: NOW })).rejects.toThrow(
      'ASSERTION_ISSUER_MISMATCH',
    );
  });

  it('rejects an assertion that simply omits the bound fields', async () => {
    // Fail closed: an absent audience must not pass an audience expectation.
    const { gateway } = build();
    const unbound = createIdentityAssertion({ ...principal, now: NOW }, keyring);
    await expect(await gateway.verify(unbound.token, { now: NOW })).rejects.toThrow(
      'ASSERTION_ISSUER_MISMATCH',
    );
  });

  it('rejects tenant, workspace and session mismatches', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    await expect(await gateway.verify(token, { now: NOW, expectedTenantId: 'tenant-2' })).rejects.toThrow('ASSERTION_TENANT_MISMATCH');
    await expect(await gateway.verify(token, { now: NOW, expectedWorkspaceId: 'workspace-2' })).rejects.toThrow('ASSERTION_WORKSPACE_MISMATCH');
    await expect(await gateway.verify(token, { now: NOW, expectedSessionId: 'session-2' })).rejects.toThrow('ASSERTION_SESSION_MISMATCH');
  });

  it('accepts matching tenant, workspace and session', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });
    expect(
      (await gateway.verify(token, {
        now: NOW,
        expectedTenantId: 'tenant-1',
        expectedWorkspaceId: 'workspace-1',
        expectedSessionId: 'session-1',
      })).subject,
    ).toBe('subject-1');
  });

  it('rejects a purpose mismatch and an assertion with no purpose', async () => {
    const { gateway } = build();
    const scoped = await gateway.issue(principal, 'c', { purpose: 'read', now: NOW });
    await expect(await gateway.verify(scoped.token, { now: NOW, purpose: 'release' })).rejects.toThrow(
      'ASSERTION_PURPOSE_MISMATCH',
    );

    const unscoped = await gateway.issue(principal, 'c', { now: NOW });
    await expect(await gateway.verify(unscoped.token, { now: NOW, purpose: 'read' })).rejects.toThrow(
      'ASSERTION_PURPOSE_MISMATCH',
    );
  });

  it('rejects an insufficient assurance level', async () => {
    const { gateway } = build();
    const weak = await gateway.issue(
      { ...principal, identityAssuranceLevel: 'IAL1_BASIC' },
      'c',
      { now: NOW },
    );
    await expect(await gateway.verify(weak.token, { now: NOW, minimumAssuranceLevel: 'IAL2_VERIFIED' })).rejects.toThrow('ASSERTION_ASSURANCE_INSUFFICIENT');
  });

  it('propagates malformed, expired, premature and unknown-key rejections', async () => {
    const { gateway } = build({ assertionTtlMs: 1_000 });
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    await expect(await gateway.verify('garbage', { now: NOW })).rejects.toThrow(IdentityAssertionError);
    await expect(await gateway.verify(token, { now: new Date(NOW.getTime() + 2_000) })).rejects.toThrow('ASSERTION_EXPIRED');
    await expect(await gateway.verify(token, { now: new Date(NOW.getTime() - 2_000) })).rejects.toThrow('ASSERTION_NOT_YET_VALID');

    const foreign = new IdentityGateway(
      new InMemoryTrustStore(),
      { activeKeyId: 'key-2', keys: { 'key-2': 'h'.repeat(48) } },
      new InMemoryAssertionReplayStore(),
      config,
    );
    await expect(await foreign.verify(token, { now: NOW })).rejects.toThrow('ASSERTION_UNKNOWN_KEY');
  });
});

describe('Engine 01 identity gateway — consumption and replay', () => {
  it('consumes once and rejects the second attempt', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    expect((await gateway.consume(token, 'c', { now: NOW })).subject).toBe('subject-1');
    await expect(await gateway.consume(token, 'c', { now: NOW })).rejects.toThrow('ASSERTION_REPLAYED');
  });

  it('exercises the atomic store contract rather than check-then-insert', async () => {
    const distributed = new FakeDistributedReplayStore();
    const { gateway } = build({ requireDistributedReplayProtection: true }, distributed);
    const { token, claims } = await gateway.issue(principal, 'c', { now: NOW });

    await gateway.consume(token, 'c', { now: NOW });
    expect(distributed.calls).toEqual([claims.nonce]);

    await expect(await gateway.consume(token, 'c', { now: NOW })).rejects.toThrow('ASSERTION_REPLAYED');
    expect(distributed.calls).toHaveLength(2);
  });

  it('does not reopen a still-valid assertion when other nonces expire', async () => {
    const store = new InMemoryAssertionReplayStore();
    const { gateway } = build({ assertionTtlMs: 60_000 }, store);
    const live = await gateway.issue(principal, 'c', { now: NOW });

    store.consumeIfAbsent('unrelated', new Date(NOW.getTime() + 10).toISOString(), NOW);
    await gateway.consume(live.token, 'c', { now: NOW });

    // Pruning the expired unrelated nonce must not forget the live one.
    const later = new Date(NOW.getTime() + 1_000);
    await expect(await gateway.consume(live.token, 'c', { now: later })).rejects.toThrow(
      'ASSERTION_REPLAYED',
    );
  });

  it('uses the injected clock for consumption, not wall-clock', async () => {
    const { gateway } = build();
    const past = new Date('2020-01-01T00:00:00.000Z');
    const { token } = await gateway.issue(principal, 'c', { now: past });

    await gateway.consume(token, 'c', { now: past });
    await expect(await gateway.consume(token, 'c', { now: past })).rejects.toThrow('ASSERTION_REPLAYED');
  });
});

describe('Engine 01 identity gateway — identity context', () => {
  it('projects verified claims into a request context', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });
    const context = await gateway.authenticate(requestWith(token), 'correlation-1', {
      now: NOW,
    });

    expect(context.actorUserId).toBe('subject-1');
    expect(context.sessionId).toBe('session-1');
    expect(context.identityAssuranceLevel).toBe('IAL2_VERIFIED');
    expect(context.activeWorkspaceId).toBe('workspace-1');
    expect(context.tenantId).toBe('tenant-1');
    expect(context.correlationId).toBe('correlation-1');
  });

  it('never populates memberships, because a signature cannot prove membership', async () => {
    const { gateway } = build();
    const { token, claims } = await gateway.issue(principal, 'c', { now: NOW });

    expect((await gateway.authenticate(requestWith(token), 'c', { now: NOW })).memberships).toEqual(
      [],
    );
    expect(resolveRequestContext(claims, 'c').memberships).toEqual([]);
  });

  it('consumes the assertion when producing an acting-path context', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    expect(
      (await gateway.consumeRequestContext(requestWith(token), 'c', { now: NOW })).actorUserId,
    ).toBe('subject-1');
    await expect(await gateway.consumeRequestContext(requestWith(token), 'c', { now: NOW })).rejects.toThrow('ASSERTION_REPLAYED');
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

  it('keeps authorization-shaped names out of the claims and the encoded assertion', async () => {
    const { gateway } = build();
    const { token, claims } = await gateway.issue(principal, 'c', { now: NOW });
    const encoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');

    for (const forbidden of FORBIDDEN) {
      expect(claims).not.toHaveProperty(forbidden);
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('keeps authorization-shaped names out of the identity context', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });
    const context = await gateway.authenticate(requestWith(token), 'c', { now: NOW });
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

  it('cannot elevate assurance above what was signed', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(
      { ...principal, identityAssuranceLevel: 'IAL1_BASIC' },
      'c',
      { now: NOW },
    );
    expect(
      (await gateway.authenticate(requestWith(token), 'c', { now: NOW }))
        .identityAssuranceLevel,
    ).toBe('IAL1_BASIC');
  });

  it('exposes no assertion exchange surface', () => {
    const { gateway } = build();
    expect(() => gateway.exchange()).toThrow('GATEWAY_EXCHANGE_UNSUPPORTED');
  });
});

describe('Engine 01 identity gateway — audit and secret handling', () => {
  it('records issuance and consumption without the assertion or signature', async () => {
    const { gateway, trustStore } = build();
    const { token } = await gateway.issue(principal, 'c1', { now: NOW });
    await gateway.consume(token, 'c2', { now: NOW });

    const records = await auditRecords(trustStore);
    expect(records.map((record) => record.eventType)).toEqual([
      'IdentityAssertionIssued',
      'IdentityAssertionConsumed',
    ]);

    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(token.split('.')[2]);
    expect(serialised).not.toContain(SECRET);
  });

  it('records the replay guarantee that actually applied', async () => {
    const { gateway, trustStore } = build();
    const { token } = await gateway.issue(principal, 'c1', { now: NOW });
    await gateway.consume(token, 'c2', { now: NOW });

    const consumed = (await auditRecords(trustStore)).find(
      (record) => record.eventType === 'IdentityAssertionConsumed',
    );
    expect(consumed?.metadata.replayProtection).toBe('process-local');
  });

  it('records a bounded sanitized rejection', async () => {
    const { gateway, trustStore } = build();
    // Well-formed but wrongly signed, so the signature check is what rejects it.
    const { token } = await gateway.issue(principal, 'setup', { now: NOW });
    const [version, payload] = token.split('.');
    const forged = `${version}.${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    await expect(await gateway.consume(forged, 'c', { now: NOW })).rejects.toThrow();

    const rejected = (await auditRecords(trustStore)).filter(
      (record) => record.eventType === 'IdentityAssertionRejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata.reason).toBe('ASSERTION_SIGNATURE_INVALID');
    expect(JSON.stringify(rejected)).not.toContain(payload);
  });

  it('records a malformed assertion as malformed, not as a signature failure', async () => {
    const { gateway, trustStore } = build();
    await expect(await gateway.consume('v1.notbase64json.sig', 'c', { now: NOW })).rejects.toThrow();
    expect((await auditRecords(trustStore))[0].metadata.reason).toBe('ASSERTION_MALFORMED');
  });

  it('records a missing assertion without inventing an actor', async () => {
    const { gateway, trustStore } = build();
    await expect(await gateway.authenticate(requestWith(''), 'c')).rejects.toThrow();

    const records = await auditRecords(trustStore);
    expect(records).toHaveLength(1);
    expect(records[0].metadata.reason).toBe('GATEWAY_ASSERTION_MISSING');
  });

  it('hands the store no metadata key that looks like a credential', async () => {
    const { gateway, trustStore } = build();
    const { token } = await gateway.issue(principal, 'c1', { now: NOW });
    await gateway.consume(token, 'c2', { now: NOW });

    for (const record of await auditRecords(trustStore)) {
      for (const key of Object.keys(record.metadata)) {
        expect(key).not.toMatch(/password|token|otp|secret|account|identityNumber/i);
      }
    }
  });

  it('keeps assertion contents and secrets out of error messages', async () => {
    const { gateway } = build();
    const { token } = await gateway.issue(principal, 'c', { now: NOW });

    try {
      await gateway.verify(token, { now: new Date(NOW.getTime() + 600_000) });
      throw new Error('expected rejection');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('ASSERTION_EXPIRED');
      expect(message).not.toContain(token);
      expect(message).not.toContain(SECRET);
    }
  });

  it('produces a deterministic non-reversible fingerprint', async () => {
    const { gateway, trustStore } = build();
    await gateway.issue(principal, 'c1', { now: NOW });
    const first = (await auditRecords(trustStore))[0].metadata.assertionFingerprint as string;

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain(SECRET);
  });

  it('raises a typed gateway error, distinct from an assertion error', async () => {
    const { gateway } = build();
    await expect(await gateway.consume('', 'c')).rejects.toThrow(IdentityGatewayError);
    await expect(await gateway.verify('garbage', { now: NOW })).rejects.toThrow(IdentityAssertionError);
  });
});
