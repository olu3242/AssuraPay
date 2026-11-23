import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresTrustStore,
  POSTGRES_TRUST_COLLECTIONS,
  withTrustScope,
} from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from './index';

requireTestDatabaseUrl();

let database: TestDatabase;

const tenantId = 'flow-tenant';
const workspaceId = 'flow-workspace';
const actorId = 'flow-operator';

const scope = { tenantId, workspaceId, actorId };

beforeAll(async () => {
  // The generic trust_records table and its migration path are the production durability boundary.
  // RLS itself is certified independently; this suite proves the Flow OS collection routing is real
  // PostgreSQL rather than an InMemoryTrustStore-only success path.
  database = await createTestDatabase({ applyRls: false });
});

afterAll(async () => {
  await database.dispose();
});

describe('integration: Flow OS durable PostgreSQL persistence', () => {
  it('publishes all four Flow OS collections through the canonical database allowlist', () => {
    for (const collection of ['flowInstances', 'flowStepInstances', 'flowSignals', 'humanTasks'])
      expect(POSTGRES_TRUST_COLLECTIONS).toContain(collection);
  });

  it('appends, lists and replaces all four flow aggregate types on real PostgreSQL', async () => {
    const store = new PostgresTrustStore(database.sql);
    await withTrustScope(scope, async () => {
      await store.append('flowInstances', {
        id: 'flow-1', workspaceId, flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW', flowVersion: 1,
        organizationId: 'org-1', transactionId: 'tx-1', initiatorId: actorId,
        assuranceLevel: 'STANDARD', state: 'READY', idempotencyKey: 'start-1', correlationId: 'corr-1',
        createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-07T14:00:00.000Z',
      });
      await store.append('flowStepInstances', {
        id: 'step-1', workspaceId, flowInstanceId: 'flow-1', stepDefinitionId: 'agreement_intelligence',
        state: 'PENDING', attempts: 0,
        createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-07T14:00:00.000Z',
      });
      await store.append('flowSignals', {
        id: 'signal-1', workspaceId, flowInstanceId: 'flow-1', eventType: 'EVIDENCE_SUBMITTED',
        idempotencyKey: 'signal-key-1', payload: {}, receivedAt: '2026-09-07T14:01:00.000Z',
      });
      await store.append('humanTasks', {
        id: 'task-1', workspaceId, flowInstanceId: 'flow-1', stepInstanceId: 'step-1',
        requiredRole: 'RELEASE_REVIEWER', status: 'OPEN', createdAt: '2026-09-07T14:02:00.000Z',
      });

      expect((await store.list<{ id: string }>('flowInstances')).map((row) => row.id)).toEqual(['flow-1']);
      expect((await store.list<{ id: string }>('flowStepInstances')).map((row) => row.id)).toEqual(['step-1']);
      expect((await store.list<{ id: string }>('flowSignals')).map((row) => row.id)).toEqual(['signal-1']);
      expect((await store.list<{ id: string }>('humanTasks')).map((row) => row.id)).toEqual(['task-1']);

      const [flow] = await store.list<Record<string, unknown> & { id: string }>('flowInstances');
      await store.replace('flowInstances', {
        ...flow,
        state: 'RUNNING',
        updatedAt: '2026-09-07T14:03:00.000Z',
      });
      expect((await store.list<{ state: string }>('flowInstances'))[0]?.state).toBe('RUNNING');
    });
  });

  it('commits flow state, audit and outbox together through one PostgreSQL transaction', async () => {
    const store = new PostgresTrustStore(database.sql);
    await withTrustScope(scope, async () => {
      await store.transaction(async (tx) => {
        const [flow] = await tx.list<Record<string, unknown> & { id: string }>('flowInstances');
        await tx.replace('flowInstances', {
          ...flow,
          state: 'WAITING_EVENT',
          updatedAt: '2026-09-07T14:04:00.000Z',
        });
        await tx.audit({
          tenantId,
          workspaceId,
          actorId,
          eventType: 'FLOW_WAITING_EVENT',
          aggregateType: 'FlowInstance',
          aggregateId: 'flow-1',
          correlationId: 'corr-1',
          metadata: { stepDefinitionId: 'evidence_submission' },
        });
        await tx.emit({
          tenantId,
          workspaceId,
          aggregateType: 'FlowInstance',
          aggregateId: 'flow-1',
          eventType: 'FLOW_WAITING_EVENT',
          eventVersion: 1,
          payload: { stepDefinitionId: 'evidence_submission' },
          correlationId: 'corr-1',
        });
      });

      expect((await store.list<{ state: string }>('flowInstances'))[0]?.state).toBe('WAITING_EVENT');
      expect((await store.list<{ eventType: string }>('auditRecords')).some((row) => row.eventType === 'FLOW_WAITING_EVENT')).toBe(true);
      expect((await store.list<{ eventType: string }>('outboxEvents')).some((row) => row.eventType === 'FLOW_WAITING_EVENT')).toBe(true);
    });
  });

  it('rolls back flow state when a later write in the same transaction fails', async () => {
    const store = new PostgresTrustStore(database.sql);
    await expect(withTrustScope(scope, async () => {
      await store.transaction(async (tx) => {
        const [flow] = await tx.list<Record<string, unknown> & { id: string }>('flowInstances');
        await tx.replace('flowInstances', {
          ...flow,
          state: 'FAILED',
          updatedAt: '2026-09-07T14:05:00.000Z',
        });
        await tx.append('flowSignals', {
          id: 'signal-1', workspaceId, flowInstanceId: 'flow-1', eventType: 'DUPLICATE',
          idempotencyKey: 'duplicate', payload: {}, receivedAt: '2026-09-07T14:05:00.000Z',
        });
      });
    })).rejects.toThrow();

    await withTrustScope(scope, async () => {
      expect((await store.list<{ state: string }>('flowInstances'))[0]?.state).toBe('WAITING_EVENT');
    });
  });
});
