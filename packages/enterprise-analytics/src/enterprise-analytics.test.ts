import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AiDecisionSupportEngine,
  FinancialPaymentIntelligenceEngine,
  PortfolioAnalyticsEngine,
  RenewalRelationshipIntelligenceEngine,
  VendorCustomerPerformanceEngine,
} from './index';

const c = {
  actorUserId: 'analyst',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 56 Financial & Payment Intelligence', () => {
  it('requires a governed gateway, validates confidence and starts every forecast unreviewed', async () => {
    const s = new InMemoryTrustStore();
    const noGateway = new FinancialPaymentIntelligenceEngine(s);
    await expect(
      noGateway.forecast(c, { scopeId: 'm', forecastType: 'LEAKAGE', signals: { reconciliationExceptions: 2 } }),
    ).rejects.toThrow('GOVERNED_FORECAST_GATEWAY_REQUIRED');
    const invalidGateway = new FinancialPaymentIntelligenceEngine(s, {
      async forecast() {
        return { modelId: 'm', modelVersion: '1', predictedValue: 10, confidence: 2, rationale: 'bad confidence' };
      },
    });
    await expect(
      invalidGateway.forecast(c, { scopeId: 'm', forecastType: 'LEAKAGE', signals: { reconciliationExceptions: 2 } }),
    ).rejects.toThrow('INVALID_CONFIDENCE');
    const e = new FinancialPaymentIntelligenceEngine(s, {
      async forecast(input) {
        return { modelId: 'deterministic', modelVersion: '1', predictedValue: 3, confidence: 0.7, rationale: `forecast for ${input.forecastType}` };
      },
    });
    const forecast = await e.forecast(c, { scopeId: 'm', forecastType: 'LEAKAGE', signals: { reconciliationExceptions: 2 } });
    expect(forecast.reviewStatus).toBe('NOT_REVIEWED');
    expect(e.review(c, { id: forecast.id, decision: 'ACCEPTED' }).reviewStatus).toBe('ACCEPTED');
    expect(() => e.review(c, { id: forecast.id, decision: 'REJECTED' })).toThrow('FORECAST_ALREADY_REVIEWED');
  });
});

describe('Engine 57 Vendor & Customer Performance', () => {
  it('validates the period range and metric bounds and averages metrics into an overall score', () => {
    const s = new InMemoryTrustStore();
    const e = new VendorCustomerPerformanceEngine(s);
    expect(() =>
      e.score(c, {
        partyId: 'vendor-1',
        partyRole: 'VENDOR',
        periodStart: '2026-08-01',
        periodEnd: '2026-07-01',
        metrics: { onTimeDelivery: 90 },
      }),
    ).toThrow('INVALID_PERIOD_RANGE');
    const scorecard = e.score(c, {
      partyId: 'vendor-1',
      partyRole: 'VENDOR',
      periodStart: '2026-07-01',
      periodEnd: '2026-08-01',
      metrics: { onTimeDelivery: 90, qualityScore: 80 },
    });
    expect(scorecard.overallScore).toBe(85);
    expect(e.history(c, { partyId: 'vendor-1', partyRole: 'VENDOR' })).toHaveLength(1);
    expect(e.latest(c, { partyId: 'vendor-1', partyRole: 'VENDOR' })?.id).toBe(scorecard.id);
  });
});

describe('Engine 58 Portfolio Analytics', () => {
  it('rejects negative counts/amounts and out-of-range concentration, and tracks a trend per scope', () => {
    const s = new InMemoryTrustStore();
    const e = new PortfolioAnalyticsEngine(s);
    expect(() =>
      e.snapshot(c, {
        scopeId: 'portfolio',
        atRiskCount: -1,
        blockedCount: 0,
        unpaidAmountMinor: 0,
        disputedCount: 0,
        retainedAmountMinor: 0,
        concentrationTopPartyPercent: 10,
        currency: 'NGN',
      }),
    ).toThrow('MUST_BE_NON_NEGATIVE');
    expect(() =>
      e.snapshot(c, {
        scopeId: 'portfolio',
        atRiskCount: 1,
        blockedCount: 0,
        unpaidAmountMinor: 0,
        disputedCount: 0,
        retainedAmountMinor: 0,
        concentrationTopPartyPercent: 150,
        currency: 'NGN',
      }),
    ).toThrow('MUST_BE_BETWEEN_0_AND_100');
    expect(() =>
      e.snapshot(c, {
        scopeId: 'portfolio',
        atRiskCount: 1,
        blockedCount: 0,
        unpaidAmountMinor: 100.5,
        disputedCount: 0,
        retainedAmountMinor: 0,
        concentrationTopPartyPercent: 10,
        currency: 'NGN',
      }),
    ).toThrow('UNPAIDAMOUNTMINOR_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    e.snapshot(c, {
      scopeId: 'portfolio',
      atRiskCount: 2,
      blockedCount: 1,
      unpaidAmountMinor: 100_000_00,
      disputedCount: 1,
      retainedAmountMinor: 20_000_00,
      concentrationTopPartyPercent: 35,
      currency: 'NGN',
    });
    const second = e.snapshot(c, {
      scopeId: 'portfolio',
      atRiskCount: 1,
      blockedCount: 0,
      unpaidAmountMinor: 50_000_00,
      disputedCount: 0,
      retainedAmountMinor: 20_000_00,
      concentrationTopPartyPercent: 30,
      currency: 'NGN',
    });
    expect(e.trend(c, 'portfolio')).toHaveLength(2);
    expect(e.latest(c, 'portfolio')?.id).toBe(second.id);
  });
});

describe('Engine 59 Renewal & Relationship Intelligence', () => {
  it('requires a valid readiness score and rationale, and returns the latest assessment per contract', () => {
    const s = new InMemoryTrustStore();
    const e = new RenewalRelationshipIntelligenceEngine(s);
    expect(() =>
      e.assess(c, {
        contractId: 'contract',
        renewalReadinessScore: 150,
        performanceHistorySummary: 'strong',
        recommendedAction: 'RENEW',
        rationale: 'consistent on-time delivery',
      }),
    ).toThrow('MUST_BE_BETWEEN_0_AND_100');
    expect(() =>
      e.assess(c, {
        contractId: 'contract',
        renewalReadinessScore: 80,
        performanceHistorySummary: 'strong',
        recommendedAction: 'RENEW',
        rationale: '',
      }),
    ).toThrow('RATIONALE_REQUIRED');
    const assessment = e.assess(c, {
      contractId: 'contract',
      renewalReadinessScore: 88,
      performanceHistorySummary: 'consistent on-time delivery across 6 milestones',
      recommendedAction: 'RENEW',
      rationale: 'strong performance history and no unresolved disputes',
    });
    expect(e.latest(c, 'contract')?.id).toBe(assessment.id);
  });
});

describe('Engine 60 AI Decision Support & Continuous Improvement', () => {
  it('auto-raises a drift alert on a failed evaluation and never lets a recommendation execute without a human decision', () => {
    const s = new InMemoryTrustStore();
    const e = new AiDecisionSupportEngine(s);
    const model = e.registerModel(c, {
      modelId: 'contract-risk-scorer',
      modelVersion: '2',
      purpose: 'Score contract risk dimensions',
      governedBy: 'ContractRiskEngine',
    });
    const failedEval = e.recordEvaluation(c, { modelRegistrationId: model.id, metric: 'precision', score: 30, threshold: 80 });
    expect(failedEval.passed).toBe(false);
    const openDrifts = e.openDrifts(c, model.id);
    expect(openDrifts).toHaveLength(1);
    expect(openDrifts[0].severity).toBe('HIGH');
    e.acknowledgeDrift(c, openDrifts[0].id);
    expect(() => e.acknowledgeDrift(c, openDrifts[0].id)).toThrow('DRIFT_ALERT_NOT_OPEN');
    e.resolveDrift(c, openDrifts[0].id);
    expect(e.openDrifts(c, model.id)).toHaveLength(0);

    e.submitFeedback(c, {
      modelRegistrationId: model.id,
      outputReference: 'analysis-run-1',
      rating: 'NEGATIVE',
      comment: 'missed an obvious payment-trigger gap',
    });

    const recommendation = e.recommend(c, {
      scopeId: 'contract',
      modelRegistrationId: model.id,
      recommendation: 'Flag contract for manual risk review',
      confidence: 0.55,
    });
    expect(recommendation.status).toBe('PENDING');
    const decided = e.decideRecommendation(c, { id: recommendation.id, decision: 'ACCEPTED' });
    expect(decided.status).toBe('ACCEPTED');
    expect(() => e.decideRecommendation(c, { id: recommendation.id, decision: 'DISMISSED' })).toThrow(
      'RECOMMENDATION_ALREADY_DECIDED',
    );
    e.deprecateModel(c, model.id);
    expect(() => e.deprecateModel(c, model.id)).toThrow('MODEL_NOT_ACTIVE');
  });
});
