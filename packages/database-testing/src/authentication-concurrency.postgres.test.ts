import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresTrustStore } from '@assurapay/database';
import { IdentityService, LoginProofService } from '@assurapay/identity';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

requireTestDatabaseUrl();
let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase({ applyRls: true });
});
afterAll(async () => {
  await database?.dispose();
});

describe('integration: durable possession proofs are single use under concurrency', () => {
  it('allows one verification, one proof consumption and one session across competing callers', async () => {
    const store = new PostgresTrustStore(database.sql);
    const identity = new IdentityService(store);
    const email = `${randomUUID()}@example.test`;
    const registered = await identity.register({
      email,
      displayName: 'Concurrency test',
      correlationId: 'register',
    });
    const verified = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) =>
        identity.verifyEmail({
          userId: registered.identity.id,
          token: registered.emailVerificationToken,
          correlationId: `verify-${index}`,
        }),
      ),
    );
    expect(
      verified.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const proofs = new LoginProofService(store);
    const challenge = await proofs.issue({ email, correlationId: 'issue' });
    const consumed = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) =>
        proofs.consume({
          email,
          challengeId: challenge.challengeId,
          proofToken: challenge.proofToken,
          correlationId: `consume-${index}`,
        }),
      ),
    );
    expect(
      consumed.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const sessions = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) =>
        identity.login({
          email,
          authenticationMethodId: challenge.challengeId,
          rawSessionToken: `random-session-${randomUUID()}`,
          correlationId: `session-${index}`,
        }),
      ),
    );
    expect(
      sessions.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const stored = await store.list<{ userId: string }>('sessions');
    expect(
      stored.filter((session) => session.userId === registered.identity.id),
    ).toHaveLength(1);
    const persisted = JSON.stringify(await store.list('authenticationMethods'));
    expect(persisted).not.toContain(challenge.proofToken);
    expect(persisted).not.toContain(registered.emailVerificationToken);
  });
});
