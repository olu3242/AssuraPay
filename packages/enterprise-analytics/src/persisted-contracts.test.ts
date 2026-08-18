import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  driftAlertSchema,
  evaluationRecordSchema,
  financialForecastSchema,
  modelFeedbackSchema,
  modelRegistrationSchema,
  performanceScorecardSchema,
  portfolioSnapshotSchema,
  recommendationSchema,
  renewalAssessmentSchema,
  scorecardOverallScore,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  DriftAlert,
  EvaluationRecord,
  FinancialForecast,
  ModelFeedback,
  ModelRegistration,
  PerformanceScorecard,
  PortfolioSnapshot,
  Recommendation,
  RenewalAssessment,
} from './index';

/**
 * Compile-time proof that this package's Batch L domain types and their canonical Zod schemas describe the
 * same shape, plus the rules those schemas enforce.
 *
 * Unlike Batch K, nothing is deferred to the application here. `evaluation_records.passed` is derived from
 * `score` and `threshold`, and both live in the same row, so it is a real database CHECK as well as a schema
 * refinement — where Batch K's `kpi_values.on_track` had to stay an application invariant because its target
 * lived on the parent. The same is true of `performance_scorecards.overall_score`, whose inputs are the
 * `metrics` object in the row.
 */

export const financialForecastConforms: SchemaMatchesType<
  z.infer<typeof financialForecastSchema>,
  FinancialForecast
> = true;

export const performanceScorecardConforms: SchemaMatchesType<
  z.infer<typeof performanceScorecardSchema>,
  PerformanceScorecard
> = true;

export const portfolioSnapshotConforms: SchemaMatchesType<
  z.infer<typeof portfolioSnapshotSchema>,
  PortfolioSnapshot
> = true;

export const renewalAssessmentConforms: SchemaMatchesType<
  z.infer<typeof renewalAssessmentSchema>,
  RenewalAssessment
> = true;

export const modelRegistrationConforms: SchemaMatchesType<
  z.infer<typeof modelRegistrationSchema>,
  ModelRegistration
> = true;

export const evaluationRecordConforms: SchemaMatchesType<
  z.infer<typeof evaluationRecordSchema>,
  EvaluationRecord
> = true;

export const driftAlertConforms: SchemaMatchesType<z.infer<typeof driftAlertSchema>, DriftAlert> = true;

export const modelFeedbackConforms: SchemaMatchesType<
  z.infer<typeof modelFeedbackSchema>,
  ModelFeedback
> = true;

export const recommendationConforms: SchemaMatchesType<
  z.infer<typeof recommendationSchema>,
  Recommendation
> = true;

const stamp = '2026-08-18T09:00:00.000Z';
const later = '2026-08-18T11:00:00.000Z';

const forecast = (o: Record<string, unknown> = {}) => ({
  id: 'ff-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  forecastType: 'PAYMENT_FAILURE' as const,
  modelId: 'deterministic-financial-forecast',
  modelVersion: '1',
  predictedValue: 40,
  confidence: 0.6,
  rationale: 'Deterministic baseline forecast for PAYMENT_FAILURE derived from 2 signal(s).',
  reviewStatus: 'NOT_REVIEWED' as const,
  generatedAt: stamp,
  ...o,
});

const scorecard = (o: Record<string, unknown> = {}) => ({
  id: 'ps-1',
  workspaceId: 'ws-1',
  partyId: 'party-1',
  partyRole: 'VENDOR' as const,
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  metrics: { delivery: 80, quality: 70 },
  overallScore: 75,
  computedAt: stamp,
  ...o,
});

const snapshot = (o: Record<string, unknown> = {}) => ({
  id: 'pf-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  atRiskCount: 2,
  blockedCount: 1,
  unpaidAmountMinor: 5_000_000,
  disputedCount: 0,
  retainedAmountMinor: 250_000,
  concentrationTopPartyPercent: 35,
  currency: 'NGN',
  computedAt: stamp,
  ...o,
});

const registration = (o: Record<string, unknown> = {}) => ({
  id: 'mr-1',
  workspaceId: 'ws-1',
  modelId: 'deterministic-financial-forecast',
  modelVersion: '1',
  purpose: 'Forecast payment failure risk on release requests',
  governedBy: 'model-governance-committee',
  status: 'ACTIVE' as const,
  registeredAt: stamp,
  ...o,
});

const evaluation = (o: Record<string, unknown> = {}) => ({
  id: 'er-1',
  workspaceId: 'ws-1',
  modelRegistrationId: 'mr-1',
  metric: 'precision',
  score: 0.82,
  threshold: 0.75,
  passed: true,
  evaluatedAt: stamp,
  ...o,
});

const alert = (o: Record<string, unknown> = {}) => ({
  id: 'da-1',
  workspaceId: 'ws-1',
  modelRegistrationId: 'mr-1',
  description: 'Evaluation for metric "precision" scored 0.4, below threshold 0.75',
  severity: 'HIGH' as const,
  status: 'OPEN' as const,
  raisedAt: stamp,
  ...o,
});

const recommendation = (o: Record<string, unknown> = {}) => ({
  id: 'rc-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  modelRegistrationId: 'mr-1',
  recommendation: 'Hold the release pending reconciliation of the funding confirmation',
  confidence: 0.7,
  status: 'PENDING' as const,
  createdAt: stamp,
  ...o,
});

describe('Batch L persisted contracts', () => {
  it('accepts what the engines write', () => {
    expect(financialForecastSchema.safeParse(forecast()).success).toBe(true);
    expect(performanceScorecardSchema.safeParse(scorecard()).success).toBe(true);
    expect(portfolioSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(modelRegistrationSchema.safeParse(registration()).success).toBe(true);
    expect(evaluationRecordSchema.safeParse(evaluation()).success).toBe(true);
    expect(driftAlertSchema.safeParse(alert()).success).toBe(true);
    expect(recommendationSchema.safeParse(recommendation()).success).toBe(true);
    expect(
      renewalAssessmentSchema.safeParse({
        id: 'ra-1',
        workspaceId: 'ws-1',
        contractId: 'c-1',
        renewalReadinessScore: 72,
        performanceHistorySummary: 'Two milestones certified late, no disputes.',
        recommendedAction: 'RENEGOTIATE',
        rationale: 'Delivery slipped twice; commercial terms should reflect the observed cadence.',
        assessedBy: 'user-1',
        assessedAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      modelFeedbackSchema.safeParse({
        id: 'mf-1',
        workspaceId: 'ws-1',
        modelRegistrationId: 'mr-1',
        outputReference: 'ff-1',
        rating: 'NEGATIVE',
        comment: 'Predicted a payment failure that did not occur; funding cleared on time.',
        submittedBy: 'user-1',
        submittedAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses an evaluation claiming a pass below its own threshold', () => {
    // The one that matters most in this batch. `recordEvaluation` raises a drift alert on a failure, so a
    // falsified pass does not merely misreport — it suppresses the alert that would have prompted anyone to
    // look at the model.
    expect(evaluationRecordSchema.safeParse(evaluation({ score: 0.4, passed: true })).success).toBe(false);
    // And the other direction: a failure recorded against a score that cleared the bar.
    expect(evaluationRecordSchema.safeParse(evaluation({ passed: false })).success).toBe(false);
    // The boundary is inclusive, matching `score >= threshold`.
    expect(evaluationRecordSchema.safeParse(evaluation({ score: 0.75, passed: true })).success).toBe(true);
  });

  it('refuses a scorecard whose headline disagrees with its metrics', () => {
    expect(performanceScorecardSchema.safeParse(scorecard({ overallScore: 95 })).success).toBe(false);
    expect(performanceScorecardSchema.safeParse(scorecard({ metrics: {} })).success).toBe(false);
    expect(performanceScorecardSchema.safeParse(scorecard({ metrics: { delivery: 140 } })).success).toBe(
      false,
    );
  });

  it('refuses a scoring period that ends before it starts', () => {
    expect(
      performanceScorecardSchema.safeParse(
        scorecard({ periodStart: '2026-07-31', periodEnd: '2026-07-01' }),
      ).success,
    ).toBe(false);
    // Equal dates are a zero-length period, which `score()` also refuses.
    expect(
      performanceScorecardSchema.safeParse(
        scorecard({ periodStart: '2026-07-01', periodEnd: '2026-07-01' }),
      ).success,
    ).toBe(false);
  });

  it('agrees with the engine on the overall score', () => {
    expect(scorecardOverallScore({ delivery: 80, quality: 70 })).toBe(75);
    // `Math.round` on a .5 mean, which is where a reimplementation would most easily diverge.
    expect(scorecardOverallScore({ a: 80, b: 71 })).toBe(76);
    expect(scorecardOverallScore({})).toBe(0);
  });

  it('keeps a drift alert’s status and resolution time in step', () => {
    expect(driftAlertSchema.safeParse(alert({ status: 'RESOLVED' })).success).toBe(false);
    expect(driftAlertSchema.safeParse(alert({ resolvedAt: later })).success).toBe(false);
    expect(driftAlertSchema.safeParse(alert({ status: 'RESOLVED', resolvedAt: later })).success).toBe(true);
    // ACKNOWLEDGED is not resolved, so it carries no resolution time either.
    expect(driftAlertSchema.safeParse(alert({ status: 'ACKNOWLEDGED' })).success).toBe(true);
    expect(
      driftAlertSchema.safeParse(alert({ status: 'ACKNOWLEDGED', resolvedAt: later })).success,
    ).toBe(false);
    // And it cannot be resolved before it was raised.
    expect(
      driftAlertSchema.safeParse(alert({ status: 'RESOLVED', raisedAt: later, resolvedAt: stamp })).success,
    ).toBe(false);
  });

  it('keeps a recommendation’s status and decision time in step', () => {
    expect(recommendationSchema.safeParse(recommendation({ status: 'ACCEPTED' })).success).toBe(false);
    expect(recommendationSchema.safeParse(recommendation({ decidedAt: later })).success).toBe(false);
    expect(
      recommendationSchema.safeParse(recommendation({ status: 'DISMISSED', decidedAt: later })).success,
    ).toBe(true);
    expect(
      recommendationSchema.safeParse(
        recommendation({ status: 'ACCEPTED', createdAt: later, decidedAt: stamp }),
      ).success,
    ).toBe(false);
  });

  it('refuses an unattributed forecast or recommendation', () => {
    // For an AI-derived claim, being unable to say what produced it is the whole of its evidential value.
    expect(financialForecastSchema.safeParse(forecast({ modelId: '' })).success).toBe(false);
    expect(financialForecastSchema.safeParse(forecast({ rationale: '  ' })).success).toBe(false);
    expect(financialForecastSchema.safeParse(forecast({ confidence: 1.2 })).success).toBe(false);
    expect(recommendationSchema.safeParse(recommendation({ recommendation: '' })).success).toBe(false);
    expect(recommendationSchema.safeParse(recommendation({ confidence: -0.1 })).success).toBe(false);
  });

  it('holds portfolio money to integer minor units', () => {
    // CLAUDE.md's fourth constraint. A fractional or negative payable is not a smaller amount, it is an
    // amount no settlement instruction can carry.
    expect(portfolioSnapshotSchema.safeParse(snapshot({ unpaidAmountMinor: 5_000.5 })).success).toBe(false);
    expect(portfolioSnapshotSchema.safeParse(snapshot({ retainedAmountMinor: -1 })).success).toBe(false);
    expect(portfolioSnapshotSchema.safeParse(snapshot({ atRiskCount: -1 })).success).toBe(false);
    expect(portfolioSnapshotSchema.safeParse(snapshot({ concentrationTopPartyPercent: 101 })).success).toBe(
      false,
    );
    expect(portfolioSnapshotSchema.safeParse(snapshot({ currency: 'ZZZ' })).success).toBe(false);
  });

  it('refuses a model registered without a purpose', () => {
    expect(modelRegistrationSchema.safeParse(registration({ purpose: '   ' })).success).toBe(false);
    expect(modelRegistrationSchema.safeParse(registration({ governedBy: '' })).success).toBe(false);
  });

  it('refuses an unknown field on every aggregate', () => {
    for (const [schema, value] of [
      [financialForecastSchema, forecast()],
      [performanceScorecardSchema, scorecard()],
      [portfolioSnapshotSchema, snapshot()],
      [modelRegistrationSchema, registration()],
      [evaluationRecordSchema, evaluation()],
      [driftAlertSchema, alert()],
      [recommendationSchema, recommendation()],
    ] as const) {
      expect(schema.safeParse({ ...value, surprise: true }).success).toBe(false);
    }
  });
});
