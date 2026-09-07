import { afterEach, describe, expect, it } from 'vitest';
import { PostgresTrustStore, createPostgresPool } from '../../database/src/index';
import { createTestDatabase, requireTestDatabaseUrl } from '../../database-testing/src/index';
import type { TestDatabase } from '../../database-testing/src/index';
import { FlowOrchestrationEngine, FlowRegistry, type FlowDefinition } from './index';

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
const extraPools: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const pool of extraPools.splice(0)) await pool.dispose();
  for (const database of databases.splice(0)) await database.dispose();
});

const context = {
  actorUserId: 'operator',
  sessionId: 'session',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'workspace-1',
  tenantId: 'tenant-1',
  memberships: ['workspace-1'],
  correlationId: 'corr-restart',
};

const RESTART_FLOW: FlowDefinition = {
  id: 'RESTART_RECOVERY_PROOF',
  version: 1,
  name: 'Restart recovery proof',
  description: 'Wait durably for a signal, reconnect on a new pool, then execute one effect exactly once.',
  steps: [
    { id: 'wait', title: 'Wait for authoritative event', waitForEvent: 'AUTHORIZED_EVENT' },
    { id: 'effect', title: 'Irreversible effect boundary', dependencies: ['wait'], handler: 'effect' },
  ],
};

function registry() {
  const value = new FlowRegistry();
  value.register(RESTART_FLOW);
  return value;
}

describe('Flow OS PostgreSQL restart recovery', () => {
  it('reconstructs a waiting flow on a new connection pool, resumes once, and does not replay the effect', async () => {
    const database = await createTestDatabase({ applyRls: false });
    databases.push(database);

    const firstStore = new PostgresTrustStore(database.sql);
    const firstEngine = new FlowOrchestrationEngine(firstStore, registry());
    const started = await firstEngine.start(context, {
      flowDefinitionId: RESTART_FLOW.id,
      flowVersion: RESTART_FLOW.version,
      organizationId: 'org-1',
      transactionId: 'tx-1',
      idempotencyKey: 'start:tx-1',
    });

    await firstEngine.dispatch(context, started.id, 'wait');
    expect((await firstEngine.get(context, started.id)).state).toBe('WAITING_EVENT');

    // Simulate a replacement process: a fresh PostgreSQL pool, fresh store, fresh registry,
    // and fresh FlowOrchestrationEngine. No state is transferred in memory.
    const replacementPool = createPostgresPool({
      databaseUrl: database.url,
      max: 2,
      applicationName: 'assurapay-flow-restart-proof',
    });
    extraPools.push(replacementPool);

    let irreversibleEffects = 0;
    const replacementStore = new PostgresTrustStore(replacementPool.sql);
    const replacementEngine = new FlowOrchestrationEngine(replacementStore, registry(), {
      effect: async () => {
        irreversibleEffects += 1;
        return 'COMPLETED';
      },
    });

    const reconstructed = await replacementEngine.get(context, started.id);
    expect(reconstructed.state).toBe('WAITING_EVENT');
    expect(reconstructed.transactionId).toBe('tx-1');

    await replacementEngine.signal(context, {
      flowId: started.id,
      eventType: 'AUTHORIZED_EVENT',
      idempotencyKey: 'event:event-1',
      payload: { authoritativeEventId: 'event-1' },
    });
    expect((await replacementEngine.get(context, started.id)).state).toBe('RUNNING');

    await replacementEngine.dispatch(context, started.id, 'effect');
    expect(irreversibleEffects).toBe(1);
    expect((await replacementEngine.get(context, started.id)).state).toBe('COMPLETED');

    // A provider/domain retry after completion is deduplicated by the durable signal key.
    await replacementEngine.signal(context, {
      flowId: started.id,
      eventType: 'AUTHORIZED_EVENT',
      idempotencyKey: 'event:event-1',
      payload: { authoritativeEventId: 'event-1' },
    });
    expect(irreversibleEffects).toBe(1);
    expect((await replacementStore.list('flowSignals')).length).toBe(1);
    await expect(replacementEngine.dispatch(context, started.id, 'effect')).rejects.toThrow('FLOW_NOT_EXECUTABLE');
  });
});
