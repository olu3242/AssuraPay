import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AcceptanceCriteriaEngine,
  DependencyIntelligenceEngine,
  PaymentTriggerRuleEngine,
  PerformanceBaselineEngine,
  SuccessMetricsEngine,
} from './index';

describe('e2e Batch 6 milestone readiness to gated payment eligibility', () => {
  it('carries acceptance criteria, success metrics, dependency clearance and a baseline into an eligible payment trigger', async () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'planner',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const acceptance = new AcceptanceCriteriaEngine(s);
    const criterion = await acceptance.define(c, {
      deliverableId: 'frame-deliverable',
      description: 'Frame plumb and level within tolerance',
      testMethod: 'MEASUREMENT',
      metric: 'plumb-deviation-mm',
      tolerance: { operator: 'LTE', target: 5, unit: 'mm' },
      validatorRole: 'inspector',
      retestAllowed: true,
      maxRetests: 1,
    });
    await acceptance.confirm(c, criterion.id);

    const metrics = new SuccessMetricsEngine(s);
    const onTime = await metrics.define(c, {
      milestoneId: 'erection-milestone',
      kind: 'TIMELINESS',
      name: 'On-time erection',
      targetValue: 100,
      unit: 'percent',
      direction: 'HIGHER_IS_BETTER',
      weightPercent: 100,
    });
    await metrics.confirm(c, onTime.id);

    const dependencies = new DependencyIntelligenceEngine(s);
    const permit = await dependencies.register(c, {
      milestoneId: 'erection-milestone',
      kind: 'REGULATORY',
      description: 'Site permit approval',
      ownerId: 'compliance',
      dueDate: '2026-08-01',
      criticality: 'BLOCKING',
    });
    expect(await dependencies.blockers(c, 'erection-milestone')).toHaveLength(1);
    await dependencies.resolve(c, permit.id);
    expect(await dependencies.blockers(c, 'erection-milestone')).toHaveLength(0);

    const baselines = new PerformanceBaselineEngine(s);
    const baseline = await baselines.baseline(c, {
      blueprintId: 'blueprint',
      milestoneId: 'erection-milestone',
      plannedStartDate: '2026-08-01',
      plannedDueDate: '2026-09-01',
      plannedBudgetAmountMinor: 4_250_000_00,
      plannedScopeItemCount: 1,
      plannedQualityScore: 95,
      plannedRiskScore: 15,
    });
    const variance = await baselines.recordVariance(c, {
      baselineId: baseline.id,
      actualDueDate: '2026-09-03',
      actualCostAmountMinor: 4_250_000_00,
    });
    expect(variance.scheduleVarianceDays).toBe(2);

    const triggers = new PaymentTriggerRuleEngine(s);
    const rule = await triggers.define(c, {
      milestoneId: 'erection-milestone',
      name: 'Frame erection payment',
      ruleType: 'ACCEPTANCE_PASSED',
      requiredAcceptanceCriterionIds: [criterion.id],
      amountMinor: 4_250_000_00,
      currency: 'NGN',
    });
    await triggers.activate(c, rule.id);

    const blockedEvaluation = await triggers.evaluate(c, rule.id, {
      dodPublished: false,
      acceptedCriterionIds: [],
      blockingDependencyCount: (await dependencies.blockers(c, 'erection-milestone')).length,
    });
    expect(blockedEvaluation).toMatchObject({ eligible: false, blockers: ['ACCEPTANCE_CRITERIA_NOT_MET'] });

    const eligible = await triggers.evaluate(c, rule.id, {
      dodPublished: false,
      acceptedCriterionIds: [criterion.id],
      blockingDependencyCount: (await dependencies.blockers(c, 'erection-milestone')).length,
    });
    expect(eligible).toMatchObject({ eligible: true, blockers: [] });
  });
});
