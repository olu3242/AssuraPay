import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService, LoginProofService } from './index';

async function fixture() {
  const store = new InMemoryTrustStore();
  const identity = new IdentityService(store);
  const registered = await identity.register({
    email: 'owner@example.test',
    displayName: 'Owner',
    correlationId: 'register',
  });
  await identity.verifyEmail({
    userId: registered.identity.id,
    token: registered.emailVerificationToken,
    correlationId: 'verify',
  });
  const proofs = new LoginProofService(store);
  const issued = await proofs.issue({
    email: registered.identity.email,
    correlationId: 'issue',
  });
  return { store, identity, proofs, issued, email: registered.identity.email };
}

describe('canonical session issuance requires possession', () => {
  it('refuses an active address alone and audits the refusal', async () => {
    const { store, identity, email } = await fixture();
    await expect(
      identity.login({
        email,
        rawSessionToken: 'session-secret',
        correlationId: 'denied',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
    expect(await store.list('sessions')).toHaveLength(0);
    expect(await store.list('auditRecords')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'AuthenticationFailed',
          correlationId: 'denied',
        }),
      ]),
    );
  });
  it('refuses an unconsumed challenge identifier', async () => {
    const { identity, issued, email } = await fixture();
    await expect(
      identity.login({
        email,
        authenticationMethodId: issued.challengeId,
        rawSessionToken: 'session-secret',
        correlationId: 'denied',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
  });
  it('permits one session and refuses reuse of its consumed proof', async () => {
    const { identity, proofs, issued, email, store } = await fixture();
    const authenticationMethodId = await proofs.consume({
      email,
      ...issued,
      correlationId: 'consume',
    });
    await identity.login({
      email,
      authenticationMethodId,
      rawSessionToken: 'first-secret',
      correlationId: 'first',
    });
    await expect(
      identity.login({
        email,
        authenticationMethodId,
        rawSessionToken: 'second-secret',
        correlationId: 'replay',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
    expect(await store.list('sessions')).toHaveLength(1);
    expect(JSON.stringify(await store.list('sessions'))).not.toContain(
      'first-secret',
    );
    expect(
      (await identity.resolveSession('first-secret')).authenticationMethodId,
    ).toBe(authenticationMethodId);
  });
});
