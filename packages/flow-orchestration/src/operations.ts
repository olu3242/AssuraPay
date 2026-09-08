import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { FlowInstance, HumanTask, StepInstance } from './index';

type FlowSignal = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  receivedAt: string;
};

const workspaceId = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};

export class FlowOperations {
  constructor(private readonly store: TrustPersistence) {}

  async list(context: RequestContext) {
    const workspace = workspaceId(context);
    return (await this.store.list<FlowInstance>('flowInstances'))
      .filter((flow) => flow.workspaceId === workspace)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async snapshot(context: RequestContext, flowId: string) {
    const workspace = workspaceId(context);
    const flow = (await this.store.list<FlowInstance>('flowInstances')).find(
      (candidate) => candidate.id === flowId && candidate.workspaceId === workspace,
    );
    if (!flow) throw new Error('NOT_FOUND');

    const [steps, tasks, signals] = await Promise.all([
      this.store.list<StepInstance>('flowStepInstances'),
      this.store.list<HumanTask>('humanTasks'),
      this.store.list<FlowSignal>('flowSignals'),
    ]);

    return {
      flow,
      steps: steps
        .filter((step) => step.workspaceId === workspace && step.flowInstanceId === flowId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      tasks: tasks
        .filter((task) => task.workspaceId === workspace && task.flowInstanceId === flowId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      signals: signals
        .filter((signal) => signal.workspaceId === workspace && signal.flowInstanceId === flowId)
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt)),
    };
  }

  async openTasks(context: RequestContext) {
    const workspace = workspaceId(context);
    return (await this.store.list<HumanTask>('humanTasks'))
      .filter((task) => task.workspaceId === workspace && task.status === 'OPEN')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
