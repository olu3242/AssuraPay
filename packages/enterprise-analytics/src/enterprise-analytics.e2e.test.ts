import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AiDecisionSupportEngine,
  FinancialPaymentIntelligenceEngine,
  PortfolioAnalyticsEngine,
  RenewalRelationshipIntelligenceEngine,
  VendorCustomerPerformanceEngine,
} from './index';

describe('e2e Batch 12 vendor performance and portfolio risk into a governed renewal recommendation', () => {
  it('carries a vendor scorecard and a portfolio snapshot through a governed model into an accepted renewal recommendation', async () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'portfolio-analyst',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const performance = new VendorCustomerPerformanceEngine(s);
    const scorecard = await performance.score(c, {
      partyId: 'lagos-steel-supply',
      partyRole: 'VENDOR',
      periodStart: '2026-01-01',
      periodEnd: '2026-07-01',
      metrics: { onTimeDelivery: 92, qualityScore: 88, disputeRate: 95 },
    });
    expect(scorecard.overallScore).toBeGreaterThan(0);

    const portfolio = new PortfolioAnalyticsEngine(s);
    const snapshot = await portfolio.snapshot(c, {
      scopeId: 'trade-finance-portfolio',
      atRiskCount: 1,
      blockedCount: 0,
      unpaidAmountMinor: 0,
      disputedCount: 0,
      retainedAmountMinor: 20_000_00,
      concentrationTopPartyPercent: 22,
      currency: 'NGN',
    });

    const financialIntelligence = new FinancialPaymentIntelligenceEngine(s, {
      async forecast(input) {
        return {
          modelId: 'deterministic-financial-forecast',
          modelVersion: '1',
          predictedValue: 2,
          confidence: 0.62,
          rationale: `${input.forecastType} forecast from ${Object.keys(input.signals).length} signal(s)`,
        };
      },
    });
    const forecast = await financialIntelligence.forecast(c, {
      scopeId: 'trade-finance-portfolio',
      forecastType: 'RELEASE_DELAY',
      signals: { atRiskCount: snapshot.atRiskCount, vendorScore: scorecard.overallScore },
    });
    await financialIntelligence.review(c, { id: forecast.id, decision: 'ACCEPTED' });

    const decisionSupport = new AiDecisionSupportEngine(s);
    const model = await decisionSupport.registerModel(c, {
      modelId: 'deterministic-financial-forecast',
      modelVersion: '1',
      purpose: 'Forecast release delay risk from portfolio and vendor signals',
      governedBy: 'FinancialPaymentIntelligenceEngine',
    });
    await decisionSupport.recordEvaluation(c, { modelRegistrationId: model.id, metric: 'accuracy', score: 85, threshold: 70 });
    expect(await decisionSupport.openDrifts(c, model.id)).toHaveLength(0);

    const recommendation = await decisionSupport.recommend(c, {
      scopeId: 'lagos-steel-supply',
      modelRegistrationId: model.id,
      recommendation: 'Renew with tightened milestone cadence given elevated release-delay risk',
      confidence: forecast.confidence,
    });
    const decided = await decisionSupport.decideRecommendation(c, { id: recommendation.id, decision: 'ACCEPTED' });
    expect(decided.status).toBe('ACCEPTED');

    const renewal = new RenewalRelationshipIntelligenceEngine(s);
    const assessment = await renewal.assess(c, {
      contractId: 'lagos-steel-supply-msa',
      renewalReadinessScore: scorecard.overallScore,
      performanceHistorySummary: 'Consistent on-time delivery with one at-risk milestone flagged by portfolio analytics',
      recommendedAction: 'RENEGOTIATE',
      rationale: 'Governed forecast and accepted recommendation both point to tightened milestone cadence on renewal',
    });
    expect(assessment).toMatchObject({ recommendedAction: 'RENEGOTIATE', contractId: 'lagos-steel-supply-msa' });
  });
});
