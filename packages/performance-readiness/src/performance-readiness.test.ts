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
  it('validates tolerance ranges and retest configuration, and becomes immutable once confirmed', async () => {
    const s = new InMemoryTrustStore();
    const e = new AcceptanceCriteriaEngine(s);
    await expect(e.define(c, {
        deliverableId: 'd',
        description: 'Frame plumb within tolerance',
        testMethod: 'MEASUREMENT',
        metric: 'plumb-deviation-mm',
        tolerance: { operator: 'BETWEEN', target: 0, unit: 'mm', upperBound: undefined },
        validatorRole: 'inspector',
        retestAllowed: true,
        maxRetests: 1,
      })).rejects.toThrow('INVALID_TOLERANCE_RANGE');
    await expect(e.define(c, {
        deliverableId: 'd',
        description: 'Frame plumb within tolerance',
        testMethod: 'MEASUREMENT',
        metric: 'plumb-deviation-mm',
        tolerance: { operator: 'LTE', target: 5, unit: 'mm' },
        validatorRole: 'inspector',
        retestAllowed: false,
        maxRetests: 1,
      })).rejects.toThrow('INVALID_RETEST_CONFIGURATION');
    const criterion = await e.define(c, {
      deliverableId: 'd',
      description: 'Frame plumb within tolerance',
      testMethod: 'MEASUREMENT',
      metric: 'plumb-deviation-mm',
      tolerance: { operator: 'LTE', target: 5, unit: 'mm' },
      validatorRole: 'inspector',
      retestAllowed: true,
      maxRetests: 2,
    });
    expect(await e.confirm(c, criterion.id)).toMatchObject({ status: 'CONFIRMED' });
    await expect(e.confirm(c, criterion.id)).rejects.toThrow('IMMUTABLE');
  });
});

describe('Engine 27 Success Metrics', () => {
  it('caps confirmed weight allocation per milestone at 100 percent', async () => {
    const s = new InMemoryTrustStore();
    const e = new SuccessMetricsEngine(s);
    const first = await e.define(c, {
      milestoneId: 'm',
      kind: 'SLA',
      name: 'On-time delivery',
      targetValue: 100,
      unit: 'percent',
      direction: 'HIGHER_IS_BETTER',
      weightPercent: 70,
    });
    const second = await e.define(c, {
      milestoneId: 'm',
      kind: 'QUALITY',
      name: 'Defect rate',
      targetValue: 1,
      unit: 'percent',
      direction: 'LOWER_IS_BETTER',
      weightPercent: 40,
    });
    await e.confirm(c, first.id);
    await expect(e.confirm(c, second.id)).rejects.toThrow('WEIGHT_ALLOCATION_EXCEEDS_TOTAL');
  });
});

describe('Engine 28 Dependency Intelligence', () => {
  it('tracks blocking dependencies and clears them once resolved', async () => {
    const s = new InMemoryTrustStore();
    const e = new DependencyIntelligenceEngine(s);
    const dependency = await e.register(c, {
      milestoneId: 'm',
      kind: 'REGULATORY',
      description: 'Site permit approval',
      ownerId: 'compliance',
      dueDate: '2026-08-15',
      criticality: 'BLOCKING',
    });
    expect(await e.blockers(c, 'm')).toHaveLength(1);
    await e.resolve(c, dependency.id);
    expect(await e.blockers(c, 'm')).toHaveLength(0);
    await expect(e.resolve(c, dependency.id)).rejects.toThrow('DEPENDENCY_NOT_OPEN');
  });
});

describe('Engine 29 Payment Trigger', () => {
  it('requires the right references per rule type and blocks eligibility until evidence is satisfied', async () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentTriggerRuleEngine(s);
    await expect(e.define(c, {
        milestoneId: 'm',
        name: 'Frame payment',
        ruleType: 'HYBRID',
        requiredAcceptanceCriterionIds: ['ac1'],
        amountMinor: 425_000_000,
        currency: 'NGN',
      })).rejects.toThrow('DOD_PACKAGE_REFERENCE_REQUIRED');
    const rule = await e.define(c, {
      milestoneId: 'm',
      name: 'Frame payment',
      ruleType: 'HYBRID',
      requiredDodPackageId: 'dod1',
      requiredAcceptanceCriterionIds: ['ac1'],
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    await expect(e.evaluate(c, rule.id, { dodPublished: true, acceptedCriterionIds: ['ac1'], blockingDependencyCount: 0 })).rejects.toThrow('NOT_ACTIVE');
    await e.activate(c, rule.id);
    expect(await e.evaluate(c, rule.id, { dodPublished: false, acceptedCriterionIds: [], blockingDependencyCount: 1 })).toMatchObject(
      { eligible: false, blockers: ['UNRESOLVED_BLOCKING_DEPENDENCIES', 'DOD_NOT_PUBLISHED', 'ACCEPTANCE_CRITERIA_NOT_MET'] },
    );
    expect(
      await e.evaluate(c, rule.id, { dodPublished: true, acceptedCriterionIds: ['ac1'], blockingDependencyCount: 0 }),
    ).toMatchObject({ eligible: true, blockers: [] });
  });
});

describe('Engine 30 Performance Baseline', () => {
  it('allows exactly one baseline per milestone and computes variance against it', async () => {
    const s = new InMemoryTrustStore();
    const e = new PerformanceBaselineEngine(s);
    const baseline = await e.baseline(c, {
      blueprintId: 'bp',
      milestoneId: 'm',
      plannedStartDate: '2026-08-01',
      plannedDueDate: '2026-09-01',
      plannedBudgetAmountMinor: 100_000_00,
      plannedScopeItemCount: 5,
      plannedQualityScore: 90,
      plannedRiskScore: 20,
    });
    await expect(e.baseline(c, {
        blueprintId: 'bp',
        milestoneId: 'm',
        plannedStartDate: '2026-08-01',
        plannedDueDate: '2026-09-01',
        plannedBudgetAmountMinor: 100_000_00,
        plannedScopeItemCount: 5,
        plannedQualityScore: 90,
        plannedRiskScore: 20,
      })).rejects.toThrow('BASELINE_ALREADY_SET');
    const variance = await e.recordVariance(c, {
      baselineId: baseline.id,
      actualDueDate: '2026-09-08',
      actualCostAmountMinor: 110_000_00,
      actualScopeItemCount: 6,
    });
    expect(variance).toMatchObject({ scheduleVarianceDays: 7, costVarianceMinor: 10_000_00, scopeVarianceCount: 1 });
  });
});
