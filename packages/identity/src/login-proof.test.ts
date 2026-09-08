import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService } from './index';
import { LoginProofService } from './login-proof';

async function activeIdentity(store: InMemoryTrustStore, email = 'owner@example.test') {
  const identity = new IdentityService(store);
  const registered = await identity.register({ email, displayName: 'Owner', correlationId: 'register' });
  await identity.verifyEmail({
    userId: registered.identity.id,
    token: registered.emailVerificationToken,
    correlationId: 'verify',
  });
  return { identity, user: registered.identity };
}

describe('passwordless login possession proof', () => {
  it('persists only the digest and consumes the proof once', async () => {
    const store = new InMemoryTrustStore();
    await activeIdentity(store);
    const proofs = new LoginProofService(store);
    const issued = await proofs.issue({ email: 'owner@example.test', correlationId: 'issue' });

    const persisted = JSON.stringify(await store.list('authenticationMethods'));
    expect(persisted).not.toContain(issued.proofToken);
    expect(persisted).toContain(issued.challengeId);

    const methodId = await proofs.consume({
      email: 'owner@example.test',
      challengeId: issued.challengeId,
      proofToken: issued.proofToken,
      correlationId: 'consume',
    });
    expect(methodId).toBe(issued.challengeId);

    await expect(
      proofs.consume({
        email: 'owner@example.test',
        challengeId: issued.challengeId,
        proofToken: issued.proofToken,
        correlationId: 'replay',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
  });

  it('refuses a wrong proof and an unknown address with the same public error', async () => {
    const store = new InMemoryTrustStore();
    await activeIdentity(store);
    const proofs = new LoginProofService(store);
    const issued = await proofs.issue({ email: 'owner@example.test', correlationId: 'issue' });

    await expect(
      proofs.consume({
        email: 'owner@example.test',
        challengeId: issued.challengeId,
        proofToken: 'wrong-proof',
        correlationId: 'wrong',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
    await expect(
      proofs.issue({ email: 'nobody@example.test', correlationId: 'unknown' }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
  });

  it('refuses an expired challenge', async () => {
    const store = new InMemoryTrustStore();
    await activeIdentity(store);
    const proofs = new LoginProofService(store);
    const issued = await proofs.issue({ email: 'owner@example.test', correlationId: 'issue', ttlMs: -1 });

    await expect(
      proofs.consume({
        email: 'owner@example.test',
        challengeId: issued.challengeId,
        proofToken: issued.proofToken,
        correlationId: 'expired',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
  });

  it('binds the verified authentication method to the resulting session', async () => {
    const store = new InMemoryTrustStore();
    const { identity } = await activeIdentity(store);
    const proofs = new LoginProofService(store);
    const issued = await proofs.issue({ email: 'owner@example.test', correlationId: 'issue' });
    const authenticationMethodId = await proofs.consume({
      email: 'owner@example.test',
      challengeId: issued.challengeId,
      proofToken: issued.proofToken,
      correlationId: 'consume',
    });

    const result = await identity.login({
      email: 'owner@example.test',
      rawSessionToken: 'raw-session-token',
      authenticationMethodId,
      correlationId: 'login',
    });
    expect(result.session.authenticationMethodId).toBe(authenticationMethodId);
  });
});
