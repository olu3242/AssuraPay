import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TrustPersistence } from '@assurapay/shared';
import type { AuthenticationMethod, UserIdentity } from './index';
import { mintVerificationToken } from './verification';

export type LoginProofChallenge = AuthenticationMethod & {
  challengeExpiresAt: string;
};

export type IssuedLoginProof = {
  challengeId: string;
  proofToken: string;
  expiresAt: string;
};

const LOGIN_METHOD_TYPE = 'PASSWORDLESS_EMAIL_CHALLENGE';
const LOGIN_PROVIDER = 'assurapay-passwordless-email';
const DEFAULT_LOGIN_PROOF_TTL_MS = 10 * 60 * 1000;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function matches(presented: string, storedDigest: string): boolean {
  const candidate = Buffer.from(digest(presented), 'hex');
  const stored = Buffer.from(storedDigest, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * Engine 01 passwordless login possession proof.
 *
 * A browser may no longer exchange an email address directly for a session. It first
 * obtains a short-lived, single-use challenge, then presents the raw token that was
 * delivered to that address. Only the digest is persisted, using the existing
 * authenticationMethods collection so the proof remains inside the identity plane and
 * inherits its established RLS treatment.
 */
export class LoginProofService {
  constructor(private readonly store: TrustPersistence) {}

  async issue(input: {
    email: string;
    correlationId: string;
    ttlMs?: number;
  }): Promise<IssuedLoginProof> {
    const email = input.email.trim().toLowerCase();
    const user = (await this.store.list<UserIdentity>('identities')).find(
      (entry) => entry.email === email && entry.status === 'ACTIVE',
    );
    if (!user) throw new Error('AUTHENTICATION_DENIED');

    const proofToken = mintVerificationToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_LOGIN_PROOF_TTL_MS)).toISOString();
    const challenge: LoginProofChallenge = {
      id: randomUUID(),
      userId: user.id,
      methodType: LOGIN_METHOD_TYPE,
      provider: LOGIN_PROVIDER,
      providerSubjectReference: digest(proofToken),
      status: 'PENDING',
      challengeExpiresAt: expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.store.append('authenticationMethods', challenge);
    await this.store.audit({
      actorId: user.id,
      eventType: 'LoginProofIssued',
      aggregateType: 'AuthenticationMethod',
      aggregateId: challenge.id,
      correlationId: input.correlationId,
      metadata: { method: LOGIN_METHOD_TYPE },
    });

    return { challengeId: challenge.id, proofToken, expiresAt };
  }

  async consume(input: {
    email: string;
    challengeId: string;
    proofToken: string;
    correlationId: string;
  }): Promise<string> {
    const email = input.email.trim().toLowerCase();
    const user = (await this.store.list<UserIdentity>('identities')).find(
      (entry) => entry.email === email && entry.status === 'ACTIVE',
    );
    const challenge = (await this.store.list<LoginProofChallenge>('authenticationMethods')).find(
      (entry) =>
        entry.id === input.challengeId &&
        entry.userId === user?.id &&
        entry.methodType === LOGIN_METHOD_TYPE &&
        entry.provider === LOGIN_PROVIDER,
    );

    const denied = async (reason: string): Promise<never> => {
      await this.store.audit({
        actorId: user?.id ?? 'anonymous',
        eventType: 'AuthenticationFailed',
        aggregateType: 'AuthenticationMethod',
        aggregateId: challenge?.id ?? 'unknown',
        correlationId: input.correlationId,
        metadata: { reason },
      });
      throw new Error('AUTHENTICATION_DENIED');
    };

    if (!user || !challenge || challenge.status !== 'PENDING') return denied('LOGIN_PROOF_UNAVAILABLE');
    if (Date.parse(challenge.challengeExpiresAt) <= Date.now()) return denied('LOGIN_PROOF_EXPIRED');
    if (!matches(input.proofToken, challenge.providerSubjectReference)) return denied('LOGIN_PROOF_MISMATCH');

    const now = new Date().toISOString();
    const verified: LoginProofChallenge = {
      ...challenge,
      status: 'VERIFIED',
      verifiedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    };
    await this.store.replace('authenticationMethods', verified);
    await this.store.audit({
      actorId: user.id,
      eventType: 'LoginProofConsumed',
      aggregateType: 'AuthenticationMethod',
      aggregateId: verified.id,
      correlationId: input.correlationId,
      metadata: { method: LOGIN_METHOD_TYPE },
    });
    return verified.id;
  }
}
