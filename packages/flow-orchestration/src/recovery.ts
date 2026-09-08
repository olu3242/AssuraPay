import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { FlowInstance, StepInstance } from './index';

const now = () => new Date().toISOString();
const workspaceId = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};

export class FlowRecovery {
  constructor(private readonly store: TrustPersistence) {}

  async retry(context: RequestContext, flowId: string, reason: string) {
    if (!reason.trim()) throw new Error('FLOW_RECOVERY_REASON_REQUIRED');
    const workspace = workspaceId(context);
    const flow = (await this.store.list<FlowInstance>('flowInstances')).find(
      (candidate) => candidate.id === flowId && candidate.workspaceId === workspace,
    );
    if (!flow) throw new Error('NOT_FOUND');
    if (flow.state !== 'FAILED' && flow.state !== 'RETRY_PENDING') throw new Error('FLOW_NOT_RECOVERABLE');

    const steps = (await this.store.list<StepInstance>('flowStepInstances')).filter(
      (step) => step.workspaceId === workspace && step.flowInstanceId === flow.id,
    );
    const failed = steps.find((step) => step.state === 'FAILED');
    const retryReady = steps.find((step) => step.state === 'READY' && Boolean(step.lastError));
    const target = failed ?? retryReady;
    if (!target) throw new Error('FLOW_RECOVERY_STEP_NOT_FOUND');

    const recoveredStep: StepInstance = {
      ...target,
      state: 'READY',
      updatedAt: now(),
    };
    const recoveredFlow: FlowInstance = {
      ...flow,
      state: 'READY',
      updatedAt: now(),
    };

    await this.store.transaction(async (tx) => {
      await tx.replace('flowStepInstances', recoveredStep);
      await tx.replace('flowInstances', recoveredFlow);
      await tx.audit({
        tenantId: context.tenantId,
        workspaceId: workspace,
        actorId: context.actorUserId,
        eventType: 'FLOW_RECOVERY_REQUESTED',
        aggregateType: 'FlowInstance',
        aggregateId: flow.id,
        correlationId: context.correlationId,
        metadata: { stepDefinitionId: target.stepDefinitionId, reason },
      });
      await tx.emit({
        tenantId: context.tenantId,
        workspaceId: workspace,
        aggregateType: 'FlowInstance',
        aggregateId: flow.id,
        eventType: 'FLOW_RECOVERY_REQUESTED',
        eventVersion: 1,
        payload: { stepDefinitionId: target.stepDefinitionId, reason },
        correlationId: context.correlationId,
      });
    });

    return { flow: recoveredFlow, step: recoveredStep };
  }
}
