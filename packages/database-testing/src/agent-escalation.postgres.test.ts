import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTrustStore, applyMigrations, withTrustScope } from '@assurapay/database';
import {
  AGENT_ESCALATION_COLLECTION,
  AgenticDispatchEngine,
  type AgentEscalation,
  type DispatchProfile,
  type DispatchTask,
} from '@assurapay/agent-runtime';
import type { RequestContext } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: an escalation survives the process that recorded it, and belongs to one tenant.
 *
 * `dispatch.test.ts` proves the engine escalates rather than executing, against an in-memory store.
 * That cannot prove the two things that make an escalation worth anything:
 *
 * 1. **It is actually durable.** `agentEscalations` is registered as a governed document, which means
 *    it lands in `trust_records` under its collection name with no table of its own. A collection the
 *    durable store does not know is refused outright — `POSTGRES_TRUST_COLLECTIONS` is an allowlist —
 *    so "we added it to a list" is a claim about a write that either happens or does not.
 * 2. **It is tenant-scoped.** An escalation says which agent was asked to do what, by whom. Reading
 *    another tenant's queue would disclose their operations, and the only thing stopping that is
 *    forced row-level security on `trust_records`.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

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
    correlationId: 'corr-1',
  };
}

const scopeOf = (tenant: typeof TENANT_A) => ({
  tenantId: tenant.tenantId,
  workspaceId: tenant.workspaceId,
  actorId: tenant.userId,
});

/** A runtime that fails loudly: nothing in this suite should ever reach it. */
const refusingRuntime = {
  async execute() {
    throw new Error('THE_RUNTIME_SHOULD_NOT_HAVE_BEEN_REACHED');
  },
} as never;

function profile(): DispatchProfile {
  return {
    agent: 'Settlement',
    persona: 'finance',
    mandate: {
      autonomyLevel: 1,
      allowedActionClasses: ['READ', 'ANALYZE', 'RECOMMEND'],
      // A low ceiling, so the tasks below escalate rather than dispatch.
      maxRisk: 'LOW',
      allowedRoles: ['PAYMENT_OPERATOR'],
    },
    registeredAgentId: 'agent-1',
    capabilityId: 'capability-1',
    promptId: 'prompt-1',
  };
}

function task(over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    actionClass: 'RECOMMEND',
    risk: 'CRITICAL',
    roles: ['PAYMENT_OPERATOR'],
    contextSnapshotId: 'snapshot-1',
    model: 'sandbox',
    variables: {},
    idempotencyKey: 'escalate-me',
    ...over,
  };
}

async function foundWorkspace(database: TestDatabase, tenant: typeof TENANT_A): Promise<void> {
  await withTrustScope(scopeOf(tenant), async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', {
      id: tenant.workspaceId,
      tenantId: tenant.tenantId,
      status: 'ACTIVE',
      version: 1,
    });
  });
}

describe('an escalation is durable', () => {
  it('round-trips through the governed document store', async () => {
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);

    const store = new PostgresTrustStore(database.sql);
    const engine = new AgenticDispatchEngine({ runtime: refusingRuntime, store });

    const outcome = await withTrustScope(scopeOf(TENANT_A), () =>
      engine.dispatch(context(TENANT_A), profile(), task()),
    );
    expect(outcome.outcome).toBe('ESCALATED');

    // Read back through a *second* store instance, so this is a statement about the database rather
    // than about an object that remembered what it was told.
    const reread = new PostgresTrustStore(database.sql);
    const rows = await withTrustScope(scopeOf(TENANT_A), () =>
      reread.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'Settlement',
      persona: 'finance',
      reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE',
      status: 'OPEN',
      requestedBy: TENANT_A.userId,
      workspaceId: TENANT_A.workspaceId,
    });
  }, 120_000);

  it('survives resolution, and the resolution is what changed', async () => {
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);
    const engine = new AgenticDispatchEngine({
      runtime: refusingRuntime,
      store: new PostgresTrustStore(database.sql),
    });

    const outcome = await withTrustScope(scopeOf(TENANT_A), () =>
      engine.dispatch(context(TENANT_A), profile(), task()),
    );
    if (outcome.outcome !== 'ESCALATED') throw new Error('expected an escalation');

    await withTrustScope(scopeOf(TENANT_A), () =>
      engine.resolve(context(TENANT_A), outcome.escalation.id),
    );

    const open = await withTrustScope(scopeOf(TENANT_A), () =>
      engine.openEscalations(context(TENANT_A)),
    );
    expect(open).toEqual([]);

    const all = await withTrustScope(scopeOf(TENANT_A), () =>
      new PostgresTrustStore(database.sql).list<AgentEscalation>(AGENT_ESCALATION_COLLECTION),
    );
    // Resolved, not deleted. A removed escalation is a stall that stops being reportable.
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('RESOLVED');
    expect(all[0]?.resolvedBy).toBe(TENANT_A.userId);
  }, 120_000);

  it('spends an idempotency key across store instances, not just within one', async () => {
    // The in-memory suite proves the engine checks the key. This proves the check reaches the
    // database — which is what matters when the retry arrives at a different replica.
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);

    const first = new AgenticDispatchEngine({
      runtime: refusingRuntime,
      store: new PostgresTrustStore(database.sql),
    });
    const second = new AgenticDispatchEngine({
      runtime: refusingRuntime,
      store: new PostgresTrustStore(database.sql),
    });

    const a = await withTrustScope(scopeOf(TENANT_A), () =>
      first.dispatch(context(TENANT_A), profile(), task({ idempotencyKey: 'shared' })),
    );
    const b = await withTrustScope(scopeOf(TENANT_A), () =>
      second.dispatch(context(TENANT_A), profile(), task({ idempotencyKey: 'shared' })),
    );

    if (a.outcome !== 'ESCALATED' || b.outcome !== 'ESCALATED') throw new Error('expected both');
    expect(b.escalation.id).toBe(a.escalation.id);

    const rows = await withTrustScope(scopeOf(TENANT_A), () =>
      new PostgresTrustStore(database.sql).list<AgentEscalation>(AGENT_ESCALATION_COLLECTION),
    );
    expect(rows).toHaveLength(1);
  }, 120_000);
});

describe('an escalation belongs to one tenant', () => {
  it('is invisible to another tenant, because the database refuses it', async () => {
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);
    await foundWorkspace(database, TENANT_B);

    const engine = new AgenticDispatchEngine({
      runtime: refusingRuntime,
      store: new PostgresTrustStore(database.sql),
    });
    await withTrustScope(scopeOf(TENANT_A), () =>
      engine.dispatch(context(TENANT_A), profile(), task({ idempotencyKey: 'a-only' })),
    );

    // The raw collection read under B's scope, not the engine's filter — so this can only pass
    // because row-level security refused the row, rather than because the engine filtered it out.
    const store = new PostgresTrustStore(database.sql);
    const visibleToB = await withTrustScope(scopeOf(TENANT_B), () =>
      store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION),
    );
    expect(visibleToB).toHaveLength(0);

    const visibleToA = await withTrustScope(scopeOf(TENANT_A), () =>
      store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION),
    );
    expect(visibleToA).toHaveLength(1);
  }, 120_000);

  it('lets both tenants use one idempotency key without colliding', async () => {
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);
    await foundWorkspace(database, TENANT_B);
    const engine = new AgenticDispatchEngine({
      runtime: refusingRuntime,
      store: new PostgresTrustStore(database.sql),
    });

    for (const tenant of [TENANT_A, TENANT_B]) {
      const outcome = await withTrustScope(scopeOf(tenant), () =>
        engine.dispatch(context(tenant), profile(), task({ idempotencyKey: 'same-key' })),
      );
      expect(outcome.outcome, tenant.tenantId).toBe('ESCALATED');
      if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');
      expect(outcome.escalation.workspaceId).toBe(tenant.workspaceId);
    }
  }, 120_000);
});

describe('the escalation path moves no money', () => {
  it('never reaches the runtime, and writes nothing but its own collection', async () => {
    // CLAUDE.md asks for a non-custody assertion from anything on the money-movement path. This
    // engine sits in front of agents that assist settlement, so what it owes is proof that an
    // over-mandate task touches nothing: the runtime is refused by construction here, and the only
    // collection written is the escalation's own.
    const database = await migratedDatabase();
    await foundWorkspace(database, TENANT_A);
    const store = new PostgresTrustStore(database.sql);
    const engine = new AgenticDispatchEngine({ runtime: refusingRuntime, store });

    await withTrustScope(scopeOf(TENANT_A), () =>
      engine.dispatch(context(TENANT_A), profile(), task({ idempotencyKey: 'no-money' })),
    );

    for (const collection of [
      'releaseRequests',
      'paymentInstructions',
      'fundReservations',
      'financialEntitlements',
    ]) {
      const rows = await withTrustScope(scopeOf(TENANT_A), () => store.list(collection));
      expect(rows, `${collection} must be untouched`).toEqual([]);
    }
  }, 120_000);
});
