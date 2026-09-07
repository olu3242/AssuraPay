import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const ws = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};

export type FlowState =
  | 'READY'
  | 'RUNNING'
  | 'WAITING_DEPENDENCY'
  | 'WAITING_EVENT'
  | 'WAITING_HUMAN'
  | 'RETRY_PENDING'
  | 'SUSPENDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPLETED';

export type StepState = 'PENDING' | 'READY' | 'RUNNING' | 'WAITING_EVENT' | 'WAITING_HUMAN' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
export type AssuranceLevel = 'LIGHT' | 'STANDARD' | 'ENHANCED' | 'HIGH_ASSURANCE' | 'INSTITUTIONAL';

export type FlowStepDefinition = {
  id: string;
  title: string;
  handler?: string;
  dependencies?: string[];
  waitForEvent?: string;
  humanTaskRole?: string;
  minimumAssurance?: AssuranceLevel;
  retry?: { maxAttempts: number; backoffSeconds: number };
};

export type FlowDefinition = {
  id: string;
  version: number;
  name: string;
  description: string;
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
  assuranceLevel: AssuranceLevel;
  state: FlowState;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type StepInstance = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepDefinitionId: string;
  state: StepState;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type HumanTask = {
  id: string;
  workspaceId: string;
  flowInstanceId: string;
  stepInstanceId: string;
  requiredRole: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  completedAt?: string;
};

export type StepHandler = (input: {
  context: RequestContext;
  flow: FlowInstance;
  step: StepInstance;
  definition: FlowStepDefinition;
}) => Promise<'COMPLETED'>;

const assuranceOrder: AssuranceLevel[] = ['LIGHT', 'STANDARD', 'ENHANCED', 'HIGH_ASSURANCE', 'INSTITUTIONAL'];

export class FlowRegistry {
  private readonly definitions = new Map<string, FlowDefinition>();

  register(definition: FlowDefinition) {
    const key = `${definition.id}@${definition.version}`;
    if (this.definitions.has(key)) throw new Error('FLOW_DEFINITION_ALREADY_REGISTERED');
    const ids = new Set(definition.steps.map((step) => step.id));
    if (ids.size !== definition.steps.length) throw new Error('FLOW_STEP_ID_DUPLICATE');
    for (const step of definition.steps)
      for (const dependency of step.dependencies ?? [])
        if (!ids.has(dependency)) throw new Error(`FLOW_DEPENDENCY_UNKNOWN:${dependency}`);
    this.definitions.set(key, definition);
    return definition;
  }

  get(id: string, version: number) {
    const definition = this.definitions.get(`${id}@${version}`);
    if (!definition) throw new Error('FLOW_DEFINITION_NOT_FOUND');
    return definition;
  }
}

async function scoped<T extends { id: string; workspaceId: string }>(store: TrustPersistence, collection: string, context: RequestContext, id: string) {
  const item = (await store.list<T>(collection)).find((candidate) => candidate.id === id && candidate.workspaceId === ws(context));
  if (!item) throw new Error('NOT_FOUND');
  return item;
}

async function emit(store: TrustPersistence, context: RequestContext, flowId: string, eventType: string, payload: Record<string, unknown> = {}) {
  await store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType: 'FlowInstance',
    aggregateId: flowId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    aggregateType: 'FlowInstance',
    aggregateId: flowId,
    eventType,
    eventVersion: 1,
    payload,
    correlationId: context.correlationId,
  });
}

export class AssuranceRoutingEngine {
  evaluate(input: {
    transactionAmountMinor: number;
    activeExposureMinor: number;
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
    private readonly handlers: Record<string, StepHandler> = {},
  ) {}

  async start(context: RequestContext, input: {
    flowDefinitionId: string;
    flowVersion: number;
    organizationId: string;
    transactionId: string;
    agreementId?: string;
    assuranceLevel?: AssuranceLevel;
    idempotencyKey: string;
  }) {
    const workspaceId = ws(context);
    const definition = this.registry.get(input.flowDefinitionId, input.flowVersion);
    const existing = (await this.store.list<FlowInstance>('flowInstances')).find(
      (flow) => flow.workspaceId === workspaceId && flow.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const time = now();
    const flow: FlowInstance = {
      id: randomUUID(), workspaceId,
      flowDefinitionId: definition.id, flowVersion: definition.version,
      organizationId: input.organizationId, transactionId: input.transactionId,
      agreementId: input.agreementId, initiatorId: context.actorUserId,
      assuranceLevel: input.assuranceLevel ?? 'STANDARD', state: 'READY',
      idempotencyKey: input.idempotencyKey, correlationId: context.correlationId,
      createdAt: time, updatedAt: time,
    };
    await this.store.append('flowInstances', flow);
    for (const stepDefinition of definition.steps) {
      const step: StepInstance = {
        id: randomUUID(), workspaceId, flowInstanceId: flow.id,
        stepDefinitionId: stepDefinition.id, state: 'PENDING', attempts: 0,
        createdAt: time, updatedAt: time,
      };
      await this.store.append('flowStepInstances', step);
    }
    await emit(this.store, context, flow.id, 'FLOW_STARTED', { transactionId: flow.transactionId, flowVersion: flow.flowVersion });
    return this.evaluate(context, flow.id);
  }

  async get(context: RequestContext, flowId: string) {
    return scoped<FlowInstance>(this.store, 'flowInstances', context, flowId);
  }

  async steps(context: RequestContext, flowId: string) {
    await this.get(context, flowId);
    return (await this.store.list<StepInstance>('flowStepInstances')).filter((step) => step.workspaceId === ws(context) && step.flowInstanceId === flowId);
  }

  async evaluate(context: RequestContext, flowId: string) {
    let flow = await this.get(context, flowId);
    if (['FAILED', 'CANCELLED', 'COMPLETED', 'SUSPENDED'].includes(flow.state)) return flow;
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const current = await this.steps(context, flow.id);
    const byId = new Map(current.map((step) => [step.stepDefinitionId, step]));

    for (const stepDefinition of definition.steps) {
      const step = byId.get(stepDefinition.id);
      if (!step || step.state !== 'PENDING') continue;
      if (stepDefinition.minimumAssurance && assuranceOrder.indexOf(flow.assuranceLevel) < assuranceOrder.indexOf(stepDefinition.minimumAssurance)) {
        await this.store.replace('flowStepInstances', { ...step, state: 'SKIPPED', updatedAt: now() });
        await emit(this.store, context, flow.id, 'STEP_SKIPPED', { stepDefinitionId: stepDefinition.id, reason: 'ASSURANCE_THRESHOLD_NOT_MET' });
        byId.set(stepDefinition.id, { ...step, state: 'SKIPPED', updatedAt: now() });
        continue;
      }
      const ready = (stepDefinition.dependencies ?? []).every((dependency) => {
        const state = byId.get(dependency)?.state;
        return state === 'COMPLETED' || state === 'SKIPPED';
      });
      if (!ready) continue;
      const updated: StepInstance = { ...step, state: 'READY', updatedAt: now() };
      await this.store.replace('flowStepInstances', updated);
      byId.set(stepDefinition.id, updated);
      await emit(this.store, context, flow.id, 'STEP_READY', { stepDefinitionId: stepDefinition.id });
    }

    const refreshed = await this.steps(context, flow.id);
    if (refreshed.every((step) => ['COMPLETED', 'SKIPPED', 'CANCELLED'].includes(step.state))) {
      flow = { ...flow, state: 'COMPLETED', updatedAt: now(), completedAt: now() };
      await this.store.replace('flowInstances', flow);
      await emit(this.store, context, flow.id, 'FLOW_COMPLETED');
      return flow;
    }
    const state: FlowState = refreshed.some((step) => step.state === 'WAITING_HUMAN') ? 'WAITING_HUMAN'
      : refreshed.some((step) => step.state === 'WAITING_EVENT') ? 'WAITING_EVENT'
      : refreshed.some((step) => step.state === 'READY' || step.state === 'RUNNING') ? 'RUNNING'
      : 'WAITING_DEPENDENCY';
    flow = { ...flow, state, updatedAt: now() };
    await this.store.replace('flowInstances', flow);
    return flow;
  }

  async dispatch(context: RequestContext, flowId: string, stepDefinitionId: string) {
    const flow = await this.get(context, flowId);
    if (['FAILED', 'CANCELLED', 'COMPLETED', 'SUSPENDED'].includes(flow.state)) throw new Error('FLOW_NOT_EXECUTABLE');
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    const stepDefinition = definition.steps.find((step) => step.id === stepDefinitionId);
    if (!stepDefinition) throw new Error('FLOW_STEP_DEFINITION_NOT_FOUND');
    const step = (await this.steps(context, flow.id)).find((candidate) => candidate.stepDefinitionId === stepDefinitionId);
    if (!step || step.state !== 'READY') throw new Error('FLOW_STEP_NOT_READY');
    const running: StepInstance = { ...step, state: 'RUNNING', attempts: step.attempts + 1, updatedAt: now() };
    await this.store.replace('flowStepInstances', running);
    await emit(this.store, context, flow.id, 'STEP_STARTED', { stepDefinitionId });

    if (stepDefinition.waitForEvent) {
      await this.store.replace('flowStepInstances', { ...running, state: 'WAITING_EVENT', updatedAt: now() });
      await emit(this.store, context, flow.id, 'FLOW_WAITING_EVENT', { stepDefinitionId, eventType: stepDefinition.waitForEvent });
      return this.evaluate(context, flow.id);
    }
    if (stepDefinition.humanTaskRole) {
      await this.store.replace('flowStepInstances', { ...running, state: 'WAITING_HUMAN', updatedAt: now() });
      const task: HumanTask = {
        id: randomUUID(), workspaceId: ws(context), flowInstanceId: flow.id, stepInstanceId: running.id,
        requiredRole: stepDefinition.humanTaskRole, status: 'OPEN', createdAt: now(),
      };
      await this.store.append('humanTasks', task);
      await emit(this.store, context, flow.id, 'HUMAN_TASK_CREATED', { taskId: task.id, requiredRole: task.requiredRole });
      await this.evaluate(context, flow.id);
      return task;
    }
    if (!stepDefinition.handler) return this.complete(context, flow.id, running.id);
    const handler = this.handlers[stepDefinition.handler];
    if (!handler) throw new Error(`FLOW_HANDLER_NOT_REGISTERED:${stepDefinition.handler}`);
    try {
      await handler({ context, flow, step: running, definition: stepDefinition });
      return this.complete(context, flow.id, running.id);
    } catch (error) {
      return this.fail(context, flow.id, running.id, error instanceof Error ? error.message : 'UNKNOWN_STEP_FAILURE');
    }
  }

  async signal(context: RequestContext, input: { flowId: string; eventType: string; idempotencyKey: string; payload?: Record<string, unknown> }) {
    const flow = await this.get(context, input.flowId);
    const duplicate = (await this.store.list<{ id: string; workspaceId: string; idempotencyKey: string }>('flowSignals')).find(
      (signal) => signal.workspaceId === ws(context) && signal.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) return flow;
    await this.store.append('flowSignals', {
      id: randomUUID(), workspaceId: ws(context), flowInstanceId: flow.id, eventType: input.eventType,
      idempotencyKey: input.idempotencyKey, payload: input.payload ?? {}, receivedAt: now(),
    });
    await emit(this.store, context, flow.id, 'SIGNAL_RECEIVED', { eventType: input.eventType });
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion);
    for (const step of await this.steps(context, flow.id)) {
      if (step.state !== 'WAITING_EVENT') continue;
      if (definition.steps.find((candidate) => candidate.id === step.stepDefinitionId)?.waitForEvent === input.eventType)
        await this.complete(context, flow.id, step.id);
    }
    return this.evaluate(context, flow.id);
  }

  async decide(context: RequestContext, taskId: string, decision: 'APPROVE' | 'REJECT') {
    const task = await scoped<HumanTask>(this.store, 'humanTasks', context, taskId);
    if (task.status !== 'OPEN') throw new Error('HUMAN_TASK_NOT_OPEN');
    await this.store.replace('humanTasks', { ...task, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', completedAt: now() });
    await emit(this.store, context, task.flowInstanceId, 'HUMAN_TASK_DECIDED', { taskId, decision });
    return decision === 'APPROVE'
      ? this.complete(context, task.flowInstanceId, task.stepInstanceId)
      : this.fail(context, task.flowInstanceId, task.stepInstanceId, 'HUMAN_TASK_REJECTED');
  }

  async suspend(context: RequestContext, flowId: string, reason: string) {
    if (!reason.trim()) throw new Error('SUSPENSION_REASON_REQUIRED');
    const flow = await this.get(context, flowId);
    if (['FAILED', 'CANCELLED', 'COMPLETED'].includes(flow.state)) throw new Error('FLOW_NOT_SUSPENDABLE');
    await this.store.replace('flowInstances', { ...flow, state: 'SUSPENDED', updatedAt: now() });
    await emit(this.store, context, flow.id, 'FLOW_SUSPENDED', { reason });
    return this.get(context, flow.id);
  }

  async resume(context: RequestContext, flowId: string) {
    const flow = await this.get(context, flowId);
    if (flow.state !== 'SUSPENDED') throw new Error('FLOW_NOT_SUSPENDED');
    await this.store.replace('flowInstances', { ...flow, state: 'READY', updatedAt: now() });
    await emit(this.store, context, flow.id, 'FLOW_RESUMED');
    return this.evaluate(context, flow.id);
  }

  private async complete(context: RequestContext, flowId: string, stepId: string) {
    const step = await scoped<StepInstance>(this.store, 'flowStepInstances', context, stepId);
    if (!['RUNNING', 'WAITING_EVENT', 'WAITING_HUMAN'].includes(step.state)) throw new Error('FLOW_STEP_NOT_COMPLETABLE');
    await this.store.replace('flowStepInstances', { ...step, state: 'COMPLETED', completedAt: now(), updatedAt: now() });
    await emit(this.store, context, flowId, 'STEP_COMPLETED', { stepDefinitionId: step.stepDefinitionId });
    return this.evaluate(context, flowId);
  }

  private async fail(context: RequestContext, flowId: string, stepId: string, reason: string) {
    const flow = await this.get(context, flowId);
    const step = await scoped<StepInstance>(this.store, 'flowStepInstances', context, stepId);
    const definition = this.registry.get(flow.flowDefinitionId, flow.flowVersion).steps.find((candidate) => candidate.id === step.stepDefinitionId);
    if (definition?.retry && step.attempts < definition.retry.maxAttempts) {
      await this.store.replace('flowStepInstances', { ...step, state: 'READY', lastError: reason, updatedAt: now() });
      await this.store.replace('flowInstances', { ...flow, state: 'RETRY_PENDING', updatedAt: now() });
      await emit(this.store, context, flow.id, 'STEP_RETRY_SCHEDULED', { stepDefinitionId: step.stepDefinitionId, attempt: step.attempts, backoffSeconds: definition.retry.backoffSeconds });
      return this.get(context, flow.id);
    }
    await this.store.replace('flowStepInstances', { ...step, state: 'FAILED', lastError: reason, updatedAt: now() });
    await this.store.replace('flowInstances', { ...flow, state: 'FAILED', updatedAt: now() });
    await emit(this.store, context, flow.id, 'STEP_FAILED', { stepDefinitionId: step.stepDefinitionId, reason });
    return this.get(context, flow.id);
  }
}

export const COMMERCIAL_COMMITMENT_FLOW_V1: FlowDefinition = {
  id: 'COMMERCIAL_COMMITMENT_FLOW',
  version: 1,
  name: 'Commercial Commitment Flow',
  description: 'Non-custodial agreement-to-settlement assurance orchestration.',
  steps: [
    { id: 'agreement_intelligence', title: 'Analyze agreement', handler: 'agreementIntelligence' },
    { id: 'performance_blueprint', title: 'Build performance blueprint', handler: 'performanceBlueprint', dependencies: ['agreement_intelligence'] },
    { id: 'definition_of_done', title: 'Establish definition of done', handler: 'definitionOfDone', dependencies: ['performance_blueprint'] },
    { id: 'milestone_activation', title: 'Activate milestone', handler: 'milestoneActivation', dependencies: ['definition_of_done'] },
    { id: 'evidence_submission', title: 'Receive evidence', dependencies: ['milestone_activation'], waitForEvent: 'EVIDENCE_SUBMITTED' },
    { id: 'evidence_validation', title: 'Validate evidence', handler: 'evidenceValidation', dependencies: ['evidence_submission'], retry: { maxAttempts: 3, backoffSeconds: 30 } },
    { id: 'risk_evaluation', title: 'Evaluate risk', handler: 'riskEvaluation', dependencies: ['evidence_validation'] },
    { id: 'assurance_evaluation', title: 'Evaluate adaptive assurance', handler: 'assuranceEvaluation', dependencies: ['risk_evaluation'] },
    { id: 'release_eligibility', title: 'Evaluate release eligibility', handler: 'releaseEligibility', dependencies: ['assurance_evaluation'] },
    { id: 'enhanced_approval', title: 'Independent release approval', dependencies: ['release_eligibility'], humanTaskRole: 'RELEASE_REVIEWER', minimumAssurance: 'ENHANCED' },
    { id: 'settlement_observation', title: 'Observe external settlement', dependencies: ['enhanced_approval'], waitForEvent: 'SETTLEMENT_CONFIRMED' },
    { id: 'milestone_closure', title: 'Close milestone', handler: 'milestoneClosure', dependencies: ['settlement_observation'] },
    { id: 'trust_update', title: 'Update progressive trust', handler: 'trustUpdate', dependencies: ['milestone_closure'] },
  ],
};
