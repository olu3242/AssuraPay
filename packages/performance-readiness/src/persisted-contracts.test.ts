import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  acceptanceCriterionSchema,
  baselineVarianceSchema,
  dependencySchema,
  paymentTriggerRuleSchema,
  performanceBaselineSchema,
  successMetricSchema,
  toleranceRuleSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  AcceptanceCriterion,
  BaselineVariance,
  Dependency,
  PaymentTriggerRule,
  PerformanceBaseline,
  SuccessMetric,
  ToleranceRule,
} from './index';

/**
 * Compile-time proof that this package's Batch G domain types and their canonical Zod schemas describe
 * the same shape, plus the rules those schemas enforce.
 *
 * One cross-row invariant is deliberately absent, because a single-record schema cannot express it: the
 * **weight allocation per milestone**, which `SuccessMetricsEngine.confirm` bounds at 100% across every
 * CONFIRMED metric for the milestone. It is a sum over a set with no completion signal — the same shape
 * as Batch E's milestone value allocation — so it is not a database constraint either, and it is
 * recorded as a gap rather than approximated by something weaker that would look like enforcement.
 *
 * Everything else here is a single-record rule, which means the schema and the database can both carry
 * it, and `202608110009` makes each one a constraint as well.
 */

export const toleranceRuleSchemaConforms: SchemaMatchesType<
  z.infer<typeof toleranceRuleSchema>,
  ToleranceRule
> = true;

export const acceptanceCriterionSchemaConforms: SchemaMatchesType<
  z.infer<typeof acceptanceCriterionSchema>,
  AcceptanceCriterion
> = true;

export const successMetricSchemaConforms: SchemaMatchesType<
  z.infer<typeof successMetricSchema>,
  SuccessMetric
> = true;

export const dependencySchemaConforms: SchemaMatchesType<
  z.infer<typeof dependencySchema>,
  Dependency
> = true;

export const paymentTriggerRuleSchemaConforms: SchemaMatchesType<
  z.infer<typeof paymentTriggerRuleSchema>,
  PaymentTriggerRule
> = true;

export const performanceBaselineSchemaConforms: SchemaMatchesType<
  z.infer<typeof performanceBaselineSchema>,
  PerformanceBaseline
> = true;

export const baselineVarianceSchemaConforms: SchemaMatchesType<
  z.infer<typeof baselineVarianceSchema>,
  BaselineVariance
> = true;

const criterion: AcceptanceCriterion = {
  id: 'ac-1',
  workspaceId: 'workspace-1',
  deliverableId: 'dl-1',
  description: 'The report reconciles to the ledger',
  testMethod: 'DOCUMENT_REVIEW',
  metric: 'reconciled',
  tolerance: { operator: 'EQ', target: 1, unit: 'boolean' },
  validatorRole: 'CONTROLLER',
  retestAllowed: false,
  maxRetests: 0,
  status: 'DRAFT',
  createdAt: '2026-08-11T09:00:00.000Z',
};

const rule: PaymentTriggerRule = {
  id: 'ptr-1',
  workspaceId: 'workspace-1',
  milestoneId: 'ms-1',
  name: 'On acceptance',
  ruleType: 'MILESTONE_COMPLETION',
  requiredAcceptanceCriterionIds: [],
  amountMinor: 500_000,
  currency: 'NGN',
  status: 'DRAFT',
  createdAt: '2026-08-11T09:00:00.000Z',
};

describe('Batch G tolerance bands', () => {
  it('accepts a BETWEEN band whose upper bound clears the target', () => {
    expect(
      toleranceRuleSchema.safeParse({ operator: 'BETWEEN', target: 1, unit: 'ms', upperBound: 5 })
        .success,
    ).toBe(true);
  });

  it('refuses a BETWEEN band with no upper bound, and one that sits below the target', () => {
    expect(toleranceRuleSchema.safeParse({ operator: 'BETWEEN', target: 5, unit: 'ms' }).success).toBe(
      false,
    );
    // Admits nothing, so every measurement taken against it would fail — a criterion that can never
    // pass reads as a failing deliverable rather than as a misconfigured band.
    expect(
      toleranceRuleSchema.safeParse({ operator: 'BETWEEN', target: 5, unit: 'ms', upperBound: 4 })
        .success,
    ).toBe(false);
  });
});

describe('Batch G retest configuration', () => {
  it('accepts the two coherent readings', () => {
    expect(acceptanceCriterionSchema.safeParse(criterion).success).toBe(true);
    expect(
      acceptanceCriterionSchema.safeParse({ ...criterion, retestAllowed: true, maxRetests: 3 })
        .success,
    ).toBe(true);
  });

  it('refuses retests forbidden with a positive limit, and allowed with none', () => {
    expect(
      acceptanceCriterionSchema.safeParse({ ...criterion, retestAllowed: false, maxRetests: 3 })
        .success,
    ).toBe(false);
    expect(
      acceptanceCriterionSchema.safeParse({ ...criterion, retestAllowed: true, maxRetests: 0 })
        .success,
    ).toBe(false);
  });
});

describe('Batch G trigger rules carry what their type promises', () => {
  it('refuses a definition-of-done rule that names no package', () => {
    expect(paymentTriggerRuleSchema.safeParse({ ...rule, ruleType: 'DOD_PUBLISHED' }).success).toBe(
      false,
    );
    expect(
      paymentTriggerRuleSchema.safeParse({
        ...rule,
        ruleType: 'DOD_PUBLISHED',
        requiredDodPackageId: 'dod-1',
      }).success,
    ).toBe(true);
  });

  it('refuses an acceptance rule that names no criterion', () => {
    expect(paymentTriggerRuleSchema.safeParse({ ...rule, ruleType: 'ACCEPTANCE_PASSED' }).success).toBe(
      false,
    );
  });

  it('requires a HYBRID rule to carry both', () => {
    // The rule `paymentEligibility` cites as its authority. A HYBRID rule missing either half would
    // evaluate vacuously — it would look like a condition and pass without checking anything.
    expect(
      paymentTriggerRuleSchema.safeParse({ ...rule, ruleType: 'HYBRID', requiredDodPackageId: 'dod-1' })
        .success,
    ).toBe(false);
    expect(
      paymentTriggerRuleSchema.safeParse({
        ...rule,
        ruleType: 'HYBRID',
        requiredDodPackageId: 'dod-1',
        requiredAcceptanceCriterionIds: ['ac-1'],
      }).success,
    ).toBe(true);
  });

  it('refuses a rule that would release nothing', () => {
    expect(paymentTriggerRuleSchema.safeParse({ ...rule, amountMinor: 0 }).success).toBe(false);
  });
});

describe('Batch G dependency and baseline coherence', () => {
  const dependency: Dependency = {
    id: 'dep-1',
    workspaceId: 'workspace-1',
    milestoneId: 'ms-1',
    kind: 'VENDOR',
    description: 'Supplier confirms delivery window',
    ownerId: 'user-1',
    dueDate: '2026-09-01',
    criticality: 'BLOCKING',
    status: 'OPEN',
    createdAt: '2026-08-11T09:00:00.000Z',
  };

  it('pairs resolution with the time it happened', () => {
    expect(dependencySchema.safeParse(dependency).success).toBe(true);
    expect(dependencySchema.safeParse({ ...dependency, status: 'RESOLVED' }).success).toBe(false);
    expect(
      dependencySchema.safeParse({
        ...dependency,
        status: 'RESOLVED',
        resolvedAt: '2026-08-12T09:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      dependencySchema.safeParse({ ...dependency, resolvedAt: '2026-08-12T09:00:00.000Z' }).success,
    ).toBe(false);
  });

  it('refuses a baseline that finishes before it starts', () => {
    const baseline: PerformanceBaseline = {
      id: 'pb-1',
      workspaceId: 'workspace-1',
      blueprintId: 'bp-1',
      milestoneId: 'ms-1',
      plannedStartDate: '2026-09-01',
      plannedDueDate: '2026-09-30',
      plannedBudgetAmountMinor: 5_000_000,
      plannedScopeItemCount: 4,
      plannedQualityScore: 90,
      plannedRiskScore: 20,
      status: 'BASELINED',
      createdAt: '2026-08-11T09:00:00.000Z',
    };
    expect(performanceBaselineSchema.safeParse(baseline).success).toBe(true);
    // `recordVariance` measures the schedule variance in days from the planned due date, so an inverted
    // pair produces a variance that reads as early delivery against a plan that was never coherent.
    expect(
      performanceBaselineSchema.safeParse({ ...baseline, plannedDueDate: '2026-08-01' }).success,
    ).toBe(false);
  });

  it('keeps variance directions signed and unobserved actuals absent', () => {
    const variance: BaselineVariance = {
      id: 'bv-1',
      workspaceId: 'workspace-1',
      baselineId: 'pb-1',
      scheduleVarianceDays: -3,
      costVarianceMinor: -250_000,
      scopeVarianceCount: 1,
      recordedBy: 'user-1',
      recordedAt: '2026-08-11T09:00:00.000Z',
    };
    // Ahead of schedule and under budget are as real as the opposite, and neither is representable if
    // the fields are unsigned.
    expect(baselineVarianceSchema.safeParse(variance).success).toBe(true);
    // An actual cost that has been observed may be zero but never negative — a negative outlay is not a
    // cost, it is a different event.
    expect(baselineVarianceSchema.safeParse({ ...variance, actualCostAmountMinor: 0 }).success).toBe(
      true,
    );
    expect(baselineVarianceSchema.safeParse({ ...variance, actualCostAmountMinor: -1 }).success).toBe(
      false,
    );
  });
});

describe('Batch G success metric weights', () => {
  const metric: SuccessMetric = {
    id: 'sm-1',
    workspaceId: 'workspace-1',
    milestoneId: 'ms-1',
    kind: 'QUALITY',
    name: 'Defect density',
    targetValue: 2,
    unit: 'per-kloc',
    direction: 'LOWER_IS_BETTER',
    weightPercent: 40,
    status: 'DRAFT',
    createdAt: '2026-08-11T09:00:00.000Z',
  };

  it('refuses a weightless metric and one over the whole allocation', () => {
    expect(successMetricSchema.safeParse(metric).success).toBe(true);
    // A metric carrying no weight cannot affect the outcome it claims to measure.
    expect(successMetricSchema.safeParse({ ...metric, weightPercent: 0 }).success).toBe(false);
    expect(successMetricSchema.safeParse({ ...metric, weightPercent: 101 }).success).toBe(false);
  });
});
