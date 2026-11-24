import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import {
  NOTIFICATION_TEMPLATES,
  NotificationEngine,
  createRecordingTransport,
  maskAddress,
  renderTemplate,
  unconfiguredEmailTransport,
  type NotificationRecord,
} from './index';
import { FlowNotificationDispatcher, humaniseStepId } from './flow-notifications';

/**
 * Engine 09 — email notifications raised from changes in the flow process.
 *
 * The assertions that carry the weight are the refusals. It is easy to write a notifier that sends
 * something; the properties this engine has to have are that it never sends to an address nobody
 * proved they control, never puts agreement detail or an address where it will be retained, never
 * tells someone about a decision they would be refused when they tried to make it, and never sends
 * the same thing twice.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-operator',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    memberships: ['workspace-1'],
    correlationId: 'corr-1',
    ...overrides,
  };
}

type Seed = {
  identities?: Array<{
    id: string;
    email: string;
    displayName: string;
    status?: string;
    verified?: boolean;
  }>;
  memberships?: Array<{ userId: string; role?: string; status?: string }>;
};

async function harness(seed: Seed = {}, transport = createRecordingTransport()) {
  const store = new InMemoryTrustStore();
  for (const identity of seed.identities ?? [{ id: 'user-approver', email: 'approver@acme.test', displayName: 'Ada' }])
    await store.append('identities', {
      id: identity.id,
      email: identity.email,
      displayName: identity.displayName,
      status: identity.status ?? 'ACTIVE',
      ...(identity.verified === false ? {} : { emailVerifiedAt: '2026-01-01T00:00:00.000Z' }),
    });
  for (const membership of seed.memberships ?? [])
    await store.append('memberships', {
      id: `m-${membership.userId}`,
      workspaceId: 'workspace-1',
      userId: membership.userId,
      status: membership.status ?? 'ACTIVE',
      role: membership.role ?? 'RELEASE_APPROVER',
    });

  const notifications = new NotificationEngine(store, transport);
  return {
    store,
    transport,
    notifications,
    // A resolver standing in for the one the composition root builds from the flow registry.
    dispatcher: new FlowNotificationDispatcher(store, notifications, ({ stepDefinitionId }) =>
      stepDefinitionId === 'enhanced-approval' ? 'Independent release approval' : undefined,
    ),
  };
}

const TASK_VARIABLES = {
  recipientName: 'Ada',
  stepTitle: 'Independent release approval',
  requiredRole: 'RELEASE_APPROVER',
  flowReference: 'COMMERCIAL_COMMITMENT_FLOW / txn-1',
};

async function raiseTask(engine: NotificationEngine, ctx = context(), key = 'human-task:t-1:raised') {
  return await engine.raise(ctx, {
    recipientIdentityId: 'user-approver',
    templateId: 'human-task-raised',
    variables: TASK_VARIABLES,
    subjectType: 'HumanTask',
    subjectId: 't-1',
    idempotencyKey: key,
  });
}

describe('an obligation to notify is durable before anything is sent', () => {
  it('records a pending notification with its template version and masked recipient', async () => {
    const { notifications, store } = await harness();
    const record = await raiseTask(notifications);

    expect(record?.status).toBe('PENDING');
    expect(record?.templateVersion).toBe(NOTIFICATION_TEMPLATES['human-task-raised'].version);
    expect(record?.recipientMasked).toBe('a*******@acme.test');
    expect(await store.list('notifications')).toHaveLength(1);
  });

  it('never stores the address, on the notification or in the audit record', async () => {
    // An append-only notification log holding thousands of plaintext addresses would be a standing
    // disclosure risk for no benefit, since the identity already holds the address.
    const { notifications, store } = await harness();
    await raiseTask(notifications);

    const serialized = JSON.stringify([
      await store.list('notifications'),
      await store.list('auditRecords'),
    ]);
    expect(serialized).not.toContain('approver@acme.test');
    expect(serialized).toContain('a*******@acme.test');
  });

  it('is idempotent on its key, so a per-minute dispatcher sends one email', async () => {
    const { notifications, store } = await harness();
    expect(await raiseTask(notifications)).toBeDefined();
    expect(await raiseTask(notifications)).toBeUndefined();
    expect(await store.list('notifications')).toHaveLength(1);
  });

  it('refuses an identity that does not exist', async () => {
    const { notifications } = await harness();
    await expect(
      notifications.raise(context(), {
        recipientIdentityId: 'nobody',
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 't-1',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('NOTIFICATION_RECIPIENT_NOT_FOUND');
  });

  it('requires an active workspace', async () => {
    const { notifications } = await harness();
    await expect(
      raiseTask(notifications, context({ activeWorkspaceId: undefined, memberships: [] })),
    ).rejects.toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });
});

describe('an unverified or inactive recipient is suppressed, and the suppression is recorded', () => {
  it('suppresses an unverified address rather than mailing it', async () => {
    // Personal data to an address nobody proved they control.
    const { notifications, transport } = await harness({
      identities: [{ id: 'user-approver', email: 'approver@acme.test', displayName: 'Ada', verified: false }],
    });
    const record = await raiseTask(notifications);
    expect(record?.status).toBe('SUPPRESSED');
    expect(record?.failureReason).toBe('RECIPIENT_EMAIL_NOT_VERIFIED');

    await notifications.deliverPending(context());
    expect(transport.sent).toHaveLength(0);
  });

  it('suppresses an inactive identity', async () => {
    const { notifications } = await harness({
      identities: [{ id: 'user-approver', email: 'a@acme.test', displayName: 'Ada', status: 'SUSPENDED' }],
    });
    expect((await raiseTask(notifications))?.failureReason).toBe('RECIPIENT_NOT_ACTIVE');
  });

  it('distinguishes suppression from having no recipients at all', async () => {
    // Both look like "no email went out"; only one is a configuration problem.
    const { notifications } = await harness({
      identities: [{ id: 'user-approver', email: 'a@acme.test', displayName: 'Ada', verified: false }],
    });
    const record = await raiseTask(notifications);
    expect(record).toBeDefined();
    expect(record?.status).toBe('SUPPRESSED');
  });
});

describe('delivery is attempted separately, and failure is evidence rather than silence', () => {
  it('sends a pending notification and records the transport and message id', async () => {
    const { notifications, transport, store } = await harness();
    await raiseTask(notifications);

    expect(await notifications.deliverPending(context())).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent[0].to).toBe('approver@acme.test');
    expect(transport.sent[0].subject).toContain('Independent release approval');

    const [record] = await store.list<NotificationRecord>('notifications');
    expect(record.status).toBe('SENT');
    expect(record.transportId).toBe('recording');
    expect(record.providerMessageId).toBeTruthy();
    expect(record.attempts).toBe(1);
  });

  it('records an honest failure when no transport is configured', async () => {
    // The shipping state of this repository. A silent no-op transport would mark everything SENT
    // while nothing arrived, which manufactures evidence — worse than having no engine.
    const { notifications, store } = await harness({}, unconfiguredEmailTransport as never);
    await raiseTask(notifications);

    expect(await notifications.deliverPending(context())).toEqual({ sent: 0, failed: 1 });
    const [record] = await store.list<NotificationRecord>('notifications');
    expect(record.status).toBe('FAILED');
    expect(record.failureReason).toBe('NOTIFICATION_TRANSPORT_NOT_CONFIGURED');
  });

  it('does not let one undeliverable address stop the rest of the queue', async () => {
    const { notifications, store } = await harness(
      {
        identities: [
          { id: 'user-a', email: 'bad@acme.test', displayName: 'A' },
          { id: 'user-b', email: 'good@acme.test', displayName: 'B' },
        ],
      },
      createRecordingTransport({ failOn: (to) => to === 'bad@acme.test' }),
    );
    for (const id of ['user-a', 'user-b'])
      await notifications.raise(context(), {
        recipientIdentityId: id,
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 't-1',
        idempotencyKey: `k-${id}`,
      });

    expect(await notifications.deliverPending(context())).toEqual({ sent: 1, failed: 1 });
    const statuses = (await store.list<NotificationRecord>('notifications')).map((r) => r.status).sort();
    expect(statuses).toEqual(['FAILED', 'SENT']);
  });

  it('does not resend an already delivered notification', async () => {
    const { notifications, transport } = await harness();
    await raiseTask(notifications);
    await notifications.deliverPending(context());
    await notifications.deliverPending(context());
    expect(transport.sent).toHaveLength(1);
  });
});

describe('templates say that something is waiting, never what it is', () => {
  it('carries no agreement detail, amount or party name', async () => {
    // Email is the least controlled channel the platform has, and a notification carrying the
    // figures would become a second, unversioned account of the agreement.
    for (const template of Object.values(NOTIFICATION_TEMPLATES)) {
      const text = `${template.subject} ${template.body}`.toLowerCase();
      for (const forbidden of ['amount', 'ngn', 'kobo', '₦', 'beneficiary', 'account number', 'iban'])
        expect(text, `${template.id} mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('refuses to render with a variable missing rather than leaving the marker unfilled', async () => {
    expect(() => renderTemplate('human-task-raised', { recipientName: 'Ada' })).toThrow(
      'requires stepTitle',
    );
  });

  it('leaves no unfilled marker when it does render', async () => {
    for (const [id, template] of Object.entries(NOTIFICATION_TEMPLATES)) {
      const variables = Object.fromEntries(template.requiredVariables.map((name) => [name, 'x']));
      const rendered = renderTemplate(id as keyof typeof NOTIFICATION_TEMPLATES, variables);
      expect(`${rendered.subject}${rendered.body}`).not.toMatch(/\{\{/);
    }
  });

  it('masks a short local part without revealing its length', async () => {
    expect(maskAddress('a@acme.test')).toBe('a**@acme.test');
    expect(maskAddress('notanemail')).toBe('***');
  });
});

describe('a change in the flow process raises the notification', () => {
  async function flowHarness(seed: Seed = {}) {
    const built = await harness({
      identities: [
        { id: 'user-approver', email: 'approver@acme.test', displayName: 'Ada' },
        { id: 'user-initiator', email: 'initiator@acme.test', displayName: 'Grace' },
      ],
      memberships: [{ userId: 'user-approver', role: 'RELEASE_APPROVER' }],
      ...seed,
    });
    await built.store.append('flowInstances', {
      id: 'flow-1',
      workspaceId: 'workspace-1',
      state: 'WAITING_HUMAN',
      initiatorId: 'user-initiator',
      transactionId: 'txn-1',
      flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
    });
    await built.store.append('flowStepInstances', {
      id: 'step-1',
      workspaceId: 'workspace-1',
      stepDefinitionId: 'enhanced-approval',
    });
    await built.store.append('humanTasks', {
      id: 'task-1',
      workspaceId: 'workspace-1',
      flowInstanceId: 'flow-1',
      stepInstanceId: 'step-1',
      requiredRole: 'RELEASE_APPROVER',
      status: 'OPEN',
    });
    return built;
  }

  it('tells the role holder that a release approval is waiting', async () => {
    // The gap Engine 09 was deferred into: the canonical journey's release approval raised a task
    // and nobody was told, so the flow waited in silence for a person who could not know.
    const { dispatcher, notifications, transport } = await flowHarness();

    expect((await dispatcher.dispatch(context())).raised).toBe(1);
    await notifications.deliverPending(context());

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe('approver@acme.test');
    expect(transport.sent[0].subject).toContain('Independent release approval');
    expect(transport.sent[0].body).toContain('RELEASE_APPROVER');
    expect(transport.sent[0].body).toContain('txn-1');
  });

  it('tells only people who could actually act on it', async () => {
    // The recipient rule is the predicate `decide` authorizes with. A notification reaching someone
    // who would be refused is an information leak dressed as a convenience.
    const { dispatcher, notifications, transport } = await flowHarness({
      memberships: [
        { userId: 'user-approver', role: 'RELEASE_APPROVER' },
        { userId: 'user-initiator', role: 'CONTRACT_AUTHOR' },
        { userId: 'user-approver', role: 'RELEASE_APPROVER', status: 'REVOKED' },
      ],
    });
    await dispatcher.dispatch(context());
    await notifications.deliverPending(context());
    expect(transport.sent.map((message) => message.to)).toEqual(['approver@acme.test']);
  });

  it('reports a task nobody can act on instead of swallowing it', async () => {
    // A journey blocked on a role nobody holds looks exactly like a slow approver from outside.
    const { dispatcher } = await flowHarness({ memberships: [] });
    const result = await dispatcher.dispatch(context());
    expect(result.raised).toBe(0);
    expect(result.unroutable).toEqual([{ taskId: 'task-1', requiredRole: 'RELEASE_APPROVER' }]);
  });

  it('does not re-raise on a second dispatch', async () => {
    const { dispatcher } = await flowHarness();
    expect((await dispatcher.dispatch(context())).raised).toBe(1);
    expect((await dispatcher.dispatch(context())).raised).toBe(0);
  });

  it('stops notifying once the task is decided', async () => {
    const { dispatcher, store } = await flowHarness();
    await store.replace('humanTasks', {
      id: 'task-1',
      workspaceId: 'workspace-1',
      flowInstanceId: 'flow-1',
      stepInstanceId: 'step-1',
      requiredRole: 'RELEASE_APPROVER',
      status: 'APPROVED',
    });
    expect((await dispatcher.dispatch(context())).raised).toBe(0);
  });

  it('tells the initiator when the journey suspends, fails or completes', async () => {
    for (const [state, subject] of [
      ['SUSPENDED', 'suspended'],
      ['FAILED', 'failed'],
      ['COMPLETED', 'completed'],
    ] as const) {
      const { dispatcher, notifications, transport, store } = await flowHarness({ memberships: [] });
      await store.replace('flowInstances', {
        id: 'flow-1',
        workspaceId: 'workspace-1',
        state,
        initiatorId: 'user-initiator',
        transactionId: 'txn-1',
        flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
      });
      await dispatcher.dispatch(context());
      await notifications.deliverPending(context());
      expect(transport.sent.map((m) => m.to)).toEqual(['initiator@acme.test']);
      expect(transport.sent[0].subject.toLowerCase(), state).toContain(subject);
    }
  });

  it('says nothing about a journey that is simply progressing', async () => {
    // Steady-state progress is not news, and an email per step would train people to ignore them.
    const { dispatcher, store } = await flowHarness({ memberships: [] });
    await store.replace('flowInstances', {
      id: 'flow-1',
      workspaceId: 'workspace-1',
      state: 'WAITING_EVENT',
      initiatorId: 'user-initiator',
      transactionId: 'txn-1',
      flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
    });
    expect((await dispatcher.dispatch(context())).raised).toBe(0);
  });

  it('does not reach into another workspace', async () => {
    const { dispatcher } = await flowHarness();
    const other = context({ activeWorkspaceId: 'workspace-2', memberships: ['workspace-2'] });
    expect((await dispatcher.dispatch(other)).raised).toBe(0);
  });

  it('keeps delivery evidence retrievable per subject', async () => {
    const { dispatcher, notifications } = await flowHarness();
    await dispatcher.dispatch(context());
    await notifications.deliverPending(context());

    const evidence = await notifications.forSubject(context(), 'HumanTask', 'task-1');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].status).toBe('SENT');
    expect(evidence[0].recipientMasked).toBe('a*******@acme.test');
  });
});

describe('a step title is the product’s, not an internal slug', () => {
  it('falls back to a readable form when no resolver is supplied', () => {
    expect(humaniseStepId('enhanced-approval')).toBe('Enhanced approval');
    expect(humaniseStepId('agreement_intelligence')).toBe('Agreement intelligence');
    expect(humaniseStepId('')).toBe('an execution step');
  });
});
