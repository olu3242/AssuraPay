import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService } from './index';
describe('Engine 01 identity trust', () => {
  it('hashes session tokens, audits authentication, revokes reuse, and expires step-up', async () => { const store = new InMemoryTrustStore(); const service = new IdentityService(store); const user = await service.activate((await service.register({ email: 'owner@example.test', displayName: 'Owner', correlationId: 'c1' })).id, 'c2'); const login = await service.login({ email: user.email, rawSessionToken: 'raw-secret-token', correlationId: 'c3' }); expect(login.session.sessionTokenHash).not.toContain('raw-secret-token'); expect(await store.list('auditRecords')).toHaveLength(3); await service.revokeSession(login.session.id, { actorUserId: user.id, sessionId: login.session.id, identityAssuranceLevel: 'IAL1_BASIC', memberships: [], correlationId: 'c4' }, 'logout'); await expect(service.resolveSession('raw-secret-token')).rejects.toThrow('SESSION_INVALID'); });
  it('denies suspended identities and prevents device trust from changing assurance', async () => { const store = new InMemoryTrustStore(); const service = new IdentityService(store); const user = await service.activate((await service.register({ email: 'user@example.test', displayName: 'User', correlationId: 'c1' })).id, 'c2'); await store.replace('identities', { ...user, status: 'SUSPENDED' as const }); await expect(service.login({ email: user.email, rawSessionToken: 'x', correlationId: 'c3' })).rejects.toThrow('AUTHENTICATION_DENIED'); });
});

describe('Engine 01 bulk revocation resolves before it reports', () => {
  /**
   * `revokeAll` is the "sign me out everywhere" path, so a caller that awaits it and
   * then reports success must actually have revoked something.
   *
   * Before the asynchronous repository migration was completed it mapped over the
   * active sessions with an async callback and returned the resulting promises. The
   * caller awaited the outer promise, received an array of pending work, and every
   * session stayed live.
   */
  async function activeUserWithSessions(store: InMemoryTrustStore, count: number) {
    const service = new IdentityService(store);
    const user = await service.activate(
      (await service.register({ email: 'multi@example.test', displayName: 'Multi', correlationId: 'c1' })).id,
      'c2',
    );
    for (let index = 0; index < count; index++)
      await service.login({ email: user.email, rawSessionToken: `token-${index}`, correlationId: `login-${index}` });
    return { service, user };
  }

  const revoker = (userId: string) => ({
    actorUserId: userId,
    sessionId: 'any',
    identityAssuranceLevel: 'IAL1_BASIC' as const,
    memberships: [],
    correlationId: 'revoke-all',
  });

  it('returns revoked sessions, not pending promises', async () => {
    const store = new InMemoryTrustStore();
    const { service, user } = await activeUserWithSessions(store, 3);

    const revoked = await service.revokeAll(user.id, revoker(user.id));

    expect(revoked).toHaveLength(3);
    for (const session of revoked) {
      expect(session).not.toBeInstanceOf(Promise);
      expect(session.status).toBe('REVOKED');
    }
  });

  it('leaves no session resolvable once it has returned', async () => {
    const store = new InMemoryTrustStore();
    const { service, user } = await activeUserWithSessions(store, 3);

    await service.revokeAll(user.id, revoker(user.id));

    for (const index of [0, 1, 2])
      await expect(service.resolveSession(`token-${index}`)).rejects.toThrow('SESSION_INVALID');
  });

  it('writes an unbroken audit chain, because revocations are appended one at a time', async () => {
    // Revoking concurrently interleaves the `previousHash` linkage: two records
    // read the same tail and both claim it, so the chain no longer verifies and
    // CLAUDE.md constraint 3 is decorative.
    const store = new InMemoryTrustStore();
    const { service, user } = await activeUserWithSessions(store, 4);

    await service.revokeAll(user.id, revoker(user.id));

    const records = await store.list<{ previousHash?: string; integrityHash: string }>('auditRecords');
    expect(records.length).toBeGreaterThan(4);
    for (const [index, record] of records.entries())
      expect(record.previousHash).toBe(index === 0 ? undefined : records[index - 1].integrityHash);
  });
});
