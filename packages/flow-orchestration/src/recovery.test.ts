import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { FlowRecovery } from './recovery';

const context = {
  actorUserId: 'operator',
  sessionId: 'session',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w1',
  tenantId: 't1',
  memberships: ['w1'],
  correlationId: 'corr-1',
};

const failedFlow = {
  id: 'flow-1', workspaceId: 'w1', flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW', flowVersion: 1,
  organizationId: 'org-1', transactionId: 'tx-1', initiatorId: 'operator', assuranceLevel: 'STANDARD' as const,
  state: 'FAILED' as const, idempotencyKey: 'start-1', correlationId: 'corr-1',
  createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:05:00.000Z',
};

const failedStep = {
  id: 'step-1', workspaceId: 'w1', flowInstanceId: 'flow-1', stepDefinitionId: 'validation',
  state: 'FAILED' as const, attempts: 3, lastError: 'provider timeout',
  createdAt: '2026-09-08T00:01:00.000Z', updatedAt: '2026-09-08T00:05:00.000Z',
};

describe('FlowRecovery', () => {
  it('requeues only the failed orchestration step and records a governed recovery event', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', failedFlow);
    await store.append('flowStepInstances', failedStep);

    const result = await new FlowRecovery(store).retry(context, 'flow-1', 'Provider is healthy; operator approved retry');

    expect(result.flow.state).toBe('READY');
    expect(result.step.state).toBe('READY');
    expect(result.step.attempts).toBe(3);
    expect(result.step.lastError).toBe('provider timeout');
    expect((await store.list('flowInstances'))[0]).toMatchObject({ id: 'flow-1', state: 'READY' });
    expect((await store.list('flowStepInstances'))[0]).toMatchObject({ id: 'step-1', state: 'READY' });
  });

  it('requires an operator reason and fails closed outside the active workspace', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', { ...failedFlow, workspaceId: 'w2' });
    await store.append('flowStepInstances', { ...failedStep, workspaceId: 'w2' });
    const recovery = new FlowRecovery(store);

    await expect(recovery.retry(context, 'flow-1', '')).rejects.toThrow('FLOW_RECOVERY_REASON_REQUIRED');
    await expect(recovery.retry(context, 'flow-1', 'retry')).rejects.toThrow('NOT_FOUND');
  });

  it('refuses recovery for a flow that is not failed or retry-pending', async () => {
    const store = new InMemoryTrustStore();
    await store.append('flowInstances', { ...failedFlow, state: 'WAITING_EVENT' });
    await store.append('flowStepInstances', failedStep);

    await expect(new FlowRecovery(store).retry(context, 'flow-1', 'retry')).rejects.toThrow('FLOW_NOT_RECOVERABLE');
  });
});
