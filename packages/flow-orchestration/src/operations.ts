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

export type FlowHealthStatus = 'HEALTHY' | 'ATTENTION' | 'CRITICAL';
export type FlowRecoveryAction =
  | 'NONE'
  | 'INVESTIGATE_STALLED_FLOW'
  | 'ESCALATE_HUMAN_TASK'
  | 'RETRY_FAILED_STEP'
  | 'RESUME_OR_CANCEL_FLOW'
  | 'RECOVER_FAILED_FLOW';

export type FlowHealthRecord = {
  flowId: string;
  transactionId: string;
  state: FlowInstance['state'];
  status: FlowHealthStatus;
  ageMs: number;
  openTaskCount: number;
  oldestOpenTaskAgeMs: number;
  recommendedAction: FlowRecoveryAction;
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

  async health(
    context: RequestContext,
    options: { now?: Date; stalledAfterMs?: number; humanTaskAgingMs?: number } = {},
  ) {
    const nowMs = (options.now ?? new Date()).getTime();
    const stalledAfterMs = options.stalledAfterMs ?? 60 * 60 * 1000;
    const humanTaskAgingMs = options.humanTaskAgingMs ?? 30 * 60 * 1000;
    const flows = await this.list(context);
    const tasks = await this.openTasks(context);

    const records: FlowHealthRecord[] = flows.map((flow) => {
      const flowTasks = tasks.filter((task) => task.flowInstanceId === flow.id);
      const ageMs = Math.max(0, nowMs - new Date(flow.updatedAt).getTime());
      const taskAges = flowTasks.map((task) => Math.max(0, nowMs - new Date(task.createdAt).getTime()));
      const oldestOpenTaskAgeMs = taskAges.length ? Math.max(...taskAges) : 0;

      let status: FlowHealthStatus = 'HEALTHY';
      let recommendedAction: FlowRecoveryAction = 'NONE';

      if (flow.state === 'FAILED') {
        status = 'CRITICAL';
        recommendedAction = 'RECOVER_FAILED_FLOW';
      } else if (flow.state === 'RETRY_PENDING') {
        status = 'ATTENTION';
        recommendedAction = 'RETRY_FAILED_STEP';
      } else if (flow.state === 'SUSPENDED') {
        status = 'ATTENTION';
        recommendedAction = 'RESUME_OR_CANCEL_FLOW';
      } else if (flow.state === 'WAITING_HUMAN' && oldestOpenTaskAgeMs >= humanTaskAgingMs) {
        status = 'ATTENTION';
        recommendedAction = 'ESCALATE_HUMAN_TASK';
      } else if (
        ['RUNNING', 'WAITING_EVENT', 'WAITING_DEPENDENCY'].includes(flow.state) &&
        ageMs >= stalledAfterMs
      ) {
        status = 'ATTENTION';
        recommendedAction = 'INVESTIGATE_STALLED_FLOW';
      }

      return {
        flowId: flow.id,
        transactionId: flow.transactionId,
        state: flow.state,
        status,
        ageMs,
        openTaskCount: flowTasks.length,
        oldestOpenTaskAgeMs,
        recommendedAction,
      };
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
}
