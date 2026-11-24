import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTrustStore, withTrustScope } from '@assurapay/database';
import {
  FlowNotificationDispatcher,
  NotificationEngine,
  createRecordingTransport,
  type NotificationRecord,
} from '@assurapay/notifications';
import type { RequestContext } from '@assurapay/shared';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: notification evidence is durable and does not cross the tenancy boundary.
 *
 * §11 of the convergence brief refuses to certify on in-memory stores, and for this engine the
 * reason is pointed. A notification record *is* the delivery evidence — "who was told, when, under
 * which template version, and whether it actually went" — so its value is entirely in surviving.
 * An in-memory pass proves the rendering; only this proves the evidence.
 *
 * The tenancy assertion matters more here than in most suites. A notification carries a recipient,
 * so a leak across the boundary is a personal-data leak rather than a correctness bug.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b' };

function context(tenant: typeof TENANT_A): RequestContext {
  return {
    actorUserId: tenant.userId,
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: tenant.workspaceId,
    tenantId: tenant.tenantId,
    memberships: [tenant.workspaceId],
    correlationId: `corr-${tenant.workspaceId}`,
  };
}

function scopeOf(tenant: typeof TENANT_A) {
  return { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, actorId: tenant.userId };
}

/** The trust store with its tenancy boundary in force, and both tenants seeded. */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
  databases.push(database);

  for (const table of ['trust_tenants', 'trust_workspaces'])
    await database.sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant.tenantId})`;
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${tenant.workspaceId}, ${tenant.tenantId}, 'ACTIVE', ${database.sql.json({ id: tenant.workspaceId })}, ${'0'.repeat(64)})
      `;
    }
  } finally {
    for (const table of ['trust_tenants', 'trust_workspaces'])
      await database.sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  return database;
}

async function seedRecipient(
  database: TestDatabase,
  tenant: typeof TENANT_A,
  identity: { id: string; email: string; verified?: boolean },
): Promise<void> {
  await withTrustScope(scopeOf(tenant), async () => {
    await new PostgresTrustStore(database.sql).append('identities', {
      id: identity.id,
      email: identity.email,
      displayName: 'Ada',
      status: 'ACTIVE',
      ...(identity.verified === false ? {} : { emailVerifiedAt: '2026-01-01T00:00:00.000Z' }),
    });
  });
}

const TASK_VARIABLES = {
  recipientName: 'Ada',
  stepTitle: 'Independent release approval',
  requiredRole: 'RELEASE_APPROVER',
  flowReference: 'COMMERCIAL_COMMITMENT_FLOW / txn-1',
};

describe('integration: notification evidence survives PostgreSQL', () => {
  it('round-trips the record, delivers it, and keeps the evidence retrievable', async () => {
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, { id: 'user-approver-a', email: 'approver@acme.test' });

    const store = new PostgresTrustStore(database.sql);
    const transport = createRecordingTransport();
    const engine = new NotificationEngine(store, transport);
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    const raised = await withTrustScope(scope, () =>
      engine.raise(ctx, {
        recipientIdentityId: 'user-approver-a',
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 'task-1',
        idempotencyKey: 'human-task:task-1:raised',
      }),
    );
    expect(raised?.status).toBe('PENDING');
    // The rendered body survives the jsonb round trip rather than arriving as `[object Object]`.
    expect(raised?.body).toContain('RELEASE_APPROVER');

    expect(await withTrustScope(scope, () => engine.deliverPending(ctx))).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(transport.sent[0].to).toBe('approver@acme.test');

    const evidence = await withTrustScope(scope, () => engine.forSubject(ctx, 'HumanTask', 'task-1'));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].status).toBe('SENT');
    expect(evidence[0].templateVersion).toBe(1);
    expect(evidence[0].sentAt).toBeTruthy();
  });

  it('stores no plaintext address, in the record or the audit trail', async () => {
    // The privacy rule, re-proved where it actually matters: the durable rows.
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, { id: 'user-approver-a', email: 'approver@acme.test' });

    const store = new PostgresTrustStore(database.sql);
    const engine = new NotificationEngine(store, createRecordingTransport());
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    await withTrustScope(scope, () =>
      engine.raise(ctx, {
        recipientIdentityId: 'user-approver-a',
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 'task-2',
        idempotencyKey: 'human-task:task-2:raised',
      }),
    );

    // Read back what the database actually holds, not the objects the engine returned. Read through
    // the scoped store rather than raw SQL: the suite role is subject to forced row-level security,
    // so an unscoped query correctly returns nothing and would make this assertion vacuous.
    const persisted = await withTrustScope(scope, async () => [
      await store.list<NotificationRecord>('notifications'),
      await store.list<{ metadata?: Record<string, unknown> }>('auditRecords'),
    ]);
    const serialized = JSON.stringify(persisted);

    expect(persisted[0]).toHaveLength(1);
    expect(serialized).not.toContain('approver@acme.test');
    expect(serialized).toContain('a*******@acme.test');
  });

  it('is idempotent across a second raise against real transactions', async () => {
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, { id: 'user-approver-a', email: 'approver@acme.test' });

    const store = new PostgresTrustStore(database.sql);
    const engine = new NotificationEngine(store, createRecordingTransport());
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    const raise = () =>
      withTrustScope(scope, () =>
        engine.raise(ctx, {
          recipientIdentityId: 'user-approver-a',
          templateId: 'flow-completed',
          variables: { recipientName: 'Ada', flowReference: 'F / txn-1' },
          subjectType: 'FlowInstance',
          subjectId: 'flow-1',
          idempotencyKey: 'flow:flow-1:COMPLETED',
        }),
      );

    expect(await raise()).toBeDefined();
    expect(await raise()).toBeUndefined();
    expect(
      await withTrustScope(scope, () => store.list<NotificationRecord>('notifications')),
    ).toHaveLength(1);
  });

  it('suppresses an unverified address durably, and never calls the transport', async () => {
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, {
      id: 'user-unverified',
      email: 'unverified@acme.test',
      verified: false,
    });

    const store = new PostgresTrustStore(database.sql);
    const transport = createRecordingTransport();
    const engine = new NotificationEngine(store, transport);
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    const raised = await withTrustScope(scope, () =>
      engine.raise(ctx, {
        recipientIdentityId: 'user-unverified',
        templateId: 'flow-failed',
        variables: { recipientName: 'Ada', flowReference: 'F / txn-1' },
        subjectType: 'FlowInstance',
        subjectId: 'flow-2',
        idempotencyKey: 'flow:flow-2:FAILED',
      }),
    );
    expect(raised?.status).toBe('SUPPRESSED');
    expect(raised?.failureReason).toBe('RECIPIENT_EMAIL_NOT_VERIFIED');

    await withTrustScope(scope, () => engine.deliverPending(ctx));
    expect(transport.sent).toHaveLength(0);
  });
});

describe('integration: a notification does not cross the tenancy boundary', () => {
  it('hides one tenant’s notifications from another under forced row-level security', async () => {
    // A notification names a recipient, so a leak here is a personal-data leak.
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, { id: 'user-approver-a', email: 'approver@acme.test' });

    const store = new PostgresTrustStore(database.sql);
    const engine = new NotificationEngine(store, createRecordingTransport());

    await withTrustScope(scopeOf(TENANT_A), () =>
      engine.raise(context(TENANT_A), {
        recipientIdentityId: 'user-approver-a',
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 'task-3',
        idempotencyKey: 'human-task:task-3:raised',
      }),
    );

    const visibleToB = await withTrustScope(scopeOf(TENANT_B), () =>
      store.list<NotificationRecord>('notifications'),
    );
    expect(visibleToB).toHaveLength(0);

    const evidenceForB = await withTrustScope(scopeOf(TENANT_B), () =>
      engine.forSubject(context(TENANT_B), 'HumanTask', 'task-3'),
    );
    expect(evidenceForB).toEqual([]);
  });

  it('will not deliver another tenant’s pending notification', async () => {
    const database = await seededDatabase();
    await seedRecipient(database, TENANT_A, { id: 'user-approver-a', email: 'approver@acme.test' });

    const store = new PostgresTrustStore(database.sql);
    const transport = createRecordingTransport();
    const engine = new NotificationEngine(store, createRecordingTransport());
    const engineForB = new NotificationEngine(store, transport);

    await withTrustScope(scopeOf(TENANT_A), () =>
      engine.raise(context(TENANT_A), {
        recipientIdentityId: 'user-approver-a',
        templateId: 'human-task-raised',
        variables: TASK_VARIABLES,
        subjectType: 'HumanTask',
        subjectId: 'task-4',
        idempotencyKey: 'human-task:task-4:raised',
      }),
    );

    expect(
      await withTrustScope(scopeOf(TENANT_B), () => engineForB.deliverPending(context(TENANT_B))),
    ).toEqual({ sent: 0, failed: 0 });
    expect(transport.sent).toHaveLength(0);
  });

  it('dispatches nothing for a workspace with no flows of its own', async () => {
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);
    const dispatcher = new FlowNotificationDispatcher(
      store,
      new NotificationEngine(store, createRecordingTransport()),
    );

    const result = await withTrustScope(scopeOf(TENANT_B), () =>
      dispatcher.dispatch(context(TENANT_B)),
    );
    expect(result).toEqual({ raised: 0, unroutable: [] });
  });
});
