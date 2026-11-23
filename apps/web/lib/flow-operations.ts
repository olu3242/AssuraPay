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

export async function getFlowHealth(context: RequestContext, now = new Date()) {
  const flows = await listFlows(context);
  const tasks = await listOpenFlowTasks(context);
  const nowMs = now.getTime();
  const stalledAfterMs = 60 * 60 * 1000;
  const humanTaskAgingMs = 30 * 60 * 1000;

  const records = flows.map((flow) => {
    const flowTasks = tasks.filter((task) => task.flowInstanceId === flow.id);
    const ageMs = Math.max(0, nowMs - new Date(flow.updatedAt).getTime());
    const oldestOpenTaskAgeMs = flowTasks.length
      ? Math.max(...flowTasks.map((task) => Math.max(0, nowMs - new Date(task.createdAt).getTime())))
      : 0;

    let status: 'HEALTHY' | 'ATTENTION' | 'CRITICAL' = 'HEALTHY';
    let recommendedAction = 'NONE';
    if (flow.state === 'FAILED') {
      status = 'CRITICAL'; recommendedAction = 'RECOVER_FAILED_FLOW';
    } else if (flow.state === 'RETRY_PENDING') {
      status = 'ATTENTION'; recommendedAction = 'RETRY_FAILED_STEP';
    } else if (flow.state === 'SUSPENDED') {
      status = 'ATTENTION'; recommendedAction = 'RESUME_OR_CANCEL_FLOW';
    } else if (flow.state === 'WAITING_HUMAN' && oldestOpenTaskAgeMs >= humanTaskAgingMs) {
      status = 'ATTENTION'; recommendedAction = 'ESCALATE_HUMAN_TASK';
    } else if (['RUNNING', 'WAITING_EVENT', 'WAITING_DEPENDENCY'].includes(flow.state) && ageMs >= stalledAfterMs) {
      status = 'ATTENTION'; recommendedAction = 'INVESTIGATE_STALLED_FLOW';
    }

    return { flowId: flow.id, transactionId: flow.transactionId, state: flow.state, status, ageMs, openTaskCount: flowTasks.length, oldestOpenTaskAgeMs, recommendedAction };
  });

  return {
    records,
    metrics: {
      totalFlows: records.length,
      healthyFlows: records.filter((record) => record.status === 'HEALTHY').length,
      attentionFlows: records.filter((record) => record.status === 'ATTENTION').length,
      criticalFlows: records.filter((record) => record.status === 'CRITICAL').length,
      openHumanTasks: tasks.length,
      stalledFlows: records.filter((record) => record.recommendedAction === 'INVESTIGATE_STALLED_FLOW').length,
    },
  };
}
