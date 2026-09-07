import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const stamp = () => new Date().toISOString();
const workspace = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};

export type FlowState =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_DEPENDENCY'
  | 'WAITING_EVENT'
  | 'WAITING_TIMER'
  | 'WAITING_HUMAN'
  | 'WAITING_EXTERNAL_SYSTEM'
  | 'RETRY_PENDING'
  | 'COMPENSATING'
  | 'SUSPENDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPLETED';

export type FlowStepState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_EVENT'
  | 'WAITING_TIMER'
  | 'WAITING_HUMAN'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPENSATED';

export type FlowPattern =
  | 'SEQUENTIAL'
  | 'PARALLEL'
  | 'CONDITIONAL'
  | 'EVENT_DRIVEN'
  | 'HUMAN_IN_THE_LOOP'
  | 'LONG_RUNNING'
  | 'SAGA'
  | 'COMPENSATING'
  | 'SUBFLOW'
  | 'ADAPTIVE_ASSURANCE';

export type AssuranceLevel = 'LIGHT' | 'STANDARD' | 'ENHANCED' | 'HIGH_ASSURANCE' | 'INSTITUTIONAL';

export type RetryPolicy = {
  maxAttempts: number;
  backoffSeconds: number;
};

export type FlowStepDefinition = {
  id: string;
  title: string;
  handler?: string;
  pattern?: FlowPattern;
  dependencies?: string[];
  waitForEvent?: string;
  humanTaskRole?: string;
  timeoutSeconds?: number;
  retryPolicy?: RetryPolicy;
  compensationHandler?: string;
  requiredPolicy?: string;
  requiredAssuranceLevel?: AssuranceLevel;
};

export type FlowDefinition = {
  id: string;
  name: string;
  version: number;
  description: string;
  patterns: FlowPattern[];
  steps: FlowStepDefinition[];
};

export type FlowInstance = {
  id: string;
  workspaceId: string;
  flowDefinitionId: string;
  flowVersion: number;
  organizationId: string;
  transactionId: string;
  agreementId?: string;
  initiatorId: string;
  state: FlowState;
  assuranceLevel: AssuranceLevel;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type FlowStepInstance = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepDefinitionId: string;
  state: FlowStepState;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type FlowSignal = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  receivedAt: string;
};

export type FlowTimer = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepInstanceId: string;
  fireAt: string;
  status: 'SCHEDULED' | 'FIRED' | 'CANCELLED';
  createdAt: string;
};

export type HumanTask = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepInstanceId: string;
  taskType: string;
  requiredRole: string;
  assignedTo?: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'ESCALATED';
  decisionBy?: string;
  comment?: string;
  createdAt: string;
  completedAt?: string;
};

export type FlowStepHandlerResult =
  | { outcome: 'COMPLETED' }
  | { outcome: 'WAIT_EVENT'; eventType: string }
  | { outcome: 'WAIT_HUMAN'; role: string; taskType?: string }
  | { outcome: 'WAIT_EXTERNAL' };

export type FlowStepHandler = (input: {
  context: RequestContext;
  flow: FlowInstance;
  step: FlowStepInstance;
  definition: FlowStepDefinition;
}) => Promise<FlowStepHandlerResult>;

export class FlowRegistry {
  private readonly definitions = new Map<string, FlowDefinition>();

  register(definition: FlowDefinition) {
    const key = this.key(definition.id, definition.version);
    if (this.definitions.has(key)) throw new Error('FLOW_DEFINITION_ALREADY_REGISTERED');
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (ids.has(step.id)) throw new Error('FLOW_STEP_ID_DUPLICATE');
      ids.add(step.id);
    }
    for (const step of definition.steps)
      for (const dependency of step.dependencies ?? [])
        if (!ids.has(dependency)) throw new Error(`FLOW_DEPENDENCY_UNKNOWN:${dependency}`);
    this.definitions.set(key, definition);
    return definition;
  }

  get(id: string, version: number) {
    const definition = this.definitions.get(this.key(id, version));
    if (!definition) throw new Error('FLOW_DEFINITION_NOT_FOUND');
    return definition;
  }

  private key(id: string, version: number) {
    return `${id}@${version}`;
  }
}

async function findScoped<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = (await store.list<T>(collection)).find(
    (item) => item.id === id && item.workspaceId === workspace(context),
  );
  if (!found) throw new Error('NOT_FOUND');
  return found;
}

async function recordEvent(
  store: TrustPersistence,
  context: RequestContext,
  flowInstanceId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  const workspaceId = workspace(context);
  await store.audit({
    tenantId: context.tenantId,
    workspaceId,
    actorId: context.actorUserId,
    eventType,
    aggregateType: 'FlowInstance',
    aggregateId: flowInstanceId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId,
    aggregateType: 'FlowInstance',
    aggregateId: flowInstanceId,
    eventType,
    eventVersion: 1,
    payload,
    correlationId: context.correlationId,
  });
}

const assuranceOrder: AssuranceLevel[] = ['LIGHT', 'STANDARD', 'ENHANCED', 'HIGH_ASSURANCE', 'INSTITUTIONAL'];

export class AssuranceRoutingEngine {
  evaluate(input: {
    transactionAmountMinor: number;
    activeExposureMinor: number;
    cumulativeTransactionVolumeMinor: number;
    priorCompletionRate: number;
    priorDisputes: number;
    evidenceQuality: number;
    fundingConfidence: number;
    identityConfidence: number;
    riskScore: number;
  }): AssuranceLevel {
    let score = input.riskScore;
    if (input.transactionAmountMinor >= 100_000_000) score += 20;
    else if (input.transactionAmountMinor >= 10_000_000) score += 10;
    if (input.activeExposureMinor >= 250_000_000) score += 10;
    if (input.priorCompletionRate < 0.8) score += 10;
    if (input.priorDisputes > 0) score += Math.min(20, input.priorDisputes * 5);
    if (input.evidenceQuality < 0.7) score += 10;
    if (input.fundingConfidence < 0.7) score += 10;
    if (input.identityConfidence < 0.8) score += 10;
    if (input.cumulativeTransactionVolumeMinor > 0 && input.priorCompletionRate >= 0.95 && input.priorDisputes === 0) score -= 10;

    if (score >= 80) return 'INSTITUTIONAL';
    if (score >= 60) return 'HIGH_ASSURANCE';
    if (score >= 40) return 'ENHANCED';
    if (score >= 20) return 'STANDARD';
    return 'LIGHT';
  }
}

export class FlowOrchestrationEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly registry: FlowRegistry,
    private readonly handlers: Record<string, FlowStepHandler> = {},
  ) {}

  async startFlow(
    context: RequestContext,
    input: {
      flowDefinitionId: string;
      flowVersion: number;
      organizationId: string;
      transactionId: string;
      agreementId?: string;
      assuranceLevel?: AssuranceLevel;
      idempotencyKey: string;
    },
  ) {
    const workspaceId = workspace(context);
    this.registry.get(input.flowDefinitionId, input.flowVersion);
    const duplicate = (await this.store.list<FlowInstance>('flowInstances')).find(
      (flow) => flow.workspaceId === workspaceId && flow.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) return duplicate;

    const time = stamp();
    const flow: FlowInstance = {
      id: randomUUID(),
      workspaceId,
      flowDefinitionId: input.flowDefinitionId,
      flowVersion: input.flowVersion,
      organizationId: input.organizationId,
      transactionId: input.transactionId,
      agreementId: input.agreementId,
      initiatorId: context.actorUserId,
      state: 'READY',
      assuranceLevel: input.assuranceLevel ?? 'STANDARD',
      correlationId: context.correlationId,
      idempotencyKey: input.idempotencyKey,
      createdAt: time,
      updatedAt: time,
    };
    await this.store.append('flowInstances', flow);
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    for (const stepDefinition of definition.steps) {
      const step: FlowStepInstance = {
        id: randomUUID(),
        workspaceId,
        flowInstanceId: flow.id,
        stepDefinitionId: stepDefinition.id,
        state: 'PENDING',
        attempts: 0,
        updatedAt: time,
      };
      await this.store.append('flowStepInstances', step);
    }
    await recordEvent(this.store, context, flow.id, 'FLOW_STARTED', {
      flowDefinitionId: flow.flowDefinitionId,
      flowVersion: flow.flowVersion,
      transactionId: flow.transactionId,
    });
    return this.evaluateNextSteps(context, flow.id);
  }

  async getFlowState(context: RequestContext, id: string) {
    return findScoped<FlowInstance>(this.store, 'flowInstances', context, id);
  }

  async getSteps(context: RequestContext, flowInstanceId: string) {
    await this.getFlowState(context, flowInstanceId);
    return (await this.store.list<FlowStepInstance>('flowStepInstances')).filter(
      (step) => step.workspaceId === workspace(context) && step.flowInstanceId === flowInstanceId,
    );
  }

  async evaluateNextSteps(context: RequestContext, flowInstanceId: string) {
    let flow = await this.getFlowState(context, flowInstanceId);
    if (['FAILED', 'CANCELLED', 'COMPLETED', 'SUSPENDED'].includes(flow.state)) return flow;
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const steps = await this.getSteps(context, flow.id);
    const byDefinition = new Map(steps.map((step) => [step.stepDefinitionId, step]));

    if (steps.every((step) => ['COMPLETED', 'COMPENSATED', 'CANCELLED'].includes(step.state))) {
      flow = { ...flow, state: 'COMPLETED', completedAt: stamp(), updatedAt: stamp() };
      await this.store.replace('flowInstances', flow);
      await recordEvent(this.store, context, flow.id, 'FLOW_COMPLETED');
      return flow;
    }

    let madeReady = false;
    for (const stepDefinition of definition.steps) {
      const step = byDefinition.get(stepDefinition.id);
      if (!step || step.state !== 'PENDING') continue;
      const dependencies = stepDefinition.dependencies ?? [];
      const satisfied = dependencies.every((dependency) => byDefinition.get(dependency)?.state === 'COMPLETED');
      if (!satisfied) continue;
      if (
        stepDefinition.requiredAssuranceLevel &&
        assuranceOrder.indexOf(flow.assuranceLevel) < assuranceOrder.indexOf(stepDefinition.requiredAssuranceLevel)
      )
        continue;
      await this.store.replace('flowStepInstances', { ...step, state: 'READY', updatedAt: stamp() });
      madeReady = true;
      await recordEvent(this.store, context, flow.id, 'STEP_READY', { stepDefinitionId: stepDefinition.id });
    }

    const refreshed = await this.getSteps(context, flow.id);
    const waitingHuman = refreshed.some((step) => step.state === 'WAITING_HUMAN');
    const waitingEvent = refreshed.some((step) => step.state === 'WAITING_EVENT');
    const waitingTimer = refreshed.some((step) => step.state === 'WAITING_TIMER');
    const ready = refreshed.some((step) => step.state === 'READY');
    const nextState: FlowState = waitingHuman
      ? 'WAITING_HUMAN'
      : waitingEvent
        ? 'WAITING_EVENT'
        : waitingTimer
          ? 'WAITING_TIMER'
          : ready || madeReady
            ? 'RUNNING'
            : 'WAITING_DEPENDENCY';
    flow = { ...flow, state: nextState, updatedAt: stamp() };
    await this.store.replace('flowInstances', flow);
    return flow;
  }

  async dispatchStep(context: RequestContext, input: { flowInstanceId: string; stepDefinitionId: string }) {
    const flow = await this.getFlowState(context, input.flowInstanceId);
    if (['FAILED', 'CANCELLED', 'COMPLETED', 'SUSPENDED'].includes(flow.state)) throw new Error('FLOW_NOT_EXECUTABLE');
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const stepDefinition = definition.steps.find((step) => step.id === input.stepDefinitionId);
    if (!stepDefinition) throw new Error('FLOW_STEP_DEFINITION_NOT_FOUND');
    const step = (await this.getSteps(context, flow.id)).find((candidate) => candidate.stepDefinitionId === input.stepDefinitionId);
    if (!step) throw new Error('FLOW_STEP_NOT_FOUND');
    if (step.state !== 'READY') throw new Error('FLOW_STEP_NOT_READY');

    const running: FlowStepInstance = {
      ...step,
      state: 'RUNNING',
      attempts: step.attempts + 1,
      startedAt: step.startedAt ?? stamp(),
      updatedAt: stamp(),
    };
    await this.store.replace('flowStepInstances', running);
    await recordEvent(this.store, context, flow.id, 'STEP_STARTED', { stepDefinitionId: stepDefinition.id });

    if (stepDefinition.waitForEvent) {
      return this.waitForEvent(context, running, stepDefinition.waitForEvent);
    }
    if (stepDefinition.humanTaskRole) {
      return this.waitForHuman(context, running, stepDefinition.humanTaskRole, stepDefinition.title);
    }
    if (!stepDefinition.handler) return this.completeStep(context, flow.id, running.id);
    const handler = this.handlers[stepDefinition.handler];
    if (!handler) throw new Error(`FLOW_HANDLER_NOT_REGISTERED:${stepDefinition.handler}`);

    try {
      const result = await handler({ context, flow, step: running, definition: stepDefinition });
      if (result.outcome === 'COMPLETED') return this.completeStep(context, flow.id, running.id);
      if (result.outcome === 'WAIT_EVENT') return this.waitForEvent(context, running, result.eventType);
      if (result.outcome === 'WAIT_HUMAN') return this.waitForHuman(context, running, result.role, result.taskType ?? stepDefinition.title);
      const updated = { ...running, state: 'WAITING_EVENT' as const, updatedAt: stamp() };
      await this.store.replace('flowStepInstances', updated);
      await recordEvent(this.store, context, flow.id, 'FLOW_WAITING_EXTERNAL_SYSTEM', { stepDefinitionId: stepDefinition.id });
      return this.evaluateNextSteps(context, flow.id);
    } catch (error) {
      return this.failStep(context, flow.id, running.id, error instanceof Error ? error.message : 'UNKNOWN_STEP_FAILURE');
    }
  }

  async completeStep(context: RequestContext, flowInstanceId: string, stepInstanceId: string) {
    const step = await findScoped<FlowStepInstance>(this.store, 'flowStepInstances', context, stepInstanceId);
    if (step.flowInstanceId !== flowInstanceId) throw new Error('FLOW_STEP_MISMATCH');
    if (!['RUNNING', 'WAITING_EVENT', 'WAITING_HUMAN', 'WAITING_TIMER'].includes(step.state)) throw new Error('FLOW_STEP_NOT_COMPLETABLE');
    await this.store.replace('flowStepInstances', { ...step, state: 'COMPLETED', completedAt: stamp(), updatedAt: stamp() });
    await recordEvent(this.store, context, flowInstanceId, 'STEP_COMPLETED', { stepDefinitionId: step.stepDefinitionId });
    return this.evaluateNextSteps(context, flowInstanceId);
  }

  async failStep(context: RequestContext, flowInstanceId: string, stepInstanceId: string, reason: string) {
    const flow = await this.getFlowState(context, flowInstanceId);
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const step = await findScoped<FlowStepInstance>(this.store, 'flowStepInstances', context, stepInstanceId);
    const stepDefinition = definition.steps.find((candidate) => candidate.id === step.stepDefinitionId);
    const retry = stepDefinition?.retryPolicy;
    if (retry && step.attempts < retry.maxAttempts) {
      await this.store.replace('flowStepInstances', { ...step, state: 'READY', lastError: reason, updatedAt: stamp() });
      await recordEvent(this.store, context, flow.id, 'STEP_RETRY_SCHEDULED', {
        stepDefinitionId: step.stepDefinitionId,
        attempt: step.attempts,
        backoffSeconds: retry.backoffSeconds,
      });
      await this.store.replace('flowInstances', { ...flow, state: 'RETRY_PENDING', updatedAt: stamp() });
      return this.getFlowState(context, flow.id);
    }
    await this.store.replace('flowStepInstances', { ...step, state: 'FAILED', lastError: reason, updatedAt: stamp() });
    await this.store.replace('flowInstances', { ...flow, state: 'FAILED', updatedAt: stamp() });
    await recordEvent(this.store, context, flow.id, 'STEP_FAILED', { stepDefinitionId: step.stepDefinitionId, reason });
    return this.getFlowState(context, flow.id);
  }

  async receiveSignal(
    context: RequestContext,
    input: { flowInstanceId: string; eventType: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ) {
    const flow = await this.getFlowState(context, input.flowInstanceId);
    const existing = (await this.store.list<FlowSignal>('flowSignals')).find(
      (signal) => signal.workspaceId === workspace(context) && signal.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return flow;
    const signal: FlowSignal = {
      id: randomUUID(),
      workspaceId: workspace(context),
      flowInstanceId: flow.id,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      receivedAt: stamp(),
    };
    await this.store.append('flowSignals', signal);
    await recordEvent(this.store, context, flow.id, 'SIGNAL_RECEIVED', { eventType: input.eventType });

    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const steps = await this.getSteps(context, flow.id);
    for (const step of steps) {
      if (step.state !== 'WAITING_EVENT') continue;
      const stepDefinition = definition.steps.find((candidate) => candidate.id === step.stepDefinitionId);
      if (stepDefinition?.waitForEvent === input.eventType) await this.completeStep(context, flow.id, step.id);
    }
    return this.evaluateNextSteps(context, flow.id);
  }

  async scheduleTimer(context: RequestContext, input: { flowInstanceId: string; stepInstanceId: string; fireAt: string }) {
    const step = await findScoped<FlowStepInstance>(this.store, 'flowStepInstances', context, input.stepInstanceId);
    if (step.flowInstanceId !== input.flowInstanceId) throw new Error('FLOW_STEP_MISMATCH');
    const timer: FlowTimer = {
      id: randomUUID(),
      workspaceId: workspace(context),
      flowInstanceId: input.flowInstanceId,
      stepInstanceId: input.stepInstanceId,
      fireAt: input.fireAt,
      status: 'SCHEDULED',
      createdAt: stamp(),
    };
    await this.store.append('flowTimers', timer);
    await this.store.replace('flowStepInstances', { ...step, state: 'WAITING_TIMER', updatedAt: stamp() });
    await recordEvent(this.store, context, input.flowInstanceId, 'TIMER_SCHEDULED', { timerId: timer.id, fireAt: timer.fireAt });
    await this.evaluateNextSteps(context, input.flowInstanceId);
    return timer;
  }

  async fireTimer(context: RequestContext, timerId: string) {
    const timer = await findScoped<FlowTimer>(this.store, 'flowTimers', context, timerId);
    if (timer.status !== 'SCHEDULED') return this.getFlowState(context, timer.flowInstanceId);
    await this.store.replace('flowTimers', { ...timer, status: 'FIRED' });
    await recordEvent(this.store, context, timer.flowInstanceId, 'TIMER_FIRED', { timerId });
    return this.completeStep(context, timer.flowInstanceId, timer.stepInstanceId);
  }

  async decideHumanTask(
    context: RequestContext,
    input: { taskId: string; decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'ESCALATE'; comment?: string },
  ) {
    const task = await findScoped<HumanTask>(this.store, 'humanTasks', context, input.taskId);
    if (task.status !== 'OPEN') throw new Error('HUMAN_TASK_NOT_OPEN');
    const status: HumanTask['status'] =
      input.decision === 'APPROVE'
        ? 'APPROVED'
        : input.decision === 'REJECT'
          ? 'REJECTED'
          : input.decision === 'REQUEST_CHANGES'
            ? 'CHANGES_REQUESTED'
            : 'ESCALATED';
    await this.store.replace('humanTasks', {
      ...task,
      status,
      decisionBy: context.actorUserId,
      comment: input.comment,
      completedAt: stamp(),
    });
    await recordEvent(this.store, context, task.flowInstanceId, 'HUMAN_TASK_DECIDED', { taskId: task.id, decision: input.decision });
    if (input.decision === 'APPROVE') return this.completeStep(context, task.flowInstanceId, task.stepInstanceId);
    if (input.decision === 'REJECT') return this.failStep(context, task.flowInstanceId, task.stepInstanceId, 'HUMAN_TASK_REJECTED');
    return this.evaluateNextSteps(context, task.flowInstanceId);
  }

  async suspendFlow(context: RequestContext, flowInstanceId: string, reason: string) {
    if (!reason.trim()) throw new Error('SUSPENSION_REASON_REQUIRED');
    const flow = await this.getFlowState(context, flowInstanceId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(flow.state)) throw new Error('FLOW_NOT_SUSPENDABLE');
    await this.store.replace('flowInstances', { ...flow, state: 'SUSPENDED', updatedAt: stamp() });
    await recordEvent(this.store, context, flow.id, 'FLOW_SUSPENDED', { reason });
    return this.getFlowState(context, flow.id);
  }

  async resumeFlow(context: RequestContext, flowInstanceId: string) {
    const flow = await this.getFlowState(context, flowInstanceId);
    if (flow.state !== 'SUSPENDED') throw new Error('FLOW_NOT_SUSPENDED');
    await this.store.replace('flowInstances', { ...flow, state: 'READY', updatedAt: stamp() });
    await recordEvent(this.store, context, flow.id, 'FLOW_RESUMED');
    return this.evaluateNextSteps(context, flow.id);
  }

  async cancelFlow(context: RequestContext, flowInstanceId: string, reason: string) {
    if (!reason.trim()) throw new Error('CANCELLATION_REASON_REQUIRED');
    const flow = await this.getFlowState(context, flowInstanceId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(flow.state)) throw new Error('FLOW_NOT_CANCELLABLE');
    const steps = await this.getSteps(context, flow.id);
    for (const step of steps)
      if (!['COMPLETED', 'COMPENSATED', 'CANCELLED'].includes(step.state))
        await this.store.replace('flowStepInstances', { ...step, state: 'CANCELLED', updatedAt: stamp() });
    await this.store.replace('flowInstances', { ...flow, state: 'CANCELLED', updatedAt: stamp() });
    await recordEvent(this.store, context, flow.id, 'FLOW_CANCELLED', { reason });
    return this.getFlowState(context, flow.id);
  }

  private async waitForEvent(context: RequestContext, step: FlowStepInstance, eventType: string) {
    await this.store.replace('flowStepInstances', { ...step, state: 'WAITING_EVENT', updatedAt: stamp() });
    await recordEvent(this.store, context, step.flowInstanceId, 'FLOW_WAITING_EVENT', {
      stepDefinitionId: step.stepDefinitionId,
      eventType,
    });
    return this.evaluateNextSteps(context, step.flowInstanceId);
  }

  private async waitForHuman(context: RequestContext, step: FlowStepInstance, role: string, taskType: string) {
    await this.store.replace('flowStepInstances', { ...step, state: 'WAITING_HUMAN', updatedAt: stamp() });
    const task: HumanTask = {
      id: randomUUID(),
      workspaceId: workspace(context),
      flowInstanceId: step.flowInstanceId,
      stepInstanceId: step.id,
      taskType,
      requiredRole: role,
      status: 'OPEN',
      createdAt: stamp(),
    };
    await this.store.append('humanTasks', task);
    await recordEvent(this.store, context, step.flowInstanceId, 'HUMAN_TASK_CREATED', { taskId: task.id, role });
    await this.evaluateNextSteps(context, step.flowInstanceId);
    return task;
  }
}

export const COMMERCIAL_COMMITMENT_FLOW_V1: FlowDefinition = {
  id: 'COMMERCIAL_COMMITMENT_FLOW',
  name: 'Commercial Commitment Flow',
  version: 1,
  description: 'Non-custodial commercial execution assurance from agreement through verified settlement.',
  patterns: ['SEQUENTIAL', 'EVENT_DRIVEN', 'HUMAN_IN_THE_LOOP', 'LONG_RUNNING', 'ADAPTIVE_ASSURANCE'],
  steps: [
    { id: 'agreement_intelligence', title: 'Analyze executed agreement', handler: 'agreementIntelligence' },
    { id: 'performance_blueprint', title: 'Establish performance blueprint', handler: 'performanceBlueprint', dependencies: ['agreement_intelligence'] },
    { id: 'definition_of_done', title: 'Establish definition of done', handler: 'definitionOfDone', dependencies: ['performance_blueprint'] },
    { id: 'milestone_activation', title: 'Activate milestone execution', handler: 'milestoneActivation', dependencies: ['definition_of_done'] },
    { id: 'evidence_submission', title: 'Receive required evidence', dependencies: ['milestone_activation'], waitForEvent: 'EVIDENCE_SUBMITTED' },
    { id: 'evidence_validation', title: 'Validate evidence', handler: 'evidenceValidation', dependencies: ['evidence_submission'], retryPolicy: { maxAttempts: 3, backoffSeconds: 30 } },
    { id: 'risk_evaluation', title: 'Evaluate execution risk', handler: 'riskEvaluation', dependencies: ['evidence_validation'] },
    { id: 'assurance_evaluation', title: 'Evaluate adaptive assurance', handler: 'assuranceEvaluation', dependencies: ['risk_evaluation'] },
    { id: 'release_eligibility', title: 'Evaluate release eligibility', handler: 'releaseEligibility', dependencies: ['assurance_evaluation'] },
    { id: 'enhanced_approval', title: 'Independent approval', dependencies: ['release_eligibility'], humanTaskRole: 'RELEASE_REVIEWER', requiredAssuranceLevel: 'ENHANCED' },
    { id: 'settlement_observation', title: 'Observe external settlement', dependencies: ['release_eligibility'], waitForEvent: 'SETTLEMENT_CONFIRMED' },
    { id: 'milestone_closure', title: 'Close milestone', handler: 'milestoneClosure', dependencies: ['settlement_observation'] },
    { id: 'trust_update', title: 'Update progressive trust history', handler: 'trustUpdate', dependencies: ['milestone_closure'] },
  ],
};
