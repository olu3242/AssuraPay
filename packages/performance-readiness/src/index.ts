import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ws(context: RequestContext) {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
}
function get<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = store
    .list<T>(collection)
    .find((x) => x.id === id && x.workspaceId === ws(context));
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
function emit(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  store.emit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    aggregateType,
    aggregateId,
    eventType,
    eventVersion: 1,
    payload,
    correlationId: context.correlationId,
  });
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

// Engine 26 — Acceptance Criteria

export type ToleranceRule = {
  operator: 'EQ' | 'GTE' | 'LTE' | 'BETWEEN';
  target: number;
  unit: string;
  upperBound?: number;
};

export type AcceptanceCriterion = {
  id: string;
  workspaceId: string;
  deliverableId: string;
  description: string;
  testMethod: 'INSPECTION' | 'MEASUREMENT' | 'DOCUMENT_REVIEW' | 'FUNCTIONAL_TEST';
  metric: string;
  tolerance: ToleranceRule;
  validatorRole: string;
  retestAllowed: boolean;
  maxRetests: number;
  status: 'DRAFT' | 'CONFIRMED';
  createdAt: string;
};

export class AcceptanceCriteriaEngine {
  constructor(private readonly store: TrustPersistence) {}

  define(
    context: RequestContext,
    input: {
      deliverableId: string;
      description: string;
      testMethod: AcceptanceCriterion['testMethod'];
      metric: string;
      tolerance: ToleranceRule;
      validatorRole: string;
      retestAllowed: boolean;
      maxRetests: number;
    },
  ) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    if (
      input.tolerance.operator === 'BETWEEN' &&
      (input.tolerance.upperBound === undefined || input.tolerance.upperBound <= input.tolerance.target)
    )
      throw new Error('INVALID_TOLERANCE_RANGE');
    if (input.retestAllowed ? input.maxRetests < 1 : input.maxRetests !== 0)
      throw new Error('INVALID_RETEST_CONFIGURATION');
    const criterion: AcceptanceCriterion = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    this.store.append('acceptanceCriteria', criterion);
    return criterion;
  }

  confirm(context: RequestContext, id: string) {
    const criterion = get<AcceptanceCriterion>(this.store, 'acceptanceCriteria', context, id);
    if (criterion.status !== 'DRAFT') throw new Error('ACCEPTANCE_CRITERION_IMMUTABLE');
    const confirmed: AcceptanceCriterion = { ...criterion, status: 'CONFIRMED' };
    this.store.replace('acceptanceCriteria', confirmed);
    emit(this.store, context, 'AcceptanceCriterionConfirmed', 'AcceptanceCriterion', id, {
      deliverableId: criterion.deliverableId,
    });
    return confirmed;
  }
}

// Engine 27 — Success Metrics

export type SuccessMetric = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  kind: 'KPI' | 'SLA' | 'QUALITY' | 'TIMELINESS' | 'OUTCOME' | 'COST';
  name: string;
  targetValue: number;
  unit: string;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  weightPercent: number;
  status: 'DRAFT' | 'CONFIRMED';
  createdAt: string;
};

export class SuccessMetricsEngine {
  constructor(private readonly store: TrustPersistence) {}

  define(
    context: RequestContext,
    input: {
      milestoneId: string;
      kind: SuccessMetric['kind'];
      name: string;
      targetValue: number;
      unit: string;
      direction: SuccessMetric['direction'];
      weightPercent: number;
    },
  ) {
    if (input.weightPercent <= 0 || input.weightPercent > 100) throw new Error('INVALID_WEIGHT');
    const metric: SuccessMetric = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    this.store.append('successMetrics', metric);
    return metric;
  }

  confirm(context: RequestContext, id: string) {
    const metric = get<SuccessMetric>(this.store, 'successMetrics', context, id);
    if (metric.status !== 'DRAFT') throw new Error('SUCCESS_METRIC_IMMUTABLE');
    const workspaceId = ws(context);
    const confirmedWeight = this.store
      .list<SuccessMetric>('successMetrics')
      .filter((x) => x.workspaceId === workspaceId && x.milestoneId === metric.milestoneId && x.status === 'CONFIRMED')
      .reduce((sum, x) => sum + x.weightPercent, 0);
    if (confirmedWeight + metric.weightPercent > 100) throw new Error('WEIGHT_ALLOCATION_EXCEEDS_TOTAL');
    const confirmed: SuccessMetric = { ...metric, status: 'CONFIRMED' };
    this.store.replace('successMetrics', confirmed);
    emit(this.store, context, 'SuccessMetricConfirmed', 'SuccessMetric', id, { milestoneId: metric.milestoneId });
    return confirmed;
  }
}

// Engine 28 — Dependency Intelligence

export type Dependency = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  kind: 'INTERNAL' | 'EXTERNAL' | 'VENDOR' | 'CUSTOMER' | 'REGULATORY' | 'FUNDING';
  description: string;
  ownerId: string;
  dueDate: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING';
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
  resolvedAt?: string;
};

export class DependencyIntelligenceEngine {
  constructor(private readonly store: TrustPersistence) {}

  register(
    context: RequestContext,
    input: {
      milestoneId: string;
      kind: Dependency['kind'];
      description: string;
      ownerId: string;
      dueDate: string;
      criticality: Dependency['criticality'];
    },
  ) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    const dependency: Dependency = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      createdAt: now(),
    };
    this.store.append('dependencies', dependency);
    emit(this.store, context, 'DependencyRegistered', 'Dependency', dependency.id, {
      milestoneId: dependency.milestoneId,
      criticality: dependency.criticality,
    });
    return dependency;
  }

  resolve(context: RequestContext, id: string) {
    const dependency = get<Dependency>(this.store, 'dependencies', context, id);
    if (dependency.status !== 'OPEN') throw new Error('DEPENDENCY_NOT_OPEN');
    const resolved: Dependency = { ...dependency, status: 'RESOLVED', resolvedAt: now() };
    this.store.replace('dependencies', resolved);
    emit(this.store, context, 'DependencyResolved', 'Dependency', id, { milestoneId: dependency.milestoneId });
    return resolved;
  }

  blockers(context: RequestContext, milestoneId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<Dependency>('dependencies')
      .filter(
        (x) =>
          x.workspaceId === workspaceId &&
          x.milestoneId === milestoneId &&
          x.status === 'OPEN' &&
          x.criticality === 'BLOCKING',
      );
  }
}

// Engine 29 — Payment Trigger

export type PaymentTriggerRule = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  name: string;
  ruleType: 'MILESTONE_COMPLETION' | 'DOD_PUBLISHED' | 'ACCEPTANCE_PASSED' | 'HYBRID';
  requiredDodPackageId?: string;
  requiredAcceptanceCriterionIds: string[];
  amountMinor: number;
  currency: string;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  createdAt: string;
};

export class PaymentTriggerRuleEngine {
  constructor(private readonly store: TrustPersistence) {}

  define(
    context: RequestContext,
    input: {
      milestoneId: string;
      name: string;
      ruleType: PaymentTriggerRule['ruleType'];
      requiredDodPackageId?: string;
      requiredAcceptanceCriterionIds: string[];
      amountMinor: number;
      currency: string;
    },
  ) {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('INVALID_AMOUNT');
    if ((input.ruleType === 'DOD_PUBLISHED' || input.ruleType === 'HYBRID') && !input.requiredDodPackageId)
      throw new Error('DOD_PACKAGE_REFERENCE_REQUIRED');
    if (
      (input.ruleType === 'ACCEPTANCE_PASSED' || input.ruleType === 'HYBRID') &&
      !input.requiredAcceptanceCriterionIds.length
    )
      throw new Error('ACCEPTANCE_CRITERIA_REFERENCE_REQUIRED');
    const rule: PaymentTriggerRule = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    this.store.append('paymentTriggerRules', rule);
    return rule;
  }

  activate(context: RequestContext, id: string) {
    const rule = get<PaymentTriggerRule>(this.store, 'paymentTriggerRules', context, id);
    if (rule.status !== 'DRAFT') throw new Error('PAYMENT_TRIGGER_RULE_NOT_DRAFT');
    const activated: PaymentTriggerRule = { ...rule, status: 'ACTIVE' };
    this.store.replace('paymentTriggerRules', activated);
    emit(this.store, context, 'PaymentTriggerRuleActivated', 'PaymentTriggerRule', id, {
      milestoneId: rule.milestoneId,
      amountMinor: rule.amountMinor,
    });
    return activated;
  }

  evaluate(
    context: RequestContext,
    id: string,
    evidence: { dodPublished: boolean; acceptedCriterionIds: string[]; blockingDependencyCount: number },
  ) {
    const rule = get<PaymentTriggerRule>(this.store, 'paymentTriggerRules', context, id);
    if (rule.status !== 'ACTIVE') throw new Error('PAYMENT_TRIGGER_RULE_NOT_ACTIVE');
    const blockers: string[] = [];
    if (evidence.blockingDependencyCount > 0) blockers.push('UNRESOLVED_BLOCKING_DEPENDENCIES');
    if ((rule.ruleType === 'DOD_PUBLISHED' || rule.ruleType === 'HYBRID') && !evidence.dodPublished)
      blockers.push('DOD_NOT_PUBLISHED');
    if (
      (rule.ruleType === 'ACCEPTANCE_PASSED' || rule.ruleType === 'HYBRID') &&
      !rule.requiredAcceptanceCriterionIds.every((x) => evidence.acceptedCriterionIds.includes(x))
    )
      blockers.push('ACCEPTANCE_CRITERIA_NOT_MET');
    return { triggerId: id, eligible: blockers.length === 0, blockers };
  }
}

// Engine 30 — Performance Baseline

export type PerformanceBaseline = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  milestoneId: string;
  plannedStartDate: string;
  plannedDueDate: string;
  plannedBudgetAmountMinor: number;
  plannedScopeItemCount: number;
  plannedQualityScore: number;
  plannedRiskScore: number;
  status: 'BASELINED';
  createdAt: string;
};

export type BaselineVariance = {
  id: string;
  workspaceId: string;
  baselineId: string;
  actualStartDate?: string;
  actualDueDate?: string;
  actualCostAmountMinor?: number;
  actualScopeItemCount?: number;
  actualQualityScore?: number;
  actualRiskScore?: number;
  scheduleVarianceDays: number;
  costVarianceMinor: number;
  scopeVarianceCount: number;
  recordedBy: string;
  recordedAt: string;
};

export class PerformanceBaselineEngine {
  constructor(private readonly store: TrustPersistence) {}

  baseline(
    context: RequestContext,
    input: {
      blueprintId: string;
      milestoneId: string;
      plannedStartDate: string;
      plannedDueDate: string;
      plannedBudgetAmountMinor: number;
      plannedScopeItemCount: number;
      plannedQualityScore: number;
      plannedRiskScore: number;
    },
  ) {
    if (!Number.isInteger(input.plannedBudgetAmountMinor) || input.plannedBudgetAmountMinor <= 0)
      throw new Error('INVALID_BUDGET');
    const workspaceId = ws(context);
    if (
      this.store
        .list<PerformanceBaseline>('performanceBaselines')
        .some((x) => x.workspaceId === workspaceId && x.milestoneId === input.milestoneId)
    )
      throw new Error('BASELINE_ALREADY_SET');
    const baseline: PerformanceBaseline = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'BASELINED',
      createdAt: now(),
    };
    this.store.append('performanceBaselines', baseline);
    emit(this.store, context, 'PerformanceBaselineSet', 'PerformanceBaseline', baseline.id, {
      milestoneId: baseline.milestoneId,
      plannedBudgetAmountMinor: baseline.plannedBudgetAmountMinor,
    });
    return baseline;
  }

  recordVariance(
    context: RequestContext,
    input: {
      baselineId: string;
      actualStartDate?: string;
      actualDueDate?: string;
      actualCostAmountMinor?: number;
      actualScopeItemCount?: number;
      actualQualityScore?: number;
      actualRiskScore?: number;
    },
  ) {
    const baseline = get<PerformanceBaseline>(this.store, 'performanceBaselines', context, input.baselineId);
    const variance: BaselineVariance = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      baselineId: baseline.id,
      scheduleVarianceDays: input.actualDueDate ? daysBetween(baseline.plannedDueDate, input.actualDueDate) : 0,
      costVarianceMinor:
        input.actualCostAmountMinor !== undefined
          ? input.actualCostAmountMinor - baseline.plannedBudgetAmountMinor
          : 0,
      scopeVarianceCount:
        input.actualScopeItemCount !== undefined
          ? input.actualScopeItemCount - baseline.plannedScopeItemCount
          : 0,
      recordedBy: context.actorUserId,
      recordedAt: now(),
    };
    this.store.append('baselineVariances', variance);
    emit(this.store, context, 'BaselineVarianceRecorded', 'PerformanceBaseline', baseline.id, {
      scheduleVarianceDays: variance.scheduleVarianceDays,
      costVarianceMinor: variance.costVarianceMinor,
      contentHash: digest(variance),
    });
    return variance;
  }
}
