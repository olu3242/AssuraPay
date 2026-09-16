import { describe, expect, it, vi } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  DeterministicEmailProvider,
  EmailDeliveryError,
  NotificationService,
  ResendEmailProvider,
} from './index';
const input = {
  purpose: 'LOGIN' as const,
  userId: 'user',
  recipient: 'user@example.test',
  subject: 'Sign in',
  text: 'sensitive-code-for-test',
  idempotencyKey: 'challenge',
  correlationId: 'correlation',
};

describe('notification delivery contract', () => {
  it('persists redacted metadata, reuses accepted delivery, and audits correlation', async () => {
    const store = new InMemoryTrustStore();
    const provider = new DeterministicEmailProvider();
    const service = new NotificationService(store, provider);
    const first = await service.deliver(input);
    expect(await service.deliver(input)).toEqual(first);
    expect(provider.messages).toHaveLength(1);
    expect(first.status).toBe('ACCEPTED');
    expect(
      JSON.stringify(await store.list('notificationDeliveries')),
    ).not.toContain(input.text);
    expect(
      JSON.stringify(await store.list('notificationDeliveries')),
    ).not.toContain(input.recipient);
    expect(await store.list('auditRecords')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'NotificationAccepted',
          correlationId: 'correlation',
        }),
      ]),
    );
  });
  it('rejects reuse with different content and unscoped business notifications', async () => {
    const service = new NotificationService(
      new InMemoryTrustStore(),
      new DeterministicEmailProvider(),
    );
    await service.deliver(input);
    await expect(
      service.deliver({ ...input, text: 'different' }),
    ).rejects.toThrow('NOTIFICATION_IDEMPOTENCY_CONFLICT');
    await expect(
      service.deliver({ ...input, purpose: 'PAYMENT_APPROVAL' }),
    ).rejects.toThrow('NOTIFICATION_SCOPE_REQUIRED');
  });
  it('bounds retries and exposes failure without altering the business aggregate', async () => {
    const store = new InMemoryTrustStore();
    await store.append('identities', {
      id: 'user',
      status: 'PENDING_VERIFICATION',
    });
    const send = vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError('NOTIFICATION_RETRYABLE'));
    const delivery = await new NotificationService(store, { send }).deliver(
      input,
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(delivery).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await store.list('identities')).toEqual([
      { id: 'user', status: 'PENDING_VERIFICATION' },
    ]);
  });
  it('sends the documented authenticated Resend contract with stable idempotency', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ id: 'provider-reference' }));
    const provider = new ResendEmailProvider(
      'test-api-key',
      'test@example.test',
      request,
    );
    expect(await provider.send(input)).toEqual({
      reference: 'provider-reference',
    });
    expect(request).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: 'Bearer test-api-key',
          'idempotency-key': 'challenge',
        }),
      }),
    );
  });
  it('normalizes errors without exposing provider response text', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response('private provider detail', { status: 401 }),
      );
    await expect(
      new ResendEmailProvider(
        'test-api-key',
        'test@example.test',
        request,
      ).send(input),
    ).rejects.toThrow('NOTIFICATION_REJECTED');
  });
});
