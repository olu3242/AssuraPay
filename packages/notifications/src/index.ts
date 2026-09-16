import { createHash } from 'node:crypto';
import type { TrustPersistence } from '@assurapay/shared';

export type NotificationPurpose =
  | 'VERIFY_EMAIL'
  | 'LOGIN'
  | 'AGREEMENT_REVIEW'
  | 'EVIDENCE_REQUESTED'
  | 'MILESTONE_ACCEPTED'
  | 'MILESTONE_REJECTED'
  | 'PAYMENT_APPROVAL'
  | 'PAYMENT_EXCEPTION';
export type EmailMessage = {
  recipient: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};
export interface EmailProvider {
  send(message: EmailMessage): Promise<{ reference: string }>;
}
export class EmailDeliveryError extends Error {
  constructor(
    readonly code:
      | 'NOTIFICATION_RETRYABLE'
      | 'NOTIFICATION_REJECTED'
      | 'NOTIFICATION_RESPONSE_INVALID',
  ) {
    super(code);
  }
}
export type NotificationDelivery = {
  id: string;
  userId: string;
  tenantId?: string;
  workspaceId?: string;
  purpose: NotificationPurpose;
  correlationId: string;
  recipientDigest: string;
  messageDigest: string;
  status: 'PENDING' | 'ACCEPTED' | 'FAILED';
  attempts: number;
  providerReference?: string;
  reasonCode?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Delivery metadata is durable; credential-bearing email bodies are never persisted. */
export class NotificationService {
  constructor(
    private readonly store: TrustPersistence,
    private readonly provider: EmailProvider,
  ) {}
  async deliver(
    input: EmailMessage & {
      purpose: NotificationPurpose;
      userId: string;
      tenantId?: string;
      workspaceId?: string;
      correlationId: string;
    },
  ): Promise<NotificationDelivery> {
    const authentication =
      input.purpose === 'VERIFY_EMAIL' || input.purpose === 'LOGIN';
    if (!authentication && (!input.tenantId || !input.workspaceId))
      throw new Error('NOTIFICATION_SCOPE_REQUIRED');
    if (!input.idempotencyKey || !input.userId || !input.correlationId)
      throw new Error('NOTIFICATION_REFERENCE_REQUIRED');
    const id = digest(
      JSON.stringify([
        input.tenantId ?? '',
        input.workspaceId ?? '',
        input.purpose,
        input.idempotencyKey,
      ]),
    );
    const messageDigest = digest(
      JSON.stringify([input.recipient, input.subject, input.text]),
    );
    let record = (
      await this.store.list<NotificationDelivery>('notificationDeliveries')
    ).find((row) => row.id === id);
    if (record) {
      if (
        record.messageDigest !== messageDigest ||
        record.userId !== input.userId
      )
        throw new Error('NOTIFICATION_IDEMPOTENCY_CONFLICT');
      // A pending record may already have reached the provider. It needs operator recovery,
      // not an automatic new request after a process restart.
      if (record.status === 'PENDING')
        throw new Error('NOTIFICATION_RECOVERY_REQUIRED');
      return record;
    }
    const now = new Date().toISOString();
    record = {
      id,
      userId: input.userId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      correlationId: input.correlationId,
      recipientDigest: digest(input.recipient),
      messageDigest,
      status: 'PENDING',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.store.transaction(async (tx) => {
      await tx.append('notificationDeliveries', record!);
      await this.audit(tx, record!, 'NotificationQueued');
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.provider.send({
          recipient: input.recipient,
          subject: input.subject,
          text: input.text,
          idempotencyKey: id,
        });
        record = {
          ...record,
          status: 'ACCEPTED',
          attempts: attempt,
          providerReference: result.reference,
          updatedAt: new Date().toISOString(),
          version: record.version + 1,
        };
        break;
      } catch (error) {
        const retryable =
          error instanceof EmailDeliveryError &&
          error.code === 'NOTIFICATION_RETRYABLE';
        record = {
          ...record,
          attempts: attempt,
          reasonCode:
            error instanceof EmailDeliveryError
              ? error.code
              : 'NOTIFICATION_RETRYABLE',
          updatedAt: new Date().toISOString(),
          version: record.version + 1,
        };
        if (!retryable || attempt === 3) {
          record.status = 'FAILED';
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    const completed = record;
    await this.store.transaction(async (tx) => {
      await tx.replace('notificationDeliveries', completed);
      await this.audit(
        tx,
        completed,
        completed.status === 'ACCEPTED'
          ? 'NotificationAccepted'
          : 'NotificationFailed',
      );
    });
    return completed;
  }
  private async audit(
    store: TrustPersistence,
    record: NotificationDelivery,
    eventType: string,
  ): Promise<void> {
    await store.audit({
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      actorId: record.userId,
      aggregateType: 'NotificationDelivery',
      aggregateId: record.id,
      eventType,
      correlationId: record.correlationId,
      metadata: {
        purpose: record.purpose,
        status: record.status,
        attempts: record.attempts,
        reasonCode: record.reasonCode,
      },
    });
  }
}

/** Resend REST adapter. Provider errors and bodies are never included in exceptions. */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!apiKey || !from || /[\r\n]/.test(from))
      throw new Error('NOTIFICATION_CONFIG_REQUIRED');
  }
  async send(message: EmailMessage): Promise<{ reference: string }> {
    let response: Response;
    try {
      response = await this.request('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.recipient],
          subject: message.subject,
          text: message.text,
        }),
      });
    } catch {
      throw new EmailDeliveryError('NOTIFICATION_RETRYABLE');
    }
    if (!response.ok)
      throw new EmailDeliveryError(
        response.status === 429 || response.status >= 500
          ? 'NOTIFICATION_RETRYABLE'
          : 'NOTIFICATION_REJECTED',
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmailDeliveryError('NOTIFICATION_RESPONSE_INVALID');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      !('id' in body) ||
      typeof body.id !== 'string' ||
      !body.id
    )
      throw new EmailDeliveryError('NOTIFICATION_RESPONSE_INVALID');
    return { reference: body.id };
  }
}

/** Explicit deterministic adapter for contract tests; never selected by runtime configuration. */
export class DeterministicEmailProvider implements EmailProvider {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    if (
      !this.messages.some(
        (entry) => entry.idempotencyKey === message.idempotencyKey,
      )
    )
      this.messages.push(structuredClone(message));
    return { reference: `test-${message.idempotencyKey}` };
  }
}

