import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService, LoginProofService } from './index';
import { reserveIdentityAttempt } from './security-attempts';

describe('durable authentication attempt budget', () => {
  it('persists a shared budget across service instances and audits exhaustion', async () => {
    const store = new InMemoryTrustStore();
    for (let index = 0; index < 5; index++)
      await reserveIdentityAttempt(store, {
        subject: 'user',
        purpose: 'LOGIN',
        correlationId: 'allowed',
      });
    await expect(
      reserveIdentityAttempt(store, {
        subject: 'user',
        purpose: 'LOGIN',
        correlationId: 'limited',
      }),
    ).rejects.toThrow('AUTHENTICATION_RATE_LIMITED');
    expect(await store.list('auditRecords')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'AuthenticationRateLimited',
          correlationId: 'limited',
        }),
      ]),
    );
  });
  it('binds login proofs to one identity and one purpose', async () => {
    const store = new InMemoryTrustStore();
    const identity = new IdentityService(store);
    const a = await identity.register({
      email: 'a@example.test',
      displayName: 'A',
      correlationId: 'a',
    });
    const b = await identity.register({
      email: 'b@example.test',
      displayName: 'B',
      correlationId: 'b',
    });
    await expect(
      identity.verifyEmail({
        userId: b.identity.id,
        token: a.emailVerificationToken,
        correlationId: 'cross',
      }),
    ).rejects.toThrow('VERIFICATION_DENIED');
    await identity.verifyEmail({
      userId: a.identity.id,
      token: a.emailVerificationToken,
      correlationId: 'verify-a',
    });
    await identity.verifyEmail({
      userId: b.identity.id,
      token: b.emailVerificationToken,
      correlationId: 'verify-b',
    });
    const proofs = new LoginProofService(store);
    const issued = await proofs.issue({
      email: a.identity.email,
      correlationId: 'issue',
    });
    await expect(
      proofs.consume({
        email: b.identity.email,
        ...issued,
        correlationId: 'cross-login',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
    await expect(
      proofs.consume({
        email: a.identity.email,
        ...issued,
        proofToken: a.emailVerificationToken,
        correlationId: 'wrong-purpose',
      }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
    expect(await store.list('sessions')).toHaveLength(0);
  });
});
