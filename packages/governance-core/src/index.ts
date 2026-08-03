import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

export type ExecutionState =
  'DRAFT' | 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'CANCELLED';
export type Execution = {
  id: string;
  workspaceId: string;
  contractId: string;
  title: string;
  ownerUserId: string;
  state: ExecutionState;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type ExecutionHistory = {
  id: string;
  workspaceId: string;
  executionId: string;
  fromState?: ExecutionState;
  toState: ExecutionState;
  actorId: string;
  reason: string;
  sequence: number;
  occurredAt: string;
};
export type MilestoneNode = {
  id: string;
  workspaceId: string;
  executionId: string;
  parentMilestoneId?: string;
  title: string;
  ownerUserId: string;
  state: 'PLANNED' | 'READY' | 'ACTIVE' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED';
  durationDays: number;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type MilestoneDependency = {
  id: string;
  workspaceId: string;
  executionId: string;
  predecessorId: string;
  successorId: string;
  dependencyType: 'FINISH_TO_START';
  createdAt: string;
};
export type DodCriterion = {
  key: string;
  description: string;
  mandatory: boolean;
  evidenceRequirementKeys: string[];
  evaluationType: 'AUTOMATED' | 'MANUAL';
  rule?: {
    field: string;
    operator: 'EQ' | 'GTE' | 'LTE';
    value: string | number | boolean;
  };
};
export type DefinitionOfDoneVersion = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  criteria: ReadonlyArray<DodCriterion>;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
  contentHash: string;
};
export type DodEvaluation = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  definitionId: string;
  results: Array<{ criterionKey: string; passed: boolean; reason: string }>;
  mandatoryPassed: boolean;
  manualReviewRequired: boolean;
  evidenceReferences: string[];
  evaluatedBy: string;
  evaluatedAt: string;
};
export type CertificationRequest = {
  id: string;
  workspaceId: string;
  executionId: string;
  milestoneId: string;
  dodEvaluationId: string;
  requestedBy: string;
  status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reviewerIds: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type CertificationDecision = {
  id: string;
  workspaceId: string;
  certificationRequestId: string;
  reviewerId: string;
  decision: 'APPROVE' | 'REJECT';
  rationale: string;
  evidenceReferences: string[];
  decidedAt: string;
};
export type DigitalCertificationRecord = {
  id: string;
  workspaceId: string;
  certificationRequestId: string;
  milestoneId: string;
  certificateNumber: string;
  canonicalHash: string;
  status: 'CERTIFIED' | 'REVOKED';
  issuedBy: string;
  issuedAt: string;
};
export type PaymentTriggerDefinition = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  name: string;
  requiredDodDefinitionId: string;
  certificationRequired: boolean;
  amountMinor: number;
  currency: string;
  escrowProviderKey?: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  version: number;
};
export type PaymentAuthorizationProposal = {
  id: string;
  workspaceId: string;
  triggerId: string;
  milestoneId: string;
  certificationId?: string;
  amountMinor: number;
  currency: string;
  status:
    'PROPOSED' | 'BLOCKED' | 'AUTHORIZED_FOR_PROVIDER_SUBMISSION' | 'REVOKED';
  blockers: string[];
  proposedBy: string;
  proposedAt: string;
  idempotencyKey: string;
};
export interface EscrowReleaseOrchestrator {
  readonly providerKey: string;
  createReleaseIntent(
    proposal: PaymentAuthorizationProposal,
  ): Promise<{ providerReference: string; status: 'INTENT_CREATED' }>;
}

const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scoped(context: RequestContext) {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
}

export class ExecutionEngine {
  constructor(private readonly store: TrustPersistence) {}
  create(
    context: RequestContext,
    input: { contractId: string; title: string; ownerUserId: string },
  ) {
    const workspaceId = scoped(context);
    const stamp = now();
    const execution: Execution = {
      id: randomUUID(),
      workspaceId,
      ...input,
      state: 'DRAFT',
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    this.store.append('governedExecutions', execution);
    this.record(context, execution, undefined, 'DRAFT', 'Execution created');
    return execution;
  }
  transition(
    context: RequestContext,
    id: string,
    toState: ExecutionState,
    reason: string,
  ) {
    const workspaceId = scoped(context);
    const execution = this.store
      .list<Execution>('governedExecutions')
      .find((x) => x.id === id && x.workspaceId === workspaceId);
    if (!execution) throw new Error('EXECUTION_NOT_FOUND');
    const allowed: Record<ExecutionState, ExecutionState[]> = {
      DRAFT: ['PLANNED', 'CANCELLED'],
      PLANNED: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['SUSPENDED', 'COMPLETED', 'CANCELLED'],
      SUSPENDED: ['ACTIVE', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    };
    if (!allowed[execution.state].includes(toState))
      throw new Error('INVALID_EXECUTION_TRANSITION');
    const updated = {
      ...execution,
      state: toState,
      startedAt:
        toState === 'ACTIVE'
          ? (execution.startedAt ?? now())
          : execution.startedAt,
      completedAt: toState === 'COMPLETED' ? now() : execution.completedAt,
      updatedAt: now(),
      version: execution.version + 1,
    };
    this.store.replace('governedExecutions', updated);
    this.record(context, updated, execution.state, toState, reason);
    return updated;
  }
  history(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    return this.store
      .list<ExecutionHistory>('executionHistory')
      .filter((x) => x.workspaceId === workspaceId && x.executionId === id)
      .sort((a, b) => a.sequence - b.sequence);
  }
  project(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const execution = this.store
      .list<Execution>('governedExecutions')
      .find((x) => x.id === id && x.workspaceId === workspaceId);
    if (!execution) throw new Error('EXECUTION_NOT_FOUND');
    const milestones = this.store
      .list<MilestoneNode>('governedMilestones')
      .filter((x) => x.executionId === id && x.workspaceId === workspaceId);
    return {
      execution,
      milestoneCounts: Object.fromEntries(
        ['PLANNED', 'READY', 'ACTIVE', 'BLOCKED', 'COMPLETED', 'CANCELLED'].map(
          (state) => [
            state,
            milestones.filter((x) => x.state === state).length,
          ],
        ),
      ),
      historyCount: this.history(context, id).length,
    };
  }
  private record(
    context: RequestContext,
    execution: Execution,
    fromState: ExecutionState | undefined,
    toState: ExecutionState,
    reason: string,
  ) {
    const history = this.store
      .list<ExecutionHistory>('executionHistory')
      .filter((x) => x.executionId === execution.id);
    const item: ExecutionHistory = {
      id: randomUUID(),
      workspaceId: execution.workspaceId,
      executionId: execution.id,
      fromState,
      toState,
      actorId: context.actorUserId,
      reason,
      sequence: history.length + 1,
      occurredAt: now(),
    };
    this.store.append('executionHistory', item);
    this.store.audit({
      tenantId: context.tenantId,
      workspaceId: execution.workspaceId,
      actorId: context.actorUserId,
      eventType: 'ExecutionStateChanged',
      aggregateType: 'Execution',
      aggregateId: execution.id,
      correlationId: context.correlationId,
      metadata: { fromState, toState, reason },
    });
    this.store.emit({
      tenantId: context.tenantId,
      workspaceId: execution.workspaceId,
      aggregateType: 'Execution',
      aggregateId: execution.id,
      eventType:
        toState === 'DRAFT' ? 'ExecutionCreated' : 'ExecutionStateChanged',
      eventVersion: 1,
      payload: { fromState, toState },
      correlationId: context.correlationId,
    });
  }
}

export class MilestoneEngine {
  constructor(private readonly store: TrustPersistence) {}
  create(
    context: RequestContext,
    input: {
      executionId: string;
      parentMilestoneId?: string;
      title: string;
      ownerUserId: string;
      durationDays: number;
    },
  ) {
    const workspaceId = scoped(context);
    if (!Number.isInteger(input.durationDays) || input.durationDays < 0)
      throw new Error('INVALID_DURATION');
    if (
      input.parentMilestoneId &&
      !this.find(workspaceId, input.parentMilestoneId)
    )
      throw new Error('PARENT_MILESTONE_NOT_FOUND');
    const stamp = now();
    const milestone: MilestoneNode = {
      id: randomUUID(),
      workspaceId,
      ...input,
      state: 'PLANNED',
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    this.store.append('governedMilestones', milestone);
    return milestone;
  }
  addDependency(
    context: RequestContext,
    input: { executionId: string; predecessorId: string; successorId: string },
  ) {
    const workspaceId = scoped(context);
    if (input.predecessorId === input.successorId)
      throw new Error('MILESTONE_CYCLE');
    const nodes = this.store
      .list<MilestoneNode>('governedMilestones')
      .filter(
        (x) =>
          x.workspaceId === workspaceId && x.executionId === input.executionId,
      );
    if (
      !nodes.some((x) => x.id === input.predecessorId) ||
      !nodes.some((x) => x.id === input.successorId)
    )
      throw new Error('MILESTONE_NOT_FOUND');
    const candidate: MilestoneDependency = {
      id: randomUUID(),
      workspaceId,
      ...input,
      dependencyType: 'FINISH_TO_START',
      createdAt: now(),
    };
    const edges = [
      ...this.store
        .list<MilestoneDependency>('milestoneDependencies')
        .filter(
          (x) =>
            x.workspaceId === workspaceId &&
            x.executionId === input.executionId,
        ),
      candidate,
    ];
    if (this.hasPath(edges, input.successorId, input.predecessorId))
      throw new Error('MILESTONE_CYCLE');
    this.store.append('milestoneDependencies', candidate);
    return candidate;
  }
  evaluateReadiness(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const milestone = this.find(workspaceId, id);
    if (!milestone) throw new Error('MILESTONE_NOT_FOUND');
    const predecessors = this.store
      .list<MilestoneDependency>('milestoneDependencies')
      .filter((x) => x.workspaceId === workspaceId && x.successorId === id)
      .map((x) => this.find(workspaceId, x.predecessorId));
    const ready = predecessors.every((x) => x?.state === 'COMPLETED');
    return {
      milestoneId: id,
      ready,
      blockers: predecessors
        .filter((x) => x?.state !== 'COMPLETED')
        .map((x) => x?.id),
    };
  }
  complete(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const milestone = this.find(workspaceId, id);
    if (!milestone) throw new Error('MILESTONE_NOT_FOUND');
    if (!this.evaluateReadiness(context, id).ready)
      throw new Error('MILESTONE_DEPENDENCIES_INCOMPLETE');
    const updated = {
      ...milestone,
      state: 'COMPLETED' as const,
      updatedAt: now(),
      version: milestone.version + 1,
    };
    this.store.replace('governedMilestones', updated);
    return updated;
  }
  criticalPath(context: RequestContext, executionId: string) {
    const workspaceId = scoped(context);
    const nodes = this.store
      .list<MilestoneNode>('governedMilestones')
      .filter(
        (x) => x.workspaceId === workspaceId && x.executionId === executionId,
      );
    const edges = this.store
      .list<MilestoneDependency>('milestoneDependencies')
      .filter(
        (x) => x.workspaceId === workspaceId && x.executionId === executionId,
      );
    const memo = new Map<string, { days: number; path: string[] }>();
    const visit = (id: string): { days: number; path: string[] } => {
      const cached = memo.get(id);
      if (cached) return cached;
      const node = nodes.find((x) => x.id === id);
      if (!node) return { days: 0, path: [] };
      const next = edges
        .filter((x) => x.predecessorId === id)
        .map((x) => visit(x.successorId))
        .sort((a, b) => b.days - a.days)[0] ?? { days: 0, path: [] };
      const value = {
        days: node.durationDays + next.days,
        path: [id, ...next.path],
      };
      memo.set(id, value);
      return value;
    };
    return (
      nodes.map((x) => visit(x.id)).sort((a, b) => b.days - a.days)[0] ?? {
        days: 0,
        path: [],
      }
    );
  }
  private find(workspaceId: string, id: string) {
    return this.store
      .list<MilestoneNode>('governedMilestones')
      .find((x) => x.workspaceId === workspaceId && x.id === id);
  }
  private hasPath(
    edges: MilestoneDependency[],
    from: string,
    to: string,
    seen = new Set<string>(),
  ): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return edges
      .filter((x) => x.predecessorId === from)
      .some((x) => this.hasPath(edges, x.successorId, to, seen));
  }
}

export class DefinitionOfDoneEngine {
  constructor(private readonly store: TrustPersistence) {}
  createVersion(
    context: RequestContext,
    milestoneId: string,
    criteria: DodCriterion[],
  ) {
    const workspaceId = scoped(context);
    if (
      !criteria.length ||
      new Set(criteria.map((x) => x.key)).size !== criteria.length
    )
      throw new Error('INVALID_DOD_CRITERIA');
    const prior = this.store
      .list<DefinitionOfDoneVersion>('dodVersions')
      .filter(
        (x) => x.workspaceId === workspaceId && x.milestoneId === milestoneId,
      );
    const version: DefinitionOfDoneVersion = {
      id: randomUUID(),
      workspaceId,
      milestoneId,
      version: prior.length + 1,
      status: 'DRAFT',
      criteria: Object.freeze(structuredClone(criteria)),
      createdBy: context.actorUserId,
      createdAt: now(),
      contentHash: digest(criteria),
    };
    this.store.append('dodVersions', version);
    return version;
  }
  publish(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const definition = this.store
      .list<DefinitionOfDoneVersion>('dodVersions')
      .find((x) => x.id === id && x.workspaceId === workspaceId);
    if (!definition) throw new Error('DOD_NOT_FOUND');
    if (definition.status !== 'DRAFT')
      throw new Error('PUBLISHED_DOD_IMMUTABLE');
    for (const active of this.store
      .list<DefinitionOfDoneVersion>('dodVersions')
      .filter(
        (x) =>
          x.milestoneId === definition.milestoneId && x.status === 'PUBLISHED',
      ))
      this.store.replace('dodVersions', { ...active, status: 'SUPERSEDED' });
    const published = {
      ...definition,
      status: 'PUBLISHED' as const,
      publishedAt: now(),
    };
    this.store.replace('dodVersions', published);
    return published;
  }
  evaluate(
    context: RequestContext,
    id: string,
    input: {
      facts: Record<string, unknown>;
      evidence: Record<string, string>;
      manualResults?: Record<string, boolean>;
    },
  ) {
    const workspaceId = scoped(context);
    const definition = this.store
      .list<DefinitionOfDoneVersion>('dodVersions')
      .find(
        (x) =>
          x.id === id &&
          x.workspaceId === workspaceId &&
          x.status === 'PUBLISHED',
      );
    if (!definition) throw new Error('PUBLISHED_DOD_NOT_FOUND');
    const results = definition.criteria.map((c) => {
      const missing = c.evidenceRequirementKeys.filter(
        (k) => !input.evidence[k],
      );
      let passed = false;
      let reason = '';
      if (missing.length) reason = `Missing evidence: ${missing.join(',')}`;
      else if (c.evaluationType === 'MANUAL') {
        passed = input.manualResults?.[c.key] === true;
        reason = passed ? 'Manual review passed' : 'Manual review required';
      } else if (c.rule) {
        const actual = input.facts[c.rule.field];
        passed =
          c.rule.operator === 'EQ'
            ? actual === c.rule.value
            : c.rule.operator === 'GTE'
              ? Number(actual) >= Number(c.rule.value)
              : Number(actual) <= Number(c.rule.value);
        reason = passed ? 'Automated rule passed' : 'Automated rule failed';
      }
      return { criterionKey: c.key, passed, reason };
    });
    const evaluation: DodEvaluation = {
      id: randomUUID(),
      workspaceId,
      milestoneId: definition.milestoneId,
      definitionId: id,
      results,
      mandatoryPassed: definition.criteria
        .filter((c) => c.mandatory)
        .every((c) => results.find((r) => r.criterionKey === c.key)?.passed),
      manualReviewRequired: definition.criteria.some(
        (c) =>
          c.evaluationType === 'MANUAL' &&
          !results.find((r) => r.criterionKey === c.key)?.passed,
      ),
      evidenceReferences: Object.values(input.evidence),
      evaluatedBy: context.actorUserId,
      evaluatedAt: now(),
    };
    this.store.append('dodEvaluations', evaluation);
    return evaluation;
  }
}

export class CertificationEngine {
  constructor(private readonly store: TrustPersistence) {}
  request(
    context: RequestContext,
    input: {
      executionId: string;
      milestoneId: string;
      dodEvaluationId: string;
      reviewerIds: string[];
    },
  ) {
    const workspaceId = scoped(context);
    const evaluation = this.store
      .list<DodEvaluation>('dodEvaluations')
      .find(
        (x) =>
          x.id === input.dodEvaluationId &&
          x.workspaceId === workspaceId &&
          x.mandatoryPassed,
      );
    if (!evaluation) throw new Error('CERTIFICATION_DOD_NOT_SATISFIED');
    if (
      !input.reviewerIds.length ||
      input.reviewerIds.includes(context.actorUserId)
    )
      throw new Error('INDEPENDENT_REVIEWER_REQUIRED');
    const stamp = now();
    const request: CertificationRequest = {
      id: randomUUID(),
      workspaceId,
      ...input,
      requestedBy: context.actorUserId,
      status: 'PENDING',
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    this.store.append('certificationRequests', request);
    this.store.emit({
      tenantId: context.tenantId,
      workspaceId,
      aggregateType: 'CertificationRequest',
      aggregateId: request.id,
      eventType: 'CertificationRequested',
      eventVersion: 1,
      payload: { milestoneId: input.milestoneId },
      correlationId: context.correlationId,
    });
    return request;
  }
  decide(
    context: RequestContext,
    id: string,
    decision: 'APPROVE' | 'REJECT',
    rationale: string,
    evidenceReferences: string[],
  ) {
    const workspaceId = scoped(context);
    const request = this.store
      .list<CertificationRequest>('certificationRequests')
      .find((x) => x.id === id && x.workspaceId === workspaceId);
    if (!request) throw new Error('CERTIFICATION_REQUEST_NOT_FOUND');
    if (!request.reviewerIds.includes(context.actorUserId))
      throw new Error('CERTIFICATION_REVIEWER_UNAUTHORIZED');
    if (
      this.store
        .list<CertificationDecision>('certificationDecisions')
        .some(
          (x) =>
            x.certificationRequestId === id &&
            x.reviewerId === context.actorUserId,
        )
    )
      throw new Error('CERTIFICATION_DECISION_IMMUTABLE');
    const record: CertificationDecision = {
      id: randomUUID(),
      workspaceId,
      certificationRequestId: id,
      reviewerId: context.actorUserId,
      decision,
      rationale,
      evidenceReferences: [...evidenceReferences],
      decidedAt: now(),
    };
    this.store.append('certificationDecisions', record);
    const updated = {
      ...request,
      status:
        decision === 'APPROVE' ? ('APPROVED' as const) : ('REJECTED' as const),
      updatedAt: now(),
      version: request.version + 1,
    };
    this.store.replace('certificationRequests', updated);
    this.store.audit({
      tenantId: context.tenantId,
      workspaceId,
      actorId: context.actorUserId,
      eventType: 'CertificationDecisionRecorded',
      aggregateType: 'CertificationRequest',
      aggregateId: id,
      correlationId: context.correlationId,
      metadata: { decision, rationale },
    });
    return record;
  }
  issue(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const request = this.store
      .list<CertificationRequest>('certificationRequests')
      .find(
        (x) =>
          x.id === id &&
          x.workspaceId === workspaceId &&
          x.status === 'APPROVED',
      );
    if (!request) throw new Error('APPROVED_CERTIFICATION_REQUIRED');
    const existing = this.store
      .list<DigitalCertificationRecord>('digitalCertifications')
      .find((x) => x.certificationRequestId === id);
    if (existing) return existing;
    const payload = {
      requestId: id,
      milestoneId: request.milestoneId,
      dodEvaluationId: request.dodEvaluationId,
    };
    const record: DigitalCertificationRecord = {
      id: randomUUID(),
      workspaceId,
      certificationRequestId: id,
      milestoneId: request.milestoneId,
      certificateNumber: `AP-CERT-${new Date().getUTCFullYear()}-${String(this.store.list('digitalCertifications').length + 1).padStart(6, '0')}`,
      canonicalHash: digest(payload),
      status: 'CERTIFIED',
      issuedBy: context.actorUserId,
      issuedAt: now(),
    };
    this.store.append('digitalCertifications', record);
    this.store.emit({
      tenantId: context.tenantId,
      workspaceId,
      aggregateType: 'DigitalCertificationRecord',
      aggregateId: record.id,
      eventType: 'CertificationIssued',
      eventVersion: 1,
      payload: {
        milestoneId: record.milestoneId,
        canonicalHash: record.canonicalHash,
      },
      correlationId: context.correlationId,
    });
    return record;
  }
}

export class PaymentTriggerEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly orchestrators: EscrowReleaseOrchestrator[] = [],
  ) {}
  define(
    context: RequestContext,
    input: Omit<
      PaymentTriggerDefinition,
      'id' | 'workspaceId' | 'status' | 'createdAt' | 'version'
    >,
  ) {
    const workspaceId = scoped(context);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new Error('INVALID_PAYMENT_AMOUNT');
    const trigger: PaymentTriggerDefinition = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'ACTIVE',
      createdAt: now(),
      version: 1,
    };
    this.store.append('paymentTriggerDefinitions', trigger);
    return trigger;
  }
  evaluate(context: RequestContext, id: string) {
    const workspaceId = scoped(context);
    const trigger = this.store
      .list<PaymentTriggerDefinition>('paymentTriggerDefinitions')
      .find(
        (x) =>
          x.id === id && x.workspaceId === workspaceId && x.status === 'ACTIVE',
      );
    if (!trigger) throw new Error('PAYMENT_TRIGGER_NOT_FOUND');
    const evaluation = this.store
      .list<DodEvaluation>('dodEvaluations')
      .find(
        (x) =>
          x.definitionId === trigger.requiredDodDefinitionId &&
          x.milestoneId === trigger.milestoneId &&
          x.mandatoryPassed,
      );
    const certificate = this.store
      .list<DigitalCertificationRecord>('digitalCertifications')
      .find(
        (x) =>
          x.milestoneId === trigger.milestoneId && x.status === 'CERTIFIED',
      );
    const blockers = [
      ...(!evaluation ? ['DOD_NOT_SATISFIED'] : []),
      ...(trigger.certificationRequired && !certificate
        ? ['CERTIFICATION_REQUIRED']
        : []),
    ];
    return {
      trigger,
      eligible: blockers.length === 0,
      blockers,
      certificationId: certificate?.id,
    };
  }
  propose(context: RequestContext, id: string, idempotencyKey: string) {
    const result = this.evaluate(context, id);
    const existing = this.store
      .list<PaymentAuthorizationProposal>('paymentAuthorizationProposals')
      .find(
        (x) =>
          x.workspaceId === result.trigger.workspaceId &&
          x.idempotencyKey === idempotencyKey,
      );
    if (existing) return existing;
    const proposal: PaymentAuthorizationProposal = {
      id: randomUUID(),
      workspaceId: result.trigger.workspaceId,
      triggerId: id,
      milestoneId: result.trigger.milestoneId,
      certificationId: result.certificationId,
      amountMinor: result.trigger.amountMinor,
      currency: result.trigger.currency,
      status: result.eligible ? 'PROPOSED' : 'BLOCKED',
      blockers: result.blockers,
      proposedBy: context.actorUserId,
      proposedAt: now(),
      idempotencyKey,
    };
    this.store.append('paymentAuthorizationProposals', proposal);
    this.store.audit({
      tenantId: context.tenantId,
      workspaceId: proposal.workspaceId,
      actorId: context.actorUserId,
      eventType: 'PaymentAuthorizationProposed',
      aggregateType: 'PaymentAuthorizationProposal',
      aggregateId: proposal.id,
      correlationId: context.correlationId,
      metadata: {
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        status: proposal.status,
      },
    });
    return proposal;
  }
  async createEscrowReleaseIntent(context: RequestContext, proposalId: string) {
    const workspaceId = scoped(context);
    const proposal = this.store
      .list<PaymentAuthorizationProposal>('paymentAuthorizationProposals')
      .find(
        (x) =>
          x.id === proposalId &&
          x.workspaceId === workspaceId &&
          x.status === 'PROPOSED',
      );
    if (!proposal) throw new Error('ELIGIBLE_PROPOSAL_REQUIRED');
    const trigger = this.store
      .list<PaymentTriggerDefinition>('paymentTriggerDefinitions')
      .find((x) => x.id === proposal.triggerId);
    const adapter = this.orchestrators.find(
      (x) => x.providerKey === trigger?.escrowProviderKey,
    );
    if (!adapter) throw new Error('ESCROW_ORCHESTRATOR_NOT_CONFIGURED');
    return adapter.createReleaseIntent(proposal);
  }
}
