import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  IdentityAssertionError,
  IdentityAssertionService,
  InMemoryAssertionReplayGuard,
  assuranceAtLeast,
  consumeIdentityAssertion,
  createIdentityAssertion,
  fingerprint,
  loadAssertionKeyring,
  verifyIdentityAssertion,
  type AssertionKeyring,
} from './index';

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);

const keyring: AssertionKeyring = {
  activeKeyId: 'key-2026-08',
  keys: { 'key-2026-08': SECRET_A },
};

const rotated: AssertionKeyring = {
  activeKeyId: 'key-2026-09',
  keys: { 'key-2026-08': SECRET_A, 'key-2026-09': SECRET_B },
};

const NOW = new Date('2026-08-04T12:00:00.000Z');

const subject = {
  subject: 'subject-neutral-1',
  sessionId: 'session-1',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  workspaceId: 'workspace-1',
  tenantId: 'tenant-1',
  now: NOW,
};

function tamper(token: string, replacement: Record<string, unknown>): string {
  const [version, , signature] = token.split('.');
  const payload = Buffer.from(JSON.stringify(replacement), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${version}.${payload}.${signature}`;
}

describe('Engine 01 identity assertions — issue and verify', () => {
  it('round-trips the claims authentication established', () => {
    const { token, claims } = createIdentityAssertion(subject, keyring);
    const verified = verifyIdentityAssertion(token, keyring, { now: NOW });

    expect(verified).toEqual(claims);
    expect(verified.subject).toBe('subject-neutral-1');
    expect(verified.identityAssuranceLevel).toBe('IAL2_VERIFIED');
    expect(verified.workspaceId).toBe('workspace-1');
    expect(verified.keyId).toBe('key-2026-08');
  });

  it('carries no authorization data, because authentication never implies it', () => {
    const { claims, token } = createIdentityAssertion(subject, keyring);
    const encoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');

    for (const forbidden of [
      'roles',
      'role',
      'permissions',
      'memberships',
      'scopes',
      'grants',
    ]) {
      expect(claims).not.toHaveProperty(forbidden);
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('never embeds the signing secret in the token', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    expect(token).not.toContain(SECRET_A);
  });

  it('issues a distinct nonce per assertion, so two are never interchangeable', () => {
    const first = createIdentityAssertion(subject, keyring);
    const second = createIdentityAssertion(subject, keyring);
    expect(first.claims.nonce).not.toBe(second.claims.nonce);
    expect(first.token).not.toBe(second.token);
  });

  it('defaults to a short validity window', () => {
    const { claims } = createIdentityAssertion(subject, keyring);
    const ttl = Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt);
    expect(ttl).toBe(120_000);
  });

  it('rejects an assertion with no subject or session', () => {
    expect(() => createIdentityAssertion({ ...subject, subject: '  ' }, keyring)).toThrow(
      'ASSERTION_SUBJECT_REQUIRED',
    );
    expect(() =>
      createIdentityAssertion({ ...subject, sessionId: '' }, keyring),
    ).toThrow('ASSERTION_SESSION_REQUIRED');
  });
});

describe('Engine 01 identity assertions — signature integrity', () => {
  it('rejects a payload edited after signing', () => {
    const { token, claims } = createIdentityAssertion(subject, keyring);
    const escalated = tamper(token, {
      ...claims,
      identityAssuranceLevel: 'IAL3_HIGH_ASSURANCE',
    });

    expect(() => verifyIdentityAssertion(escalated, keyring, { now: NOW })).toThrow(
      'ASSERTION_SIGNATURE_INVALID',
    );
  });

  it('rejects a swapped subject', () => {
    const { token, claims } = createIdentityAssertion(subject, keyring);
    const impersonation = tamper(token, { ...claims, subject: 'subject-neutral-2' });
    expect(() => verifyIdentityAssertion(impersonation, keyring, { now: NOW })).toThrow(
      'ASSERTION_SIGNATURE_INVALID',
    );
  });

  it('rejects a truncated or padded signature without throwing on length', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    const [version, payload, signature] = token.split('.');

    expect(() =>
      verifyIdentityAssertion(`${version}.${payload}.${signature.slice(0, -2)}`, keyring, {
        now: NOW,
      }),
    ).toThrow('ASSERTION_SIGNATURE_INVALID');

    expect(() =>
      verifyIdentityAssertion(`${version}.${payload}.${signature}AA`, keyring, {
        now: NOW,
      }),
    ).toThrow('ASSERTION_SIGNATURE_INVALID');
  });

  it('rejects an assertion signed with a different key', () => {
    const foreign: AssertionKeyring = {
      activeKeyId: 'key-2026-08',
      keys: { 'key-2026-08': SECRET_B },
    };
    const { token } = createIdentityAssertion(subject, foreign);
    expect(() => verifyIdentityAssertion(token, keyring, { now: NOW })).toThrow(
      'ASSERTION_SIGNATURE_INVALID',
    );
  });

  it('rejects a keyId the verifier does not hold', () => {
    const { token } = createIdentityAssertion(subject, rotated);
    expect(() => verifyIdentityAssertion(token, keyring, { now: NOW })).toThrow(
      'ASSERTION_UNKNOWN_KEY',
    );
  });

  it('rejects malformed tokens', () => {
    for (const malformed of ['', 'not-a-token', 'v1.only-two', 'v1..sig', 'v1.a.']) {
      expect(() => verifyIdentityAssertion(malformed, keyring, { now: NOW })).toThrow(
        IdentityAssertionError,
      );
    }
  });

  it('rejects an unsupported version prefix', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    const [, payload, signature] = token.split('.');
    expect(() =>
      verifyIdentityAssertion(`v2.${payload}.${signature}`, keyring, { now: NOW }),
    ).toThrow('ASSERTION_UNSUPPORTED_VERSION');
  });

  it('rejects a secret too short to resist offline attack', () => {
    const weak: AssertionKeyring = { activeKeyId: 'weak', keys: { weak: 'short' } };
    expect(() => createIdentityAssertion(subject, weak)).toThrow(
      'ASSERTION_SECRET_TOO_WEAK',
    );
  });
});

describe('Engine 01 identity assertions — key rotation', () => {
  it('verifies an assertion signed by a retired key that is still held', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    expect(verifyIdentityAssertion(token, rotated, { now: NOW }).keyId).toBe(
      'key-2026-08',
    );
  });

  it('signs new assertions with the active key', () => {
    expect(createIdentityAssertion(subject, rotated).claims.keyId).toBe('key-2026-09');
  });

  it('stops verifying once the old key is removed from the keyring', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    const retired: AssertionKeyring = {
      activeKeyId: 'key-2026-09',
      keys: { 'key-2026-09': SECRET_B },
    };
    expect(() => verifyIdentityAssertion(token, retired, { now: NOW })).toThrow(
      'ASSERTION_UNKNOWN_KEY',
    );
  });
});

describe('Engine 01 identity assertions — validity window', () => {
  it('rejects an expired assertion', () => {
    const { token } = createIdentityAssertion({ ...subject, ttlMs: 1_000 }, keyring);
    const later = new Date(NOW.getTime() + 1_001);
    expect(() => verifyIdentityAssertion(token, keyring, { now: later })).toThrow(
      'ASSERTION_EXPIRED',
    );
  });

  it('accepts an assertion on the last millisecond of its window', () => {
    const { token } = createIdentityAssertion({ ...subject, ttlMs: 1_000 }, keyring);
    const edge = new Date(NOW.getTime() + 999);
    expect(verifyIdentityAssertion(token, keyring, { now: edge }).sessionId).toBe(
      'session-1',
    );
  });

  it('rejects an assertion issued in the future', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    const earlier = new Date(NOW.getTime() - 5_000);
    expect(() => verifyIdentityAssertion(token, keyring, { now: earlier })).toThrow(
      'ASSERTION_NOT_YET_VALID',
    );
  });

  it('absorbs clock skew within the stated tolerance', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    const earlier = new Date(NOW.getTime() - 5_000);
    expect(
      verifyIdentityAssertion(token, keyring, {
        now: earlier,
        clockToleranceMs: 10_000,
      }).subject,
    ).toBe('subject-neutral-1');
  });

  it('rejects unparseable timestamps', () => {
    const { token, claims } = createIdentityAssertion(subject, keyring);
    const broken = tamper(token, { ...claims, expiresAt: 'not-a-date' });
    expect(() => verifyIdentityAssertion(broken, keyring, { now: NOW })).toThrow(
      IdentityAssertionError,
    );
  });
});

describe('Engine 01 identity assertions — assurance floor', () => {
  it('orders assurance levels weakest to strongest', () => {
    expect(assuranceAtLeast('IAL2_VERIFIED', 'IAL1_BASIC')).toBe(true);
    expect(assuranceAtLeast('IAL1_BASIC', 'IAL2_VERIFIED')).toBe(false);
    expect(assuranceAtLeast('IAL2_VERIFIED', 'IAL2_VERIFIED')).toBe(true);
  });

  it('rejects an assertion below the required level', () => {
    const { token } = createIdentityAssertion(
      { ...subject, identityAssuranceLevel: 'IAL1_BASIC' },
      keyring,
    );
    expect(() =>
      verifyIdentityAssertion(token, keyring, {
        now: NOW,
        minimumAssuranceLevel: 'IAL2_VERIFIED',
      }),
    ).toThrow('ASSERTION_ASSURANCE_INSUFFICIENT');
  });

  it('accepts an assertion that meets the required level', () => {
    const { token } = createIdentityAssertion(subject, keyring);
    expect(
      verifyIdentityAssertion(token, keyring, {
        now: NOW,
        minimumAssuranceLevel: 'IAL2_VERIFIED',
      }).identityAssuranceLevel,
    ).toBe('IAL2_VERIFIED');
  });
});

describe('Engine 01 identity assertions — replay resistance', () => {
  it('accepts an assertion once and rejects the same one again', () => {
    const guard = new InMemoryAssertionReplayGuard();
    const { token } = createIdentityAssertion(subject, keyring);

    expect(consumeIdentityAssertion(token, keyring, guard, { now: NOW }).nonce).toBeDefined();
    expect(() => consumeIdentityAssertion(token, keyring, guard, { now: NOW })).toThrow(
      'ASSERTION_REPLAYED',
    );
  });

  it('treats two assertions for the same session as independent', () => {
    const guard = new InMemoryAssertionReplayGuard();
    const first = createIdentityAssertion(subject, keyring);
    const second = createIdentityAssertion(subject, keyring);

    expect(() => consumeIdentityAssertion(first.token, keyring, guard, { now: NOW })).not.toThrow();
    expect(() => consumeIdentityAssertion(second.token, keyring, guard, { now: NOW })).not.toThrow();
  });

  it('prunes consumed nonces once they expire, so the guard stays bounded', () => {
    const guard = new InMemoryAssertionReplayGuard();
    guard.consume('nonce-expired', new Date(NOW.getTime() - 1_000).toISOString(), NOW);
    guard.consume('nonce-live', new Date(NOW.getTime() + 60_000).toISOString(), NOW);
    expect(guard.sizeAt(NOW)).toBe(1);
  });

  it('prunes on the verifier clock, not wall-clock', () => {
    // A guard pruning on its own clock would drop a nonce the verifier still
    // considers live, silently re-admitting the replay it exists to stop.
    const guard = new InMemoryAssertionReplayGuard();
    const { token } = createIdentityAssertion(subject, keyring);

    consumeIdentityAssertion(token, keyring, guard, { now: NOW });
    expect(() => consumeIdentityAssertion(token, keyring, guard, { now: NOW })).toThrow(
      'ASSERTION_REPLAYED',
    );
  });

  it('verifies without consuming, so inspection cannot burn an assertion', () => {
    const guard = new InMemoryAssertionReplayGuard();
    const { token } = createIdentityAssertion(subject, keyring);

    verifyIdentityAssertion(token, keyring, { now: NOW });
    verifyIdentityAssertion(token, keyring, { now: NOW });
    expect(() => consumeIdentityAssertion(token, keyring, guard, { now: NOW })).not.toThrow();
  });
});

describe('Engine 01 identity assertions — configuration', () => {
  it('builds a keyring from configuration', () => {
    const loaded = loadAssertionKeyring({
      IDENTITY_ASSERTION_ACTIVE_KEY_ID: 'key-b',
      IDENTITY_ASSERTION_KEYS: `key-a:${SECRET_A},key-b:${SECRET_B}`,
    });
    expect(loaded.activeKeyId).toBe('key-b');
    expect(Object.keys(loaded.keys).sort()).toEqual(['key-a', 'key-b']);
  });

  it('fails closed when unconfigured rather than signing with a default', () => {
    expect(() => loadAssertionKeyring({})).toThrow('ASSERTION_KEYRING_REQUIRED');
    expect(() =>
      loadAssertionKeyring({ IDENTITY_ASSERTION_KEYS: `key-a:${SECRET_A}` }),
    ).toThrow('ASSERTION_KEYRING_REQUIRED');
  });

  it('rejects an active key id absent from the keyring', () => {
    expect(() =>
      loadAssertionKeyring({
        IDENTITY_ASSERTION_ACTIVE_KEY_ID: 'missing',
        IDENTITY_ASSERTION_KEYS: `key-a:${SECRET_A}`,
      }),
    ).toThrow('ASSERTION_ACTIVE_KEY_UNKNOWN');
  });

  it('rejects a configured secret that is too weak', () => {
    expect(() =>
      loadAssertionKeyring({
        IDENTITY_ASSERTION_ACTIVE_KEY_ID: 'key-a',
        IDENTITY_ASSERTION_KEYS: 'key-a:tooshort',
      }),
    ).toThrow('ASSERTION_SECRET_TOO_WEAK');
  });
});

describe('Engine 01 identity assertions — audit trail', () => {
  it('audits issuance and acceptance without recording the token', () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityAssertionService(store, keyring);

    const { token } = service.issue(subject, 'correlation-1');
    service.consume(token, 'correlation-2', { now: NOW });

    const records = store.list<{ eventType: string; metadata: Record<string, unknown> }>(
      'auditRecords',
    );
    expect(records.map((record) => record.eventType)).toEqual([
      'IdentityAssertionIssued',
      'IdentityAssertionAccepted',
    ]);

    // The whole token never reaches the trail; a non-reversible reference does.
    expect(JSON.stringify(records)).not.toContain(token);
    expect(records[0].metadata.assertionFingerprint).toBe(fingerprint(token));
    expect(records[0].metadata.keyId).toBe('key-2026-08');
  });

  it('hands the store no metadata key that looks like a credential', () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityAssertionService(store, keyring);
    const { token } = service.issue(subject, 'correlation-8');
    service.consume(token, 'correlation-9', { now: NOW });

    const records = store.list<{ metadata: Record<string, unknown> }>('auditRecords');
    for (const record of records) {
      for (const key of Object.keys(record.metadata)) {
        expect(key).not.toMatch(/password|token|otp|secret|account|identityNumber/i);
      }
    }
  });

  it('audits a rejection with its stable reason code and rethrows', () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityAssertionService(store, keyring);

    expect(() => service.consume('v1.tampered.signature', 'correlation-3')).toThrow(
      IdentityAssertionError,
    );

    const records = store.list<{ eventType: string; metadata: Record<string, unknown> }>(
      'auditRecords',
    );
    expect(records).toHaveLength(1);
    expect(records[0].eventType).toBe('IdentityAssertionRejected');
    expect(records[0].metadata.reason).toBe('ASSERTION_MALFORMED');
    expect(records[0].metadata.assertionFingerprint).toBe(
      fingerprint('v1.tampered.signature'),
    );
  });

  it('audits a replay attempt as a rejection', () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityAssertionService(store, keyring);
    const { token } = service.issue(subject, 'correlation-4');

    service.consume(token, 'correlation-5', { now: NOW });
    expect(() => service.consume(token, 'correlation-6', { now: NOW })).toThrow(
      'ASSERTION_REPLAYED',
    );

    const rejected = store
      .list<{ eventType: string; metadata: Record<string, unknown> }>('auditRecords')
      .filter((record) => record.eventType === 'IdentityAssertionRejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata.reason).toBe('ASSERTION_REPLAYED');
  });

  it('emits an outbox event carrying no credential material', () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityAssertionService(store, keyring);
    const { token } = service.issue(subject, 'correlation-7');

    const events = store.list<{ eventType: string; payload: Record<string, unknown> }>(
      'outboxEvents',
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('IdentityAssertionIssued');
    expect(JSON.stringify(events[0].payload)).not.toContain(token);
  });
});
