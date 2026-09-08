import type { RequestContext } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { FlowInstance, HumanTask, StepInstance } from '@assurapay/flow-orchestration';
import { trustStore } from './persistence';

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

export async function listFlows(context: RequestContext) {
  const workspace = workspaceId(context);
  return (await trustStore.list<FlowInstance>('flowInstances'))
    .filter((flow) => flow.workspaceId === workspace)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getFlowSnapshot(context: RequestContext, flowId: string) {
  const workspace = workspaceId(context);
  const flow = (await trustStore.list<FlowInstance>('flowInstances')).find(
    (candidate) => candidate.id === flowId && candidate.workspaceId === workspace,
  );
  if (!flow) throw new Error('NOT_FOUND');

  const [steps, tasks, signals] = await Promise.all([
    trustStore.list<StepInstance>('flowStepInstances'),
    trustStore.list<HumanTask>('humanTasks'),
    trustStore.list<FlowSignal>('flowSignals'),
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

export async function listOpenFlowTasks(context: RequestContext) {
  const workspace = workspaceId(context);
  return (await trustStore.list<HumanTask>('humanTasks'))
    .filter((task) => task.workspaceId === workspace && task.status === 'OPEN')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
