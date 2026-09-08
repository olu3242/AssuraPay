import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { FlowOperations } from './operations';

const context = (workspace: string) => ({
  actorUserId: 'operator',
  sessionId: 'session',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: workspace,
  tenantId: `tenant-${workspace}`,
  memberships: [workspace],
  correlationId: `corr-${workspace}`,
});

const flow = (id: string, workspaceId: string, updatedAt: string) => ({
  id,
  workspaceId,
  flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
  flowVersion: 1,
  organizationId: `org-${workspaceId}`,
  transactionId: `tx-${id}`,
  initiatorId: 'operator',
  assuranceLevel: 'STANDARD' as const,
  state: 'WAITING_EVENT' as const,
  idempotencyKey: `start-${id}`,
  correlationId: `corr-${workspaceId}`,
  createdAt: updatedAt,
  updatedAt,
});

describe('FlowOperations', () => {
  it('lists only the active workspace and orders most recently updated first', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', flow('older', 'w1', '2026-09-08T00:00:00.000Z'));
    await store.append('flowInstances', flow('newer', 'w1', '2026-09-08T01:00:00.000Z'));
    await store.append('flowInstances', flow('other', 'w2', '2026-09-08T02:00:00.000Z'));

    const result = await new FlowOperations(store).list(context('w1'));
    expect(result.map((entry) => entry.id)).toEqual(['newer', 'older']);
  });

  it('builds a flow snapshot without leaking another workspace records', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', flow('f1', 'w1', '2026-09-08T00:00:00.000Z'));
    await store.append('flowStepInstances', {
      id: 's1', workspaceId: 'w1', flowInstanceId: 'f1', stepDefinitionId: 'evidence',
      state: 'WAITING_EVENT', attempts: 1, createdAt: '2026-09-08T00:01:00.000Z', updatedAt: '2026-09-08T00:01:00.000Z',
    });
    await store.append('flowStepInstances', {
      id: 's2', workspaceId: 'w2', flowInstanceId: 'f1', stepDefinitionId: 'wrong',
      state: 'READY', attempts: 0, createdAt: '2026-09-08T00:02:00.000Z', updatedAt: '2026-09-08T00:02:00.000Z',
    });
    await store.append('humanTasks', {
      id: 't1', workspaceId: 'w1', flowInstanceId: 'f1', stepInstanceId: 's1', requiredRole: 'RELEASE_APPROVER',
      status: 'OPEN', createdAt: '2026-09-08T00:03:00.000Z',
    });
    await store.append('flowSignals', {
      id: 'sig1', workspaceId: 'w1', flowInstanceId: 'f1', eventType: 'EvidencePackageVerified',
      idempotencyKey: 'evt-1', payload: {}, receivedAt: '2026-09-08T00:04:00.000Z',
    });

    const snapshot = await new FlowOperations(store).snapshot(context('w1'), 'f1');
    expect(snapshot.flow.id).toBe('f1');
    expect(snapshot.steps.map((entry) => entry.id)).toEqual(['s1']);
    expect(snapshot.tasks.map((entry) => entry.id)).toEqual(['t1']);
    expect(snapshot.signals.map((entry) => entry.id)).toEqual(['sig1']);
  });

  it('returns only open tasks for the active workspace', async () => {
    const store = new InMemoryTrustStore();
    await store.append('humanTasks', {
      id: 'open', workspaceId: 'w1', flowInstanceId: 'f1', stepInstanceId: 's1', requiredRole: 'RELEASE_APPROVER',
      status: 'OPEN', createdAt: '2026-09-08T00:00:00.000Z',
    });
    await store.append('humanTasks', {
      id: 'closed', workspaceId: 'w1', flowInstanceId: 'f2', stepInstanceId: 's2', requiredRole: 'RELEASE_APPROVER',
      status: 'APPROVED', createdAt: '2026-09-08T00:01:00.000Z',
    });
    await store.append('humanTasks', {
      id: 'other', workspaceId: 'w2', flowInstanceId: 'f3', stepInstanceId: 's3', requiredRole: 'RELEASE_APPROVER',
      status: 'OPEN', createdAt: '2026-09-08T00:02:00.000Z',
    });

    const tasks = await new FlowOperations(store).openTasks(context('w1'));
    expect(tasks.map((entry) => entry.id)).toEqual(['open']);
  });

  it('fails closed when the requested flow is outside the active workspace', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', flow('f2', 'w2', '2026-09-08T00:00:00.000Z'));
    await expect(new FlowOperations(store).snapshot(context('w1'), 'f2')).rejects.toThrow('NOT_FOUND');
  });
});
