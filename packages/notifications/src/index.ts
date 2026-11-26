import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

export * from './flow-notifications';
export * from './templates';
export * from './transport';
export * from './smtp-transport';

import { NOTIFICATION_TEMPLATES, renderTemplate, type NotificationTemplateId } from './templates';
import type { NotificationTransport } from './transport';

/**
 * Engine 09 — Notification & Communication, for the email channel.
 *
 * `docs/ENGINE_CATALOG.md` marked this engine **Deferred**, and the gap was not academic. The
 * canonical flow's `enhanced-approval` step raises a `RELEASE_APPROVER` human task — the decision
 * that gates releasing money — and nobody was told. A journey reached `WAITING_HUMAN` and sat there
 * silently, indefinitely, waiting for someone who had no way of knowing. `IdentityVerificationChannel`
 * already names `NOTIFICATION_ENGINE` as the channel it would use and refuses to start if a
 * deployment picks it, because the engine did not exist.
 *
 * ## What this is, and what it is not
 *
 * The catalog row covers email, SMS, WhatsApp, push, in-app, webhooks and delivery evidence. This
 * implements **email and delivery evidence**. The other channels stay deferred and the row says so,
 * because an engine that claimed six channels and shipped one would be a worse lie than the
 * `Deferred` it replaces.
 *
 * ## Raising is separated from delivering, deliberately
 *
 * `raise` writes a durable `PENDING` record inside the governed store and audits it. `deliverPending`
 * is what talks to a transport. Two consequences, both wanted: a transport outage loses nothing,
 * because the obligation to notify is already durable; and a transport outage cannot block the flow,
 * because advancing a journey never waits on an SMTP connection. The flow's correctness does not
 * depend on an email arriving.
 *
 * ## Addresses are resolved at send time, never stored
 *
 * A notification record keeps the **recipient's identity id** and a masked address for evidence
 * (`j***@example.com`). The real address is read from the identity when the transport is called and
 * never persisted on the notification. Per CLAUDE.md's trust-foundation boundary, sensitive values
 * are tokenized or masked; an append-only notification log holding thousands of plaintext addresses
 * would be a standing disclosure risk for no benefit, since the identity already holds the address.
 *
 * ## Only verified addresses
 *
 * A notification to an unverified address is personal data sent somewhere nobody proved they
 * control. The engine refuses it and records `SUPPRESSED` with a reason, which is auditable — rather
 * than silently skipping, which would look identical to having no recipients.
 */

export type NotificationChannel = 'EMAIL';

export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';

export type NotificationRecord = {
  id: string;
  workspaceId: string;
  tenantId?: string;
  channel: NotificationChannel;
  /** The identity to notify. The address itself is resolved at send time. */
  recipientIdentityId: string;
  /** Masked, for evidence a human can read without exposing the address. */
  recipientMasked: string;
  templateId: NotificationTemplateId;
  /** Recorded so a message can be explained later rather than guessed at. */
  templateVersion: number;
  subject: string;
  body: string;
  /** What the notification is about, so evidence ties to the journey. */
  subjectType: string;
  subjectId: string;
  /** Unique per workspace. The whole idempotency story. */
  idempotencyKey: string;
  status: NotificationStatus;
  attempts: number;
  transportId?: string;
  providerMessageId?: string;
  failureReason?: string;
  correlationId: string;
  createdAt: string;
  sentAt?: string;
};

export type NotificationErrorCode =
  | 'NOTIFICATION_RECIPIENT_NOT_FOUND'
  | 'NOTIFICATION_TEMPLATE_UNKNOWN'
  | 'NOTIFICATION_TRANSPORT_NOT_CONFIGURED';

export class NotificationError extends Error {
  constructor(
    readonly code: NotificationErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NotificationError';
  }
}

/** The fields the engine needs from an identity. Structural, so it need not import Engine 01. */
type NotifiableIdentity = {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerifiedAt?: string;
};

/**
 * Masks an address for the evidence record.
 *
 * Keeps the first character of the local part and the whole domain. The domain is deliberately not
 * masked: "which organisation was told" is the question an auditor actually asks, and it is not the
 * part that identifies a person.
 */
export function maskAddress(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

export class NotificationEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly transport: NotificationTransport,
  ) {}

  /**
   * Records the obligation to notify someone, exactly once.
   *
   * Idempotent on `idempotencyKey` within the workspace, so a dispatcher that runs every minute
   * raises one email rather than one per minute. The key is the caller's to choose and should name
   * the thing that happened — `flow:{id}:SUSPENDED`, not a timestamp — so the same event cannot
   * produce two.
   */
  async raise(
    context: RequestContext,
    input: {
      recipientIdentityId: string;
      templateId: NotificationTemplateId;
      variables: Record<string, string>;
      subjectType: string;
      subjectId: string;
      idempotencyKey: string;
    },
  ): Promise<NotificationRecord | undefined> {
    requireActiveWorkspace(context);
    const workspaceId = context.activeWorkspaceId;

    const template = NOTIFICATION_TEMPLATES[input.templateId];
    if (!template) throw new NotificationError('NOTIFICATION_TEMPLATE_UNKNOWN', input.templateId);

    const existing = (await this.store.list<NotificationRecord>('notifications')).find(
      (entry) => entry.workspaceId === workspaceId && entry.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return undefined;

    const identity = await this.identity(input.recipientIdentityId);
    if (!identity)
      throw new NotificationError('NOTIFICATION_RECIPIENT_NOT_FOUND', input.recipientIdentityId);

    const rendered = renderTemplate(input.templateId, input.variables);
    const base = {
      id: randomUUID(),
      workspaceId,
      tenantId: context.tenantId,
      channel: 'EMAIL' as const,
      recipientIdentityId: identity.id,
      recipientMasked: maskAddress(identity.email),
      templateId: input.templateId,
      templateVersion: template.version,
      subject: rendered.subject,
      body: rendered.body,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      idempotencyKey: input.idempotencyKey,
      attempts: 0,
      correlationId: context.correlationId,
      createdAt: timestamp(),
    };

    // Suppression is recorded rather than skipped. "Nobody was emailed because the address was
    // never verified" and "nobody was emailed because there were no recipients" are different
    // facts, and only one of them is a configuration problem.
    const suppression = this.suppressionFor(identity);
    const record: NotificationRecord = suppression
      ? { ...base, status: 'SUPPRESSED', failureReason: suppression }
      : { ...base, status: 'PENDING' };

    await this.store.append('notifications', record);
    await this.store.audit({
      actorId: context.actorUserId,
      workspaceId,
      tenantId: context.tenantId,
      eventType: 'NotificationRaised',
      aggregateType: 'Notification',
      aggregateId: record.id,
      correlationId: context.correlationId,
      // The address is absent on purpose: an audit record is the last place to put one.
      metadata: {
        templateId: record.templateId,
        templateVersion: record.templateVersion,
        recipientMasked: record.recipientMasked,
        status: record.status,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
      },
    });
    return record;
  }

  /**
   * Attempts delivery of every pending notification in the workspace.
   *
   * A transport failure marks the record `FAILED` with its reason and counts the attempt; it does
   * not throw, because one undeliverable address must not stop the rest of the queue. The deployment
   * with no transport configured therefore accumulates honest `FAILED` records naming
   * `NOTIFICATION_TRANSPORT_NOT_CONFIGURED`, which is the truth and is visible, rather than silence.
   */
  async deliverPending(context: RequestContext): Promise<{ sent: number; failed: number }> {
    requireActiveWorkspace(context);
    const workspaceId = context.activeWorkspaceId;

    const pending = (await this.store.list<NotificationRecord>('notifications')).filter(
      (entry) => entry.workspaceId === workspaceId && entry.status === 'PENDING',
    );

    let sent = 0;
    let failed = 0;
    for (const notification of pending) {
      const identity = await this.identity(notification.recipientIdentityId);
      const attempts = notification.attempts + 1;

      if (!identity) {
        await this.store.replace('notifications', {
          ...notification,
          status: 'FAILED',
          attempts,
          failureReason: 'NOTIFICATION_RECIPIENT_NOT_FOUND',
        });
        failed++;
        continue;
      }

      try {
        const result = await this.transport.send({
          to: identity.email,
          subject: notification.subject,
          body: notification.body,
        });
        await this.store.replace('notifications', {
          ...notification,
          status: 'SENT',
          attempts,
          transportId: this.transport.id,
          providerMessageId: result.providerMessageId,
          sentAt: timestamp(),
        });
        await this.store.audit({
          actorId: context.actorUserId,
          workspaceId,
          tenantId: context.tenantId,
          eventType: 'NotificationDelivered',
          aggregateType: 'Notification',
          aggregateId: notification.id,
          correlationId: notification.correlationId,
          metadata: {
            transportId: this.transport.id,
            recipientMasked: notification.recipientMasked,
            templateId: notification.templateId,
          },
        });
        sent++;
      } catch (error) {
        await this.store.replace('notifications', {
          ...notification,
          status: 'FAILED',
          attempts,
          transportId: this.transport.id,
          failureReason: error instanceof Error ? error.message : 'NOTIFICATION_SEND_FAILED',
        });
        failed++;
      }
    }

    return { sent, failed };
  }

  /** Notifications about one subject, newest first. The delivery evidence the catalog asks for. */
  async forSubject(
    context: RequestContext,
    subjectType: string,
    subjectId: string,
  ): Promise<NotificationRecord[]> {
    requireActiveWorkspace(context);
    return (await this.store.list<NotificationRecord>('notifications'))
      .filter(
        (entry) =>
          entry.workspaceId === context.activeWorkspaceId &&
          entry.subjectType === subjectType &&
          entry.subjectId === subjectId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private suppressionFor(identity: NotifiableIdentity): string | undefined {
    if (identity.status !== 'ACTIVE') return 'RECIPIENT_NOT_ACTIVE';
    if (!identity.emailVerifiedAt) return 'RECIPIENT_EMAIL_NOT_VERIFIED';
    return undefined;
  }

  private async identity(id: string): Promise<NotifiableIdentity | undefined> {
    return (await this.store.list<NotifiableIdentity>('identities')).find((entry) => entry.id === id);
  }
}

/** Stable digest of a notification's content, for tests and evidence comparison. */
export function notificationDigest(record: Pick<NotificationRecord, 'subject' | 'body'>): string {
  return createHash('sha256').update(`${record.subject}\n${record.body}`).digest('hex');
}
