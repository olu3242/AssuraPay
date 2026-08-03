import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AcceptanceCriteriaEngine,
  DependencyIntelligenceEngine,
  PaymentTriggerRuleEngine,
  PerformanceBaselineEngine,
  SuccessMetricsEngine,
} from './index';

const c = {
  actorUserId: 'planner',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 26 Acceptance Criteria', () => {
  it('validates tolerance ranges and retest configuration, and becomes immutable once confirmed', () => {
    const s = new InMemoryTrustStore();
    const e = new AcceptanceCriteriaEngine(s);
    expect(() =>
      e.define(c, {
        deliverableId: 'd',
        description: 'Frame plumb within tolerance',
        testMethod: 'MEASUREMENT',
        metric: 'plumb-deviation-mm',
        tolerance: { operator: 'BETWEEN', target: 0, unit: 'mm', upperBound: undefined },
        validatorRole: 'inspector',
        retestAllowed: true,
        maxRetests: 1,
      }),
    ).toThrow('INVALID_TOLERANCE_RANGE');
    expect(() =>
      e.define(c, {
        deliverableId: 'd',
        description: 'Frame plumb within tolerance',
        testMethod: 'MEASUREMENT',
        metric: 'plumb-deviation-mm',
        tolerance: { operator: 'LTE', target: 5, unit: 'mm' },
        validatorRole: 'inspector',
        retestAllowed: false,
        maxRetests: 1,
      }),
    ).toThrow('INVALID_RETEST_CONFIGURATION');
    const criterion = e.define(c, {
      deliverableId: 'd',
      description: 'Frame plumb within tolerance',
      testMethod: 'MEASUREMENT',
      metric: 'plumb-deviation-mm',
      tolerance: { operator: 'LTE', target: 5, unit: 'mm' },
      validatorRole: 'inspector',
      retestAllowed: true,
      maxRetests: 2,
    });
    expect(e.confirm(c, criterion.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(() => e.confirm(c, criterion.id)).toThrow('IMMUTABLE');
  });
});

describe('Engine 27 Success Metrics', () => {
  it('caps confirmed weight allocation per milestone at 100 percent', () => {
    const s = new InMemoryTrustStore();
    const e = new SuccessMetricsEngine(s);
    const first = e.define(c, {
      milestoneId: 'm',
      kind: 'SLA',
      name: 'On-time delivery',
      targetValue: 100,
      unit: 'percent',
      direction: 'HIGHER_IS_BETTER',
      weightPercent: 70,
    });
    const second = e.define(c, {
      milestoneId: 'm',
      kind: 'QUALITY',
      name: 'Defect rate',
      targetValue: 1,
      unit: 'percent',
      direction: 'LOWER_IS_BETTER',
      weightPercent: 40,
    });
    e.confirm(c, first.id);
    expect(() => e.confirm(c, second.id)).toThrow('WEIGHT_ALLOCATION_EXCEEDS_TOTAL');
  });
});

describe('Engine 28 Dependency Intelligence', () => {
  it('tracks blocking dependencies and clears them once resolved', () => {
    const s = new InMemoryTrustStore();
    const e = new DependencyIntelligenceEngine(s);
    const dependency = e.register(c, {
      milestoneId: 'm',
      kind: 'REGULATORY',
      description: 'Site permit approval',
      ownerId: 'compliance',
      dueDate: '2026-08-15',
      criticality: 'BLOCKING',
    });
    expect(e.blockers(c, 'm')).toHaveLength(1);
    e.resolve(c, dependency.id);
    expect(e.blockers(c, 'm')).toHaveLength(0);
    expect(() => e.resolve(c, dependency.id)).toThrow('DEPENDENCY_NOT_OPEN');
  });
});

describe('Engine 29 Payment Trigger', () => {
  it('requires the right references per rule type and blocks eligibility until evidence is satisfied', () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentTriggerRuleEngine(s);
    expect(() =>
      e.define(c, {
        milestoneId: 'm',
        name: 'Frame payment',
        ruleType: 'HYBRID',
        requiredAcceptanceCriterionIds: ['ac1'],
        amountMinor: 425_000_000,
        currency: 'NGN',
      }),
    ).toThrow('DOD_PACKAGE_REFERENCE_REQUIRED');
    const rule = e.define(c, {
      milestoneId: 'm',
      name: 'Frame payment',
      ruleType: 'HYBRID',
      requiredDodPackageId: 'dod1',
      requiredAcceptanceCriterionIds: ['ac1'],
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(() =>
      e.evaluate(c, rule.id, { dodPublished: true, acceptedCriterionIds: ['ac1'], blockingDependencyCount: 0 }),
    ).toThrow('NOT_ACTIVE');
    e.activate(c, rule.id);
    expect(e.evaluate(c, rule.id, { dodPublished: false, acceptedCriterionIds: [], blockingDependencyCount: 1 })).toMatchObject(
      { eligible: false, blockers: ['UNRESOLVED_BLOCKING_DEPENDENCIES', 'DOD_NOT_PUBLISHED', 'ACCEPTANCE_CRITERIA_NOT_MET'] },
    );
    expect(
      e.evaluate(c, rule.id, { dodPublished: true, acceptedCriterionIds: ['ac1'], blockingDependencyCount: 0 }),
    ).toMatchObject({ eligible: true, blockers: [] });
  });
});

describe('Engine 30 Performance Baseline', () => {
  it('allows exactly one baseline per milestone and computes variance against it', () => {
    const s = new InMemoryTrustStore();
    const e = new PerformanceBaselineEngine(s);
    const baseline = e.baseline(c, {
      blueprintId: 'bp',
      milestoneId: 'm',
      plannedStartDate: '2026-08-01',
      plannedDueDate: '2026-09-01',
      plannedBudgetAmountMinor: 100_000_00,
      plannedScopeItemCount: 5,
      plannedQualityScore: 90,
      plannedRiskScore: 20,
    });
    expect(() =>
      e.baseline(c, {
        blueprintId: 'bp',
        milestoneId: 'm',
        plannedStartDate: '2026-08-01',
        plannedDueDate: '2026-09-01',
        plannedBudgetAmountMinor: 100_000_00,
        plannedScopeItemCount: 5,
        plannedQualityScore: 90,
        plannedRiskScore: 20,
      }),
    ).toThrow('BASELINE_ALREADY_SET');
    const variance = e.recordVariance(c, {
      baselineId: baseline.id,
      actualDueDate: '2026-09-08',
      actualCostAmountMinor: 110_000_00,
      actualScopeItemCount: 6,
    });
    expect(variance).toMatchObject({ scheduleVarianceDays: 7, costVarianceMinor: 10_000_00, scopeVarianceCount: 1 });
  });
});
