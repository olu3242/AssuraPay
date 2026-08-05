import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const ws = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};
const bounded = (value: number, field: string) => {
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`${field}_MUST_BE_BETWEEN_0_AND_100`);
  return value;
};
const nonnegative = (value: number, field: string) => {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${field}_MUST_BE_NON_NEGATIVE`);
  return value;
};
const average = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
async function save<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  context: RequestContext,
  collection: string,
  value: T,
  eventType: string,
) {
  await store.append(collection, value);
  await store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType: collection,
    aggregateId: value.id,
    correlationId: context.correlationId,
    metadata: {},
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    aggregateType: collection,
    aggregateId: value.id,
    eventType,
    eventVersion: 1,
    payload: {},
    correlationId: context.correlationId,
  });
  return value;
}

export type WorkflowNodeState =
  'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'FAILED';
export interface WorkflowNode {
  id: string;
  kind:
    | 'AGREEMENT'
    | 'BLUEPRINT'
    | 'DELIVERABLE'
    | 'MILESTONE'
    | 'DOD'
    | 'EVIDENCE'
    | 'VALIDATION'
    | 'COMPLETION'
    | 'SETTLEMENT';
  state: WorkflowNodeState;
  progressPercent: number;
  updatedAt: string;
}
export interface DependencyEdge {
  from: string;
  to: string;
  type: 'MILESTONE' | 'DELIVERABLE' | 'APPROVAL' | 'PAYMENT';
}

// Engine 71 — observes canonical snapshots; it never transitions nodes.
export class WorkflowIntelligenceEngine {
  constructor(private readonly store: TrustPersistence) {}
  async assess(
    context: RequestContext,
    input: {
      agreementId: string;
      nodes: WorkflowNode[];
      edges: DependencyEdge[];
      stalledAfterHours: number;
      observedAt?: string;
    },
  ) {
    if (!input.nodes.length) throw new Error('WORKFLOW_NODES_REQUIRED');
    nonnegative(input.stalledAfterHours, 'STALLED_AFTER_HOURS');
    const observed = new Date(input.observedAt ?? now()).getTime();
    const stalled = input.nodes
      .filter(
        (node) =>
          node.state === 'IN_PROGRESS' &&
          observed - new Date(node.updatedAt).getTime() >
            input.stalledAfterHours * 3_600_000,
      )
      .map((node) => node.id);
    const progressScore = clamp(
      average(
        input.nodes.map((node) =>
          bounded(node.progressPercent, 'PROGRESS_PERCENT'),
        ),
      ),
    );
    const blocked = input.nodes
      .filter((node) => node.state === 'BLOCKED' || node.state === 'FAILED')
      .map((node) => node.id);
    const healthScore = clamp(
      progressScore - blocked.length * 10 - stalled.length * 5,
    );
    return await save(
      this.store,
      context,
      'workflowAssessments',
      {
        id: randomUUID(),
        workspaceId: ws(context),
        agreementId: input.agreementId,
        status: blocked.length
          ? ('AT_RISK' as const)
          : stalled.length
            ? ('STALLED' as const)
            : progressScore === 100
              ? ('COMPLETE' as const)
              : ('ACTIVE' as const),
        progressScore,
        healthScore,
        stalledNodeIds: stalled,
        blockedNodeIds: blocked,
        indicatorCodes: [
          ...(blocked.length ? ['BLOCKED_WORK'] : []),
          ...(stalled.length ? ['STALLED_EXECUTION'] : []),
        ],
        createdAt: now(),
      },
      'WorkflowAssessed',
    );
  }
}

// Engine 72
export class DependencyIntelligenceEngine {
  analyze(nodes: string[], edges: DependencyEdge[]) {
    const known = new Set(nodes);
    for (const edge of edges)
      if (!known.has(edge.from) || !known.has(edge.to))
        throw new Error('UNKNOWN_DEPENDENCY_NODE');
    const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
    const indegree = new Map(nodes.map((node) => [node, 0]));
    for (const edge of edges) {
      outgoing.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    }
    const queue = nodes.filter((node) => indegree.get(node) === 0).sort();
    const order: string[] = [];
    while (queue.length) {
      const node = queue.shift()!;
      order.push(node);
      for (const next of outgoing.get(node)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
      queue.sort();
    }
    if (order.length !== nodes.length) throw new Error('CIRCULAR_DEPENDENCY');
    const downstream: Record<string, string[]> = {};
    for (const start of nodes) {
      const seen = new Set<string>();
      const pending = [...outgoing.get(start)!];
      while (pending.length) {
        const next = pending.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(...outgoing.get(next)!);
      }
      downstream[start] = Array.from(seen).sort();
    }
    return {
      topologicalOrder: order,
      downstream,
      criticalPath: nodes.length ? order : [],
    };
  }
  blocked(nodes: WorkflowNode[], edges: DependencyEdge[]) {
    const incomplete = new Set(
      nodes.filter((node) => node.state !== 'COMPLETED').map((node) => node.id),
    );
    return Array.from(
      new Set(
        edges
          .filter((edge) => incomplete.has(edge.from))
          .map((edge) => edge.to),
      ),
    ).sort();
  }
}

// Engine 73
export class BottleneckDetectionEngine {
  detect(input: {
    delayedNodeIds: string[];
    approvalQueueHours: Record<string, number>;
    missingEvidenceByMilestone: Record<string, number>;
    validationFailuresByMilestone: Record<string, number>;
  }) {
    const reports: Array<{
      scopeId: string;
      type:
        | 'EXECUTION_DELAY'
        | 'APPROVAL_QUEUE'
        | 'EVIDENCE_SHORTAGE'
        | 'VALIDATION_FAILURE';
      severity: number;
      recommendation: string;
    }> = [
      ...input.delayedNodeIds.map((scopeId) => ({
        scopeId,
        type: 'EXECUTION_DELAY' as const,
        severity: 70,
        recommendation: 'Review critical path and propose replanning.',
      })),
    ];
    for (const [scopeId, hours] of Object.entries(input.approvalQueueHours))
      if (nonnegative(hours, 'APPROVAL_QUEUE_HOURS') >= 24)
        reports.push({
          scopeId,
          type: 'APPROVAL_QUEUE' as const,
          severity: clamp(hours),
          recommendation: 'Recommend approver review or delegated capacity.',
        });
    for (const [scopeId, count] of Object.entries(
      input.missingEvidenceByMilestone,
    ))
      if (nonnegative(count, 'MISSING_EVIDENCE') > 0)
        reports.push({
          scopeId,
          type: 'EVIDENCE_SHORTAGE' as const,
          severity: clamp(count * 15),
          recommendation: 'Request the missing governed evidence package.',
        });
    for (const [scopeId, count] of Object.entries(
      input.validationFailuresByMilestone,
    ))
      if (nonnegative(count, 'VALIDATION_FAILURES') > 0)
        reports.push({
          scopeId,
          type: 'VALIDATION_FAILURE' as const,
          severity: clamp(count * 20),
          recommendation: 'Recommend corrective action and retest.',
        });
    return reports.sort(
      (a, b) => b.severity - a.severity || a.scopeId.localeCompare(b.scopeId),
    );
  }
}

export interface SlaItem {
  id: string;
  kind: 'CONTRACT' | 'MILESTONE' | 'REVIEW' | 'APPROVAL' | 'SETTLEMENT';
  dueAt: string;
  completedAt?: string;
  progressPercent: number;
}
// Engine 74
export class SlaIntelligenceEngine {
  assess(items: SlaItem[], observedAt = now()) {
    const observed = new Date(observedAt).getTime();
    return items.map((item) => {
      bounded(item.progressPercent, 'PROGRESS_PERCENT');
      const due = new Date(item.dueAt).getTime();
      if (!Number.isFinite(due)) throw new Error('INVALID_SLA_DATE');
      const hoursRemaining = Math.round((due - observed) / 3_600_000);
      const completedLate = item.completedAt
        ? new Date(item.completedAt).getTime() > due
        : false;
      const breachProbability = item.completedAt
        ? completedLate
          ? 100
          : 0
        : hoursRemaining <= 0
          ? 100
          : clamp(
              (100 - item.progressPercent) * (72 / Math.max(1, hoursRemaining)),
            );
      return {
        ...item,
        hoursRemaining,
        breached: completedLate || (!item.completedAt && hoursRemaining <= 0),
        breachProbability,
        lateCompletionRisk:
          breachProbability >= 70
            ? ('HIGH' as const)
            : breachProbability >= 35
              ? ('MEDIUM' as const)
              : ('LOW' as const),
      };
    });
  }
}

export type ExceptionType =
  | 'FAILED_MILESTONE'
  | 'REJECTED_EVIDENCE'
  | 'INCOMPLETE_DOD'
  | 'SETTLEMENT_BLOCKER'
  | 'EXECUTION_FAILURE';
// Engine 75 — remediation artifacts are proposals only.
export class ExceptionManagementEngine {
  constructor(private readonly store: TrustPersistence) {}
  async createPlan(
    context: RequestContext,
    input: {
      agreementId: string;
      scopeId: string;
      type: ExceptionType;
      facts: string[];
    },
  ) {
    if (!input.facts.length) throw new Error('EXCEPTION_FACTS_REQUIRED');
    const actions: Record<ExceptionType, string[]> = {
      FAILED_MILESTONE: ['Root-cause review', 'Propose recovery milestone'],
      REJECTED_EVIDENCE: [
        'Review rejection reason',
        'Propose replacement evidence',
      ],
      INCOMPLETE_DOD: ['List unmet criteria', 'Propose remediation owner'],
      SETTLEMENT_BLOCKER: [
        'Confirm blocker source',
        'Route recommendation to Finance',
      ],
      EXECUTION_FAILURE: [
        'Preserve failure evidence',
        'Propose corrective action',
      ],
    };
    return await save(
      this.store,
      context,
      'exceptionRemediationPlans',
      {
        id: randomUUID(),
        workspaceId: ws(context),
        ...input,
        status: 'PROPOSED' as const,
        proposedActions: actions[input.type],
        createdAt: now(),
      },
      'ExceptionRemediationProposed',
    );
  }
}

// Engine 76 — returns a recommendation; no notification/escalation side effect exists.
export class EscalationIntelligenceEngine {
  recommend(input: {
    type: ExceptionType | 'SLA_RISK' | 'APPROVAL_DELAY';
    severity: number;
    rationale: string;
  }) {
    bounded(input.severity, 'SEVERITY');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const recipient =
      input.type === 'SETTLEMENT_BLOCKER'
        ? 'FINANCE'
        : input.type === 'REJECTED_EVIDENCE'
          ? 'DELIVERY_MANAGER'
          : input.type === 'INCOMPLETE_DOD'
            ? 'CONTRACT_MANAGER'
            : input.severity >= 90
              ? 'EXECUTIVE_SPONSOR'
              : input.severity >= 70
                ? 'PROJECT_OWNER'
                : 'DELIVERY_MANAGER';
    return {
      recipient,
      recommendation: `Recommend escalation to ${recipient}.`,
      rationale: input.rationale,
      status: 'PROPOSED' as const,
    };
  }
}

export interface RiskPredictionGateway {
  predict(input: {
    agreementId: string;
    signals: Record<string, number>;
  }): Promise<{
    executionFailure: number;
    approvalDelay: number;
    settlementDelay: number;
    completionProbability: number;
    financialExposureMinor: number;
    confidence: number;
    rationale: string;
    modelId: string;
    modelVersion: string;
  }>;
}
// Engine 77
export class PredictiveRiskIntelligenceEngine {
  constructor(private readonly gateway?: RiskPredictionGateway) {}
  async predict(input: {
    agreementId: string;
    signals: Record<string, number>;
  }) {
    if (!this.gateway) throw new Error('GOVERNED_RISK_GATEWAY_REQUIRED');
    for (const value of Object.values(input.signals))
      nonnegative(value, 'RISK_SIGNAL');
    const result = await this.gateway.predict(input);
    [
      result.executionFailure,
      result.approvalDelay,
      result.settlementDelay,
      result.completionProbability,
      result.confidence * 100,
    ].forEach((value) => bounded(value, 'PREDICTION'));
    nonnegative(result.financialExposureMinor, 'FINANCIAL_EXPOSURE_MINOR');
    if (!result.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    return { ...result, reviewStatus: 'NOT_REVIEWED' as const };
  }
}

// Engine 78
export class ScheduleOptimizationEngine {
  recommend(input: {
    nodes: Array<{ id: string; ownerId: string; durationHours: number }>;
    edges: DependencyEdge[];
    capacityHoursByOwner: Record<string, number>;
  }) {
    const graph = new DependencyIntelligenceEngine().analyze(
      input.nodes.map((node) => node.id),
      input.edges,
    );
    const overloadedOwners = Array.from(
      new Set(
        input.nodes
          .filter((node) => {
            nonnegative(node.durationHours, 'DURATION_HOURS');
            return (
              node.durationHours >
              (input.capacityHoursByOwner[node.ownerId] ?? 0)
            );
          })
          .map((node) => node.ownerId),
      ),
    ).sort();
    return {
      proposedSequence: graph.topologicalOrder,
      overloadedOwners,
      recommendations: [
        ...(overloadedOwners.length ? ['Rebalance overloaded owners.'] : []),
        ...(input.edges.length
          ? ['Preserve dependency-safe topological sequence.']
          : ['Parallelize independent milestones.']),
      ],
      status: 'PROPOSED' as const,
    };
  }
}

// Engine 79
export class ResourceIntelligenceEngine {
  analyze(
    input: Array<{
      ownerId: string;
      assignedHours: number;
      capacityHours: number;
      approvalQueue: number;
      completedApprovals: number;
    }>,
  ) {
    return input
      .map((owner) => {
        nonnegative(owner.assignedHours, 'ASSIGNED_HOURS');
        nonnegative(owner.capacityHours, 'CAPACITY_HOURS');
        nonnegative(owner.approvalQueue, 'APPROVAL_QUEUE');
        nonnegative(owner.completedApprovals, 'COMPLETED_APPROVALS');
        const utilization = owner.capacityHours
          ? Math.round((owner.assignedHours / owner.capacityHours) * 100)
          : owner.assignedHours
            ? 100
            : 0;
        const approvalThroughput = owner.completedApprovals;
        return {
          ...owner,
          utilization,
          approvalThroughput,
          bottleneck:
            utilization > 100 || owner.approvalQueue > owner.completedApprovals,
          recommendation:
            utilization > 100
              ? 'Recommend reassignment to an owner with available capacity.'
              : owner.approvalQueue > owner.completedApprovals
                ? 'Recommend additional approval capacity.'
                : 'No adjustment recommended.',
        };
      })
      .sort(
        (a, b) =>
          b.utilization - a.utilization || a.ownerId.localeCompare(b.ownerId),
      );
  }
}

export interface ExecutionHealthSignals {
  milestoneCompletion: number;
  dodCompliance: number;
  evidenceQuality: number;
  validationStatus: number;
  approvalVelocity: number;
  settlementReadiness: number;
  executionRisk: number;
}
// Engine 80 — primary agreement KPI; risk is inverted and all weights are explicit.
export class ExecutionHealthEngine {
  constructor(private readonly store: TrustPersistence) {}
  async compute(
    context: RequestContext,
    input: { agreementId: string; signals: ExecutionHealthSignals },
  ) {
    for (const [key, value] of Object.entries(input.signals))
      bounded(value, key);
    const weights: Record<keyof ExecutionHealthSignals, number> = {
      milestoneCompletion: 0.2,
      dodCompliance: 0.2,
      evidenceQuality: 0.15,
      validationStatus: 0.15,
      approvalVelocity: 0.1,
      settlementReadiness: 0.1,
      executionRisk: 0.1,
    };
    const score = clamp(
      Object.entries(weights).reduce(
        (sum, [key, weight]) =>
          sum +
          (key === 'executionRisk'
            ? 100 - input.signals[key as keyof ExecutionHealthSignals]
            : input.signals[key as keyof ExecutionHealthSignals]) *
            weight,
        0,
      ),
    );
    const health =
      score >= 80
        ? ('HEALTHY' as const)
        : score >= 60
          ? ('WATCH' as const)
          : score >= 40
            ? ('AT_RISK' as const)
            : ('CRITICAL' as const);
    return await save(
      this.store,
      context,
      'executionHealthScores',
      {
        id: randomUUID(),
        workspaceId: ws(context),
        agreementId: input.agreementId,
        signals: { ...input.signals },
        weights,
        score,
        health,
        createdAt: now(),
      },
      'ExecutionHealthComputed',
    );
  }
}

export const deterministicRiskPredictionGateway: RiskPredictionGateway = {
  async predict(input) {
    const pressure = clamp(average(Object.values(input.signals)));
    return {
      executionFailure: pressure,
      approvalDelay: clamp(pressure * 0.8),
      settlementDelay: clamp(pressure * 0.7),
      completionProbability: 100 - pressure,
      financialExposureMinor: Math.round(
        input.signals.financialExposureMinor ?? 0,
      ),
      confidence: 0.75,
      rationale:
        'Deterministic certification model derived only from caller-supplied canonical signals.',
      modelId: 'deterministic-workflow-risk',
      modelVersion: '1',
    };
  },
};
