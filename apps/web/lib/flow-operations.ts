import type { RequestContext } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { FlowInstance, HumanTask, StepInstance } from '@assurapay/flow-orchestration';
import { trustStore } from './persistence';
import { flowRegistry } from './flow-app';

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

/**
 * One approval, with enough context for the person deciding it.
 *
 * `HumanTask` on its own carries a `flowInstanceId`, a `stepInstanceId` and a `requiredRole` — three
 * identifiers and nothing a person could act on. An inbox built from it would ask someone to approve
 * `step-7f3a` of `flow-91c4`, which is not a decision anybody can make responsibly.
 *
 * So the join happens here rather than in the browser. Two reasons beyond tidiness. The step's human
 * title lives in the `FlowDefinition`, which the server holds and the client has no business
 * learning; and an assertion is single-use, so every extra endpoint a screen calls is another
 * round-trip to mint one. This is one call.
 */
export type ApprovalInboxEntry = {
  taskId: string;
  flowInstanceId: string;
  /** The step's title as the product names it, not its internal id. */
  stepTitle: string;
  requiredRole: string;
  /** What the approval is about, in terms the approver can match to their own records. */
  transactionId: string;
  agreementId?: string;
  createdAt: string;
  /** Whether the signed-in caller holds the role this task requires. */
  actionable: boolean;
};

export type ApprovalInbox = {
  entries: ApprovalInboxEntry[];
  /**
   * Open approvals the caller cannot act on, counted rather than listed.
   *
   * Someone who cannot decide a task has no need of its details, but hiding it entirely would make
   * a queue look empty when it is merely not theirs — and that is exactly the confusion that leaves
   * a release waiting. The count says "there is work here, it is not yours".
   */
  waitingOnOthers: number;
};

/**
 * The signed-in caller's approval inbox.
 *
 * `actionable` is computed with the same membership predicate `FlowOrchestrator.decide` authorizes
 * with, so the inbox cannot offer a button that the decision would then refuse. A screen that showed
 * an Approve button to someone who would be rejected is worse than one that showed nothing.
 */
export async function getApprovalInbox(context: RequestContext): Promise<ApprovalInbox> {
  const workspace = workspaceId(context);

  const [tasks, flows, steps, memberships] = await Promise.all([
    trustStore.list<HumanTask>('humanTasks'),
    trustStore.list<FlowInstance>('flowInstances'),
    trustStore.list<StepInstance>('flowStepInstances'),
    trustStore.list<{ workspaceId: string; userId: string; status: string; role?: string; membershipType?: string }>(
      'memberships',
    ),
  ]);

  const myRoles = new Set(
    memberships
      .filter(
        (membership) =>
          membership.workspaceId === workspace &&
          membership.userId === context.actorUserId &&
          membership.status === 'ACTIVE',
      )
      .flatMap((membership) => [membership.role, membership.membershipType])
      .filter((role): role is string => Boolean(role)),
  );

  const flowById = new Map(flows.filter((flow) => flow.workspaceId === workspace).map((flow) => [flow.id, flow]));
  const stepById = new Map(steps.filter((step) => step.workspaceId === workspace).map((step) => [step.id, step]));

  const open = tasks
    .filter((task) => task.workspaceId === workspace && task.status === 'OPEN')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const entries: ApprovalInboxEntry[] = [];
  let waitingOnOthers = 0;

  for (const task of open) {
    const flow = flowById.get(task.flowInstanceId);
    // A task whose flow is not visible in this workspace is not this caller's business, and
    // reporting it without its context would be a reference to a record they cannot read.
    if (!flow) continue;

    const actionable = myRoles.has(task.requiredRole);
    if (!actionable) {
      waitingOnOthers++;
      continue;
    }

    entries.push({
      taskId: task.id,
      flowInstanceId: flow.id,
      stepTitle: flowStepTitle(flow.flowDefinitionId, flow.flowVersion, stepById.get(task.stepInstanceId)?.stepDefinitionId),
      requiredRole: task.requiredRole,
      transactionId: flow.transactionId,
      agreementId: flow.agreementId,
      createdAt: task.createdAt,
      actionable,
    });
  }

  return { entries, waitingOnOthers };
}

/** The step's title from its definition, falling back to a readable form of its id. */
function flowStepTitle(
  flowDefinitionId: string,
  flowVersion: number,
  stepDefinitionId: string | undefined,
): string {
  if (!stepDefinitionId) return 'An execution step';
  try {
    const step = flowRegistry
      .get(flowDefinitionId, flowVersion)
      .steps.find((candidate) => candidate.id === stepDefinitionId);
    if (step?.title) return step.title;
  } catch {
    // An unregistered definition must not stop an approval being shown; the readable id will do.
  }
  const words = stepDefinitionId.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
