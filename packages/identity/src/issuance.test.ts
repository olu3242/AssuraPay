import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { AssuranceLevel } from '@assurapay/shared';
import {
  AssertionIssuanceError,
  IdentityGateway,
  InMemoryAssertionReplayStore,
  issueAssertionForSession,
  verifyIdentityAssertion,
  type AssertionKeyring,
  type SessionResolver,
} from './index';

const KEYRING: AssertionKeyring = {
  activeKeyId: 'k1',
  keys: { k1: 'x'.repeat(48) },
};

const WORKSPACE = 'workspace-1';
const TENANT = 'tenant-1';
const USER = 'user-1';
const TOKEN = 'raw-session-token';
const NOW = new Date('2026-06-01T12:00:00.000Z');

function gatewayFor(store: InMemoryTrustStore, overrides = {}) {
  return new IdentityGateway(store, KEYRING, new InMemoryAssertionReplayStore(), {
    issuer: 'assurapay-web',
    audience: 'assurapay-api',
    assertionTtlMs: 120_000,
    requireDistributedReplayProtection: false,
    ...overrides,
  });
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    userId: USER,
    identityAssuranceLevel: 'IAL2_VERIFIED' as AssuranceLevel,
    // Eight hours out, so the configured TTL is the binding constraint by default.
    expiresAt: '2026-06-01T20:00:00.000Z',
    status: 'ACTIVE',
    ...overrides,
  };
}

function resolver(record: ReturnType<typeof session> | null): SessionResolver {
  return {
    resolveSession(rawToken: string) {
      if (!record || rawToken !== TOKEN) throw new Error('SESSION_INVALID');
      return record;
    },
  };
}

function workspaceStore(options: { member?: boolean; status?: string } = {}) {
  const store = new InMemoryTrustStore();
  store.append('trustWorkspaces', {
    id: WORKSPACE,
    tenantId: TENANT,
    status: options.status ?? 'ACTIVE',
  });
  if (options.member !== false) {
    store.append('memberships', {
      id: 'm-1',
      workspaceId: WORKSPACE,
      userId: USER,
      status: 'ACTIVE',
    });
  }
  return store;
}

function issue(
  store: InMemoryTrustStore,
  record: ReturnType<typeof session> | null,
  input: Record<string, unknown> = {},
) {
  return issueAssertionForSession(gatewayFor(store), resolver(record), store, {
    rawSessionToken: TOKEN,
    correlationId: 'corr-1',
    now: NOW,
    ...input,
  });
}

describe('Engine 01 assertion issuance — the session is the only source of identity', () => {
  it('issues an assertion the gateway itself accepts', () => {
    // Round-trip rather than field inspection: an assertion this package produces
    // that its own verifier rejects would be useless however well-formed it looks.
    const store = workspaceStore();
    const issued = issue(store, session(), { workspaceId: WORKSPACE });

    const claims = verifyIdentityAssertion(issued.token, KEYRING, {
      expectedIssuer: 'assurapay-web',
      expectedAudience: 'assurapay-api',
      now: NOW,
    });
    expect(claims.subject).toBe(USER);
    expect(claims.sessionId).toBe('session-1');
  });

  it('copies subject, session and assurance from the stored session', () => {
    const store = workspaceStore();
    const issued = issue(store, session({ identityAssuranceLevel: 'IAL1_BASIC' }));

    expect(issued.claims.subject).toBe(USER);
    expect(issued.claims.sessionId).toBe('session-1');
    expect(issued.claims.identityAssuranceLevel).toBe('IAL1_BASIC');
  });

  it('takes no identity field from the caller', () => {
    // The input type has no subject or assurance field; passing them changes
    // nothing, which is what makes issuance incapable of impersonation.
    const store = workspaceStore();
    const issued = issue(store, session(), {
      subject: 'someone-else',
      identityAssuranceLevel: 'IAL3_HIGH_ASSURANCE',
      sessionId: 'session-9',
    });

    expect(issued.claims.subject).toBe(USER);
    expect(issued.claims.identityAssuranceLevel).toBe('IAL2_VERIFIED');
    expect(issued.claims.sessionId).toBe('session-1');
  });

  it('carries no roles, permissions or memberships', () => {
    const store = workspaceStore();
    const claims = issue(store, session(), { workspaceId: WORKSPACE }).claims as Record<
      string,
      unknown
    >;

    for (const forbidden of ['roles', 'permissions', 'memberships', 'grants', 'scopes']) {
      expect(Object.keys(claims)).not.toContain(forbidden);
    }
  });

  it('refuses an unknown, revoked or expired session without saying which', () => {
    const store = workspaceStore();
    expect(() => issue(store, null)).toThrow('ISSUANCE_SESSION_INVALID');
    expect(() => issue(store, null)).toThrow(AssertionIssuanceError);
  });

  it('writes nothing when the session is refused', () => {
    const store = workspaceStore();
    expect(() => issue(store, null)).toThrow(AssertionIssuanceError);
    expect(store.list('auditRecords')).toEqual([]);
  });
});

describe('Engine 01 assertion issuance — never outlives the session', () => {
  it('uses the configured TTL when the session outlasts it', () => {
    const store = workspaceStore();
    const issued = issue(store, session());

    expect(issued.expiresAt).toBe('2026-06-01T12:02:00.000Z');
    expect(issued.boundedBySession).toBe(false);
  });

  it('cuts the assertion short when the session expires first', () => {
    // Otherwise a token minted seconds before a session ends would outlive it, and
    // revoking the session would not revoke what it authorized.
    const store = workspaceStore();
    const issued = issue(
      store,
      session({ expiresAt: '2026-06-01T12:00:30.000Z' }),
    );

    expect(issued.expiresAt).toBe('2026-06-01T12:00:30.000Z');
    expect(issued.boundedBySession).toBe(true);
    expect(issued.claims.expiresAt).toBe('2026-06-01T12:00:30.000Z');
  });

  it('refuses a session that has already expired', () => {
    const store = workspaceStore();
    expect(() =>
      issue(store, session({ expiresAt: '2026-06-01T11:59:59.000Z' })),
    ).toThrow('ISSUANCE_SESSION_EXPIRED');
  });

  it('refuses a session whose expiry is unparseable rather than treating it as valid', () => {
    const store = workspaceStore();
    expect(() => issue(store, session({ expiresAt: 'whenever' }))).toThrow(
      'ISSUANCE_SESSION_EXPIRED',
    );
  });
});

describe('Engine 01 assertion issuance — workspace selection requires membership', () => {
  it('names a workspace the caller is an active member of', () => {
    const store = workspaceStore();
    const issued = issue(store, session(), { workspaceId: WORKSPACE });

    expect(issued.claims.workspaceId).toBe(WORKSPACE);
    expect(issued.claims.tenantId).toBe(TENANT);
  });

  it('refuses a workspace the caller is not a member of', () => {
    const store = workspaceStore({ member: false });
    expect(() => issue(store, session(), { workspaceId: WORKSPACE })).toThrow(
      'ISSUANCE_WORKSPACE_FORBIDDEN',
    );
  });

  it('refuses a workspace that does not exist or is not active', () => {
    expect(() =>
      issue(workspaceStore(), session(), { workspaceId: 'workspace-9' }),
    ).toThrow('ISSUANCE_WORKSPACE_UNKNOWN');
    expect(() =>
      issue(workspaceStore({ status: 'ARCHIVED' }), session(), { workspaceId: WORKSPACE }),
    ).toThrow('ISSUANCE_WORKSPACE_UNKNOWN');
  });

  it('checks membership for the session default too, not only an explicit request', () => {
    // A stale session.workspaceId would otherwise bypass the check that an explicit
    // request is subject to.
    const store = workspaceStore({ member: false });
    expect(() => issue(store, session({ workspaceId: WORKSPACE }))).toThrow(
      'ISSUANCE_WORKSPACE_FORBIDDEN',
    );
  });

  it('issues without a workspace when none is selected', () => {
    // Valid and useful: an identity-class route is how a caller with no workspace
    // yet discovers its memberships.
    const issued = issue(workspaceStore(), session());
    expect(issued.claims.workspaceId).toBeUndefined();
    expect(issued.claims.tenantId).toBeUndefined();
  });
});

describe('Engine 01 assertion issuance — assurance is never amplified', () => {
  it('refuses to issue below a required assurance level', () => {
    const store = workspaceStore();
    expect(() =>
      issue(store, session({ identityAssuranceLevel: 'IAL1_BASIC' }), {
        minimumAssuranceLevel: 'IAL2_VERIFIED',
      }),
    ).toThrow('ISSUANCE_ASSURANCE_INSUFFICIENT');
  });

  it('issues at the session level when it meets or exceeds the minimum', () => {
    const store = workspaceStore();
    for (const level of ['IAL2_VERIFIED', 'IAL3_HIGH_ASSURANCE'] as const) {
      const issued = issue(store, session({ identityAssuranceLevel: level }), {
        minimumAssuranceLevel: 'IAL2_VERIFIED',
      });
      expect(issued.claims.identityAssuranceLevel).toBe(level);
    }
  });

  it('never raises the level to meet the minimum', () => {
    const store = workspaceStore();
    const issued = issue(store, session({ identityAssuranceLevel: 'IAL2_VERIFIED' }), {
      minimumAssuranceLevel: 'IAL0_UNVERIFIED',
    });
    expect(issued.claims.identityAssuranceLevel).toBe('IAL2_VERIFIED');
  });
});

describe('Engine 01 assertion issuance — audit', () => {
  it('records the session binding as its own event, not a second mint record', () => {
    const store = workspaceStore();
    issue(store, session(), { workspaceId: WORKSPACE, purpose: 'release' });

    const records = store
      .list<{ eventType: string; aggregateId: string; metadata: Record<string, unknown> }>(
        'auditRecords',
      )
      .filter((record) => record.eventType === 'SessionAssertionIssued');

    expect(records).toHaveLength(1);
    expect(records[0].aggregateId).toBe('session-1');
    expect(records[0].metadata).toMatchObject({
      purpose: 'release',
      workspaceId: WORKSPACE,
      assurance: 'IAL2_VERIFIED',
    });
  });

  it('never records the token or its signature', () => {
    const store = workspaceStore();
    const issued = issue(store, session(), { workspaceId: WORKSPACE });
    const serialised = JSON.stringify(store.list('auditRecords'));

    expect(serialised).not.toContain(issued.token);
    for (const segment of issued.token.split('.')) {
      if (segment.length > 8) expect(serialised).not.toContain(segment);
    }
  });

  it('records the nonce, which identifies the assertion without being one', () => {
    const store = workspaceStore();
    const issued = issue(store, session());
    const record = store
      .list<{ eventType: string; metadata: Record<string, unknown> }>('auditRecords')
      .find((entry) => entry.eventType === 'SessionAssertionIssued');

    expect(record?.metadata.nonce).toBe(issued.claims.nonce);
    expect(record?.metadata.keyId).toBe('k1');
  });

  it('issues a distinct assertion each time, so one is never reused', () => {
    const store = workspaceStore();
    const first = issue(store, session());
    const second = issue(store, session());

    expect(first.claims.nonce).not.toBe(second.claims.nonce);
    expect(first.token).not.toBe(second.token);
  });
});
