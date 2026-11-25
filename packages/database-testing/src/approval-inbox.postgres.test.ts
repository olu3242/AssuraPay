import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTrustStore, withTrustScope } from '@assurapay/database';
import {
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
  type FlowInstance,
} from '@assurapay/flow-orchestration';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: the approval inbox is the caller's own, against PostgreSQL.
 *
 * `/approvals` was a heading with no queue, and it is where the Engine 09 emails send a release
 * approver. The screen now reads a projection, and the projection's one safety property is that it
 * offers nothing the decision would refuse: an entry is actionable only when the caller holds an
 * active membership in the required role — the same predicate `FlowOrchestrator.decide` authorizes
 * with.
 *
 * That property is about rows, so it is proved against rows. `apps/web/lib` cannot be imported here
 * (it reaches the web app's own composition root, which binds a process-wide store), so the
 * projection's logic is reproduced against the same contracts the app's version uses. The source
 * assertions in `apps/web/lib/approval-inbox.test.ts` hold the two in step by reading the app's
 * implementation for the same predicate; this suite proves the predicate behaves against real
 * row-level security.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-approver' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b' };

function context(tenant: typeof TENANT_A, actorUserId = tenant.userId): RequestContext {
  return {
    actorUserId,
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: tenant.workspaceId,
    tenantId: tenant.tenantId,
    memberships: [tenant.workspaceId],
    correlationId: `corr-${tenant.workspaceId}`,
  };
}

function scopeOf(tenant: typeof TENANT_A, actorId = tenant.userId) {
  return { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, actorId };
}

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

/**
 * The projection under test, over the same contracts the application's version uses.
 *
 * Kept deliberately close to `getApprovalInbox`: the predicate is the thing being certified, so it
 * is written the same way rather than paraphrased.
 */
async function approvalInbox(store: TrustPersistence, ctx: RequestContext) {
  const workspace = ctx.activeWorkspaceId;
  const [tasks, flows, memberships] = await Promise.all([
    store.list<{ id: string; workspaceId: string; flowInstanceId: string; requiredRole: string; status: string; createdAt: string }>('humanTasks'),
    store.list<FlowInstance>('flowInstances'),
    store.list<{ workspaceId: string; userId: string; status: string; role?: string; membershipType?: string }>('memberships'),
  ]);

  const myRoles = new Set(
    memberships
      .filter(
        (m) => m.workspaceId === workspace && m.userId === ctx.actorUserId && m.status === 'ACTIVE',
      )
      .flatMap((m) => [m.role, m.membershipType])
      .filter((role): role is string => Boolean(role)),
  );
  const flowById = new Map(
    flows.filter((flow) => flow.workspaceId === workspace).map((flow) => [flow.id, flow]),
  );

  const entries: Array<{ taskId: string; transactionId: string; requiredRole: string }> = [];
  let waitingOnOthers = 0;
  for (const task of tasks
    .filter((task) => task.workspaceId === workspace && task.status === 'OPEN')
    .sort((l, r) => l.createdAt.localeCompare(r.createdAt))) {
    const flow = flowById.get(task.flowInstanceId);
    if (!flow) continue;
    if (!myRoles.has(task.requiredRole)) {
      waitingOnOthers++;
      continue;
    }
    entries.push({ taskId: task.id, transactionId: flow.transactionId, requiredRole: task.requiredRole });
  }
  return { entries, waitingOnOthers };
}

/** A journey driven to its human-approval step, the way the orchestrator reaches it. */
async function flowWaitingOnApproval(database: TestDatabase, tenant: typeof TENANT_A, transactionId: string) {
  const store = new PostgresTrustStore(database.sql);
  const registry = new FlowRegistry();
  registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
  const flows = new FlowOrchestrator(store, registry);
  const ctx = context(tenant);

  return await withTrustScope(scopeOf(tenant), async () => {
    const flow = await flows.start(ctx, {
      flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
      flowVersion: 1,
      organizationId: 'org-1',
      transactionId,
      assuranceLevel: 'ENHANCED',
      idempotencyKey: `inbox-${transactionId}`,
    });
    await flows.evaluate(ctx, flow.id);

    // Walk to the approval step by completing each awaited step in order. The approval step is the
    // only one with no `waitForEvent`, so this stops exactly where a person is needed.
    for (const definition of COMMERCIAL_COMMITMENT_FLOW_V1.steps) {
      if (!definition.waitForEvent) break;
      await flows.dispatch(ctx, flow.id, definition.id);
      await flows.signal(ctx, {
        flowId: flow.id,
        eventType: definition.waitForEvent,
        idempotencyKey: `${transactionId}:${definition.id}`,
      });
    }
    await flows.dispatch(ctx, flow.id, 'enhanced-approval');
    return { store, flows, flow };
  });
}

/**
 * A membership the database considers well-formed.
 *
 * `trust_memberships_revocation_consistent` requires `(status = 'REVOKED') = (revoked_at IS NOT
 * NULL)` — "a revoked membership must say when", because authorization reads `status` and a
 * lifecycle disagreeing with its timestamps is how a revoked principal keeps acting. So a revoked
 * fixture carries its revocation time rather than being a bare status string.
 */
async function grantRole(
  database: TestDatabase,
  tenant: typeof TENANT_A,
  userId: string,
  role: string,
  status = 'ACTIVE',
) {
  await withTrustScope(scopeOf(tenant), () =>
    new PostgresTrustStore(database.sql).append('memberships', {
      id: `m-${userId}-${role}-${status}`,
      workspaceId: tenant.workspaceId,
      userId,
      status,
      role,
      ...(status === 'REVOKED' ? { revokedAt: '2026-01-02T00:00:00.000Z' } : {}),
    }),
  );
}

describe('integration: the inbox offers only what the decision would accept', () => {
  it('lists the approval for a holder of the required role, and lets them decide it', async () => {
    const database = await seededDatabase();
    const { store, flows, flow } = await flowWaitingOnApproval(database, TENANT_A, 'txn-inbox-1');
    await grantRole(database, TENANT_A, TENANT_A.userId, 'RELEASE_APPROVER');

    const ctx = context(TENANT_A);
    const inbox = await withTrustScope(scopeOf(TENANT_A), () => approvalInbox(store, ctx));

    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({
      transactionId: 'txn-inbox-1',
      requiredRole: 'RELEASE_APPROVER',
    });
    expect(inbox.waitingOnOthers).toBe(0);

    // The offer is honest: the decision the inbox invited actually succeeds.
    const decided = await withTrustScope(scopeOf(TENANT_A), () =>
      flows.decide(ctx, inbox.entries[0].taskId, 'APPROVE'),
    );
    expect(decided).toBeDefined();

    const after = await withTrustScope(scopeOf(TENANT_A), () => approvalInbox(store, ctx));
    expect(after.entries).toHaveLength(0);
    void flow;
  });

  it('counts rather than lists an approval the caller cannot make, and the decision agrees', async () => {
    const database = await seededDatabase();
    const { store, flows } = await flowWaitingOnApproval(database, TENANT_A, 'txn-inbox-2');
    // The caller is a member, but with the wrong role.
    await grantRole(database, TENANT_A, 'user-author', 'CONTRACT_AUTHOR');

    const ctx = context(TENANT_A, 'user-author');
    const inbox = await withTrustScope(scopeOf(TENANT_A, 'user-author'), () => approvalInbox(store, ctx));

    expect(inbox.entries).toHaveLength(0);
    expect(inbox.waitingOnOthers).toBe(1);

    // And the refusal the inbox predicted is the one the orchestrator gives.
    const tasks = await withTrustScope(scopeOf(TENANT_A), () =>
      store.list<{ id: string; status: string }>('humanTasks'),
    );
    await expect(
      withTrustScope(scopeOf(TENANT_A, 'user-author'), () =>
        flows.decide(ctx, tasks.find((task) => task.status === 'OPEN')!.id, 'APPROVE'),
      ),
    ).rejects.toThrow('HUMAN_TASK_REQUIRED_ROLE_MISSING');
  });

  it('does not count a revoked membership as holding the role', async () => {
    const database = await seededDatabase();
    const { store } = await flowWaitingOnApproval(database, TENANT_A, 'txn-inbox-3');
    await grantRole(database, TENANT_A, TENANT_A.userId, 'RELEASE_APPROVER', 'REVOKED');

    const inbox = await withTrustScope(scopeOf(TENANT_A), () =>
      approvalInbox(store, context(TENANT_A)),
    );
    expect(inbox.entries).toHaveLength(0);
    expect(inbox.waitingOnOthers).toBe(1);
  });
});

describe('integration: the inbox does not cross the tenancy boundary', () => {
  it('shows another tenant nothing, not even a count', async () => {
    const database = await seededDatabase();
    const { store } = await flowWaitingOnApproval(database, TENANT_A, 'txn-inbox-4');
    await grantRole(database, TENANT_A, TENANT_A.userId, 'RELEASE_APPROVER');

    // Asserted on the read itself, not only on the projection's output. The projection also filters
    // by workspace in application code, so an empty inbox would look identical with row-level
    // security switched off entirely — this assertion is the one that can only pass because the
    // database refused to return the rows.
    const visible = await withTrustScope(scopeOf(TENANT_B), () =>
      store.list<{ id: string }>('humanTasks'),
    );
    expect(visible).toHaveLength(0);
    // And tenant A can see its own, so the empty read above is the boundary and not a missing row.
    const own = await withTrustScope(scopeOf(TENANT_A), () => store.list<{ id: string }>('humanTasks'));
    expect(own).toHaveLength(1);

    const inbox = await withTrustScope(scopeOf(TENANT_B), () => approvalInbox(store, context(TENANT_B)));
    expect(inbox.entries).toHaveLength(0);
    // Not even a count: a count would itself disclose that another tenant has work in flight.
    expect(inbox.waitingOnOthers).toBe(0);
  });
});
