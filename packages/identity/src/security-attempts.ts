import { createHash } from 'node:crypto';
import type { TrustPersistence } from '@assurapay/shared';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** Durable unique slots bound requests across processes; losing a slot race fails closed. */
export async function reserveIdentityAttempt(
  store: TrustPersistence,
  input: {
    subject: string;
    purpose: string;
    correlationId: string;
    limit?: number;
    windowMs?: number;
  },
): Promise<void> {
  const window = Math.floor(Date.now() / (input.windowMs ?? 60_000));
  const bucket = digest(JSON.stringify([input.subject, input.purpose, window]));
  const entries = await store.list<{ id: string; rateBucket?: string }>(
    'authenticationMethods',
  );
  const used = entries.filter((entry) => entry.rateBucket === bucket).length;
  try {
    if (used >= (input.limit ?? 5))
      throw new Error('AUTHENTICATION_RATE_LIMITED');
    const now = new Date().toISOString();
    await store.append('authenticationMethods', {
      id: digest(`${bucket}:${used}`),
      userId: input.subject,
      methodType: 'SECURITY_RATE_LIMIT',
      provider: 'assurapay-security',
      providerSubjectReference: bucket,
      rateBucket: bucket,
      status: 'REVOKED',
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code !== 'AUTHENTICATION_RATE_LIMITED' &&
      !code.includes('PERSISTENCE_DUPLICATE_RECORD')
    )
      throw error;
    await store.audit({
      actorId: 'anonymous',
      eventType: 'AuthenticationRateLimited',
      aggregateType: 'AuthenticationMethod',
      aggregateId: bucket,
      correlationId: input.correlationId,
      metadata: {
        purpose: input.purpose,
        reasonCode: 'AUTHENTICATION_RATE_LIMITED',
      },
    });
    throw new Error('AUTHENTICATION_RATE_LIMITED');
  }
}

export async function reserveProofConsumption(
  store: TrustPersistence,
  userId: string,
  reference: string,
): Promise<void> {
  const id = digest(`proof-consumption:${reference}`);
  if (
    (await store.list<{ id: string }>('authenticationMethods')).some(
      (entry) => entry.id === id,
    )
  )
    throw new Error('AUTHENTICATION_DENIED');
  const now = new Date().toISOString();
  await store.append('authenticationMethods', {
    id,
    userId,
    methodType: 'SECURITY_PROOF_CONSUMPTION',
    provider: 'assurapay-security',
    providerSubjectReference: digest(reference),
    status: 'REVOKED',
    createdAt: now,
    updatedAt: now,
  });
}
