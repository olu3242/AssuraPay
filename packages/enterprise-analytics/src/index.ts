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
function requireScoreRange(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field}_MUST_BE_BETWEEN_0_AND_100`);
}
function averageOf(values: number[]) {
  return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : 0;
}
function requireNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field}_MUST_BE_NON_NEGATIVE`);
}

// Engine 56 — Financial & Payment Intelligence
//
// Same governed-forecast shape as Engine 55 in `packages/enterprise-intelligence`
// (itself matching Engine 16 in `packages/agreement-intelligence`): forecasts are
// advisory only, produced exclusively through a caller-supplied gateway, and
// always start unreviewed.

export interface FinancialForecastGateway {
  forecast(input: {
    scopeId: string;
    forecastType: FinancialForecast['forecastType'];
    signals: Record<string, number>;
  }): Promise<{ modelId: string; modelVersion: string; predictedValue: number; confidence: number; rationale: string }>;
}

export type FinancialForecast = {
  id: string;
  workspaceId: string;
  scopeId: string;
  forecastType: 'FUNDING_DELAY' | 'RELEASE_DELAY' | 'PAYMENT_FAILURE' | 'LEAKAGE' | 'RECONCILIATION_EXCEPTION';
  modelId: string;
  modelVersion: string;
  predictedValue: number;
  confidence: number;
  rationale: string;
  reviewStatus: 'NOT_REVIEWED' | 'ACCEPTED' | 'REJECTED';
  generatedAt: string;
};

export class FinancialPaymentIntelligenceEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly gateway?: FinancialForecastGateway,
  ) {}

  async forecast(
    context: RequestContext,
    input: { scopeId: string; forecastType: FinancialForecast['forecastType']; signals: Record<string, number> },
  ) {
    if (!this.gateway) throw new Error('GOVERNED_FORECAST_GATEWAY_REQUIRED');
    const result = await this.gateway.forecast(input);
    if (result.confidence < 0 || result.confidence > 1) throw new Error('INVALID_CONFIDENCE');
    const forecast: FinancialForecast = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      ...result,
      reviewStatus: 'NOT_REVIEWED',
      generatedAt: now(),
    };
    this.store.append('financialForecasts', forecast);
    emit(this.store, context, 'FinancialForecastGenerated', 'FinancialForecast', forecast.id, {
      scopeId: forecast.scopeId,
      forecastType: forecast.forecastType,
      confidence: forecast.confidence,
    });
    return forecast;
  }

  review(context: RequestContext, input: { id: string; decision: 'ACCEPTED' | 'REJECTED' }) {
    const forecast = get<FinancialForecast>(this.store, 'financialForecasts', context, input.id);
    if (forecast.reviewStatus !== 'NOT_REVIEWED') throw new Error('FORECAST_ALREADY_REVIEWED');
    const reviewed: FinancialForecast = { ...forecast, reviewStatus: input.decision };
    this.store.replace('financialForecasts', reviewed);
    emit(this.store, context, 'FinancialForecastReviewed', 'FinancialForecast', forecast.id, {
      decision: input.decision,
    });
    return reviewed;
  }

  latest(context: RequestContext, input: { scopeId: string; forecastType: FinancialForecast['forecastType'] }) {
    const workspaceId = ws(context);
    const forecasts = this.store
      .list<FinancialForecast>('financialForecasts')
      .filter(
        (x) => x.workspaceId === workspaceId && x.scopeId === input.scopeId && x.forecastType === input.forecastType,
      );
    return forecasts[forecasts.length - 1];
  }
}

// Engine 57 — Vendor & Customer Performance

export type PerformanceScorecard = {
  id: string;
  workspaceId: string;
  partyId: string;
  partyRole: 'VENDOR' | 'CUSTOMER';
  periodStart: string;
  periodEnd: string;
  metrics: Record<string, number>;
  overallScore: number;
  computedAt: string;
};

export class VendorCustomerPerformanceEngine {
  constructor(private readonly store: TrustPersistence) {}

  score(
    context: RequestContext,
    input: {
      partyId: string;
      partyRole: PerformanceScorecard['partyRole'];
      periodStart: string;
      periodEnd: string;
      metrics: Record<string, number>;
    },
  ) {
    if (Date.parse(input.periodEnd) <= Date.parse(input.periodStart)) throw new Error('INVALID_PERIOD_RANGE');
    for (const [field, value] of Object.entries(input.metrics)) requireScoreRange(value, field.toUpperCase());
    const scorecard: PerformanceScorecard = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      overallScore: Math.round(averageOf(Object.values(input.metrics))),
      computedAt: now(),
    };
    this.store.append('performanceScorecards', scorecard);
    emit(this.store, context, 'PerformanceScorecardComputed', 'PerformanceScorecard', scorecard.id, {
      partyId: scorecard.partyId,
      partyRole: scorecard.partyRole,
      overallScore: scorecard.overallScore,
    });
    return scorecard;
  }

  history(context: RequestContext, input: { partyId: string; partyRole: PerformanceScorecard['partyRole'] }) {
    const workspaceId = ws(context);
    return this.store
      .list<PerformanceScorecard>('performanceScorecards')
      .filter((x) => x.workspaceId === workspaceId && x.partyId === input.partyId && x.partyRole === input.partyRole);
  }

  latest(context: RequestContext, input: { partyId: string; partyRole: PerformanceScorecard['partyRole'] }) {
    const scorecards = this.history(context, input);
    return scorecards[scorecards.length - 1];
  }
}

// Engine 58 — Portfolio Analytics

export type PortfolioSnapshot = {
  id: string;
  workspaceId: string;
  scopeId: string;
  atRiskCount: number;
  blockedCount: number;
  unpaidAmountMinor: number;
  disputedCount: number;
  retainedAmountMinor: number;
  concentrationTopPartyPercent: number;
  currency: string;
  computedAt: string;
};

export class PortfolioAnalyticsEngine {
  constructor(private readonly store: TrustPersistence) {}

  snapshot(
    context: RequestContext,
    input: {
      scopeId: string;
      atRiskCount: number;
      blockedCount: number;
      unpaidAmountMinor: number;
      disputedCount: number;
      retainedAmountMinor: number;
      concentrationTopPartyPercent: number;
      currency: string;
    },
  ) {
    for (const [field, value] of Object.entries({
      atRiskCount: input.atRiskCount,
      blockedCount: input.blockedCount,
      unpaidAmountMinor: input.unpaidAmountMinor,
      disputedCount: input.disputedCount,
      retainedAmountMinor: input.retainedAmountMinor,
    }))
      requireNonNegative(value, field.toUpperCase());
    requireScoreRange(input.concentrationTopPartyPercent, 'CONCENTRATION_TOP_PARTY_PERCENT');
    const snapshot: PortfolioSnapshot = { id: randomUUID(), workspaceId: ws(context), ...input, computedAt: now() };
    this.store.append('portfolioSnapshots', snapshot);
    emit(this.store, context, 'PortfolioSnapshotComputed', 'PortfolioSnapshot', snapshot.id, {
      scopeId: snapshot.scopeId,
      atRiskCount: snapshot.atRiskCount,
      disputedCount: snapshot.disputedCount,
    });
    return snapshot;
  }

  trend(context: RequestContext, scopeId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<PortfolioSnapshot>('portfolioSnapshots')
      .filter((x) => x.workspaceId === workspaceId && x.scopeId === scopeId);
  }

  latest(context: RequestContext, scopeId: string) {
    const snapshots = this.trend(context, scopeId);
    return snapshots[snapshots.length - 1];
  }
}

// Engine 59 — Renewal & Relationship Intelligence

export type RenewalAssessment = {
  id: string;
  workspaceId: string;
  contractId: string;
  renewalReadinessScore: number;
  performanceHistorySummary: string;
  recommendedAction: 'RENEW' | 'RENEGOTIATE' | 'DO_NOT_RENEW' | 'REVIEW_REQUIRED';
  rationale: string;
  assessedBy: string;
  assessedAt: string;
};

export class RenewalRelationshipIntelligenceEngine {
  constructor(private readonly store: TrustPersistence) {}

  assess(
    context: RequestContext,
    input: {
      contractId: string;
      renewalReadinessScore: number;
      performanceHistorySummary: string;
      recommendedAction: RenewalAssessment['recommendedAction'];
      rationale: string;
    },
  ) {
    requireScoreRange(input.renewalReadinessScore, 'RENEWAL_READINESS_SCORE');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const assessment: RenewalAssessment = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      assessedBy: context.actorUserId,
      assessedAt: now(),
    };
    this.store.append('renewalAssessments', assessment);
    emit(this.store, context, 'RenewalAssessed', 'RenewalAssessment', assessment.id, {
      contractId: assessment.contractId,
      recommendedAction: assessment.recommendedAction,
    });
    return assessment;
  }

  latest(context: RequestContext, contractId: string) {
    const workspaceId = ws(context);
    const assessments = this.store
      .list<RenewalAssessment>('renewalAssessments')
      .filter((x) => x.workspaceId === workspaceId && x.contractId === contractId);
    return assessments[assessments.length - 1];
  }
}

// Engine 60 — AI Decision Support & Continuous Improvement
//
// This is the capstone AI-governance engine for the whole platform: every model
// used anywhere in AssuraPay is expected to be registered here, evaluated against
// a threshold, monitored for drift, and given human feedback. A `Recommendation`
// is the only artifact this engine produces that resembles a "decision," and it
// is never auto-executed — it starts `PENDING` and requires an explicit human
// `decideRecommendation` call to accept or dismiss it.

export type ModelRegistration = {
  id: string;
  workspaceId: string;
  modelId: string;
  modelVersion: string;
  purpose: string;
  governedBy: string;
  status: 'ACTIVE' | 'DEPRECATED';
  registeredAt: string;
};

export type EvaluationRecord = {
  id: string;
  workspaceId: string;
  modelRegistrationId: string;
  metric: string;
  score: number;
  threshold: number;
  passed: boolean;
  evaluatedAt: string;
};

export type DriftAlert = {
  id: string;
  workspaceId: string;
  modelRegistrationId: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  raisedAt: string;
  resolvedAt?: string;
};

export type ModelFeedback = {
  id: string;
  workspaceId: string;
  modelRegistrationId: string;
  outputReference: string;
  rating: 'POSITIVE' | 'NEGATIVE';
  comment: string;
  submittedBy: string;
  submittedAt: string;
};

export type Recommendation = {
  id: string;
  workspaceId: string;
  scopeId: string;
  modelRegistrationId: string;
  recommendation: string;
  confidence: number;
  status: 'PENDING' | 'ACCEPTED' | 'DISMISSED';
  createdAt: string;
  decidedAt?: string;
};

export class AiDecisionSupportEngine {
  constructor(private readonly store: TrustPersistence) {}

  registerModel(
    context: RequestContext,
    input: { modelId: string; modelVersion: string; purpose: string; governedBy: string },
  ) {
    if (!input.purpose.trim()) throw new Error('PURPOSE_REQUIRED');
    const registration: ModelRegistration = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'ACTIVE',
      registeredAt: now(),
    };
    this.store.append('modelRegistrations', registration);
    return registration;
  }

  deprecateModel(context: RequestContext, id: string) {
    const registration = get<ModelRegistration>(this.store, 'modelRegistrations', context, id);
    if (registration.status !== 'ACTIVE') throw new Error('MODEL_NOT_ACTIVE');
    const deprecated: ModelRegistration = { ...registration, status: 'DEPRECATED' };
    this.store.replace('modelRegistrations', deprecated);
    return deprecated;
  }

  recordEvaluation(
    context: RequestContext,
    input: { modelRegistrationId: string; metric: string; score: number; threshold: number },
  ) {
    get<ModelRegistration>(this.store, 'modelRegistrations', context, input.modelRegistrationId);
    const passed = input.score >= input.threshold;
    const evaluation: EvaluationRecord = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      passed,
      evaluatedAt: now(),
    };
    this.store.append('evaluationRecords', evaluation);
    emit(this.store, context, 'EvaluationRecorded', 'EvaluationRecord', evaluation.id, {
      modelRegistrationId: evaluation.modelRegistrationId,
      passed,
    });
    if (!passed)
      this.raiseDrift(context, {
        modelRegistrationId: input.modelRegistrationId,
        description: `Evaluation for metric "${input.metric}" scored ${input.score}, below threshold ${input.threshold}`,
        severity: input.score < input.threshold / 2 ? 'HIGH' : 'MEDIUM',
      });
    return evaluation;
  }

  raiseDrift(
    context: RequestContext,
    input: { modelRegistrationId: string; description: string; severity: DriftAlert['severity'] },
  ) {
    const alert: DriftAlert = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      raisedAt: now(),
    };
    this.store.append('driftAlerts', alert);
    emit(this.store, context, 'DriftAlertRaised', 'DriftAlert', alert.id, {
      modelRegistrationId: alert.modelRegistrationId,
      severity: alert.severity,
    });
    return alert;
  }

  acknowledgeDrift(context: RequestContext, id: string) {
    const alert = get<DriftAlert>(this.store, 'driftAlerts', context, id);
    if (alert.status !== 'OPEN') throw new Error('DRIFT_ALERT_NOT_OPEN');
    const acknowledged: DriftAlert = { ...alert, status: 'ACKNOWLEDGED' };
    this.store.replace('driftAlerts', acknowledged);
    return acknowledged;
  }

  resolveDrift(context: RequestContext, id: string) {
    const alert = get<DriftAlert>(this.store, 'driftAlerts', context, id);
    if (alert.status === 'RESOLVED') throw new Error('DRIFT_ALERT_ALREADY_RESOLVED');
    const resolved: DriftAlert = { ...alert, status: 'RESOLVED', resolvedAt: now() };
    this.store.replace('driftAlerts', resolved);
    emit(this.store, context, 'DriftAlertResolved', 'DriftAlert', alert.id, {});
    return resolved;
  }

  openDrifts(context: RequestContext, modelRegistrationId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<DriftAlert>('driftAlerts')
      .filter(
        (x) =>
          x.workspaceId === workspaceId && x.modelRegistrationId === modelRegistrationId && x.status !== 'RESOLVED',
      );
  }

  submitFeedback(
    context: RequestContext,
    input: { modelRegistrationId: string; outputReference: string; rating: ModelFeedback['rating']; comment: string },
  ) {
    get<ModelRegistration>(this.store, 'modelRegistrations', context, input.modelRegistrationId);
    const feedback: ModelFeedback = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      submittedBy: context.actorUserId,
      submittedAt: now(),
    };
    this.store.append('modelFeedback', feedback);
    return feedback;
  }

  recommend(
    context: RequestContext,
    input: { scopeId: string; modelRegistrationId: string; recommendation: string; confidence: number },
  ) {
    get<ModelRegistration>(this.store, 'modelRegistrations', context, input.modelRegistrationId);
    if (!input.recommendation.trim()) throw new Error('RECOMMENDATION_REQUIRED');
    if (input.confidence < 0 || input.confidence > 1) throw new Error('INVALID_CONFIDENCE');
    const recommendation: Recommendation = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'PENDING',
      createdAt: now(),
    };
    this.store.append('recommendations', recommendation);
    emit(this.store, context, 'RecommendationCreated', 'Recommendation', recommendation.id, {
      scopeId: recommendation.scopeId,
      confidence: recommendation.confidence,
    });
    return recommendation;
  }

  decideRecommendation(context: RequestContext, input: { id: string; decision: 'ACCEPTED' | 'DISMISSED' }) {
    const recommendation = get<Recommendation>(this.store, 'recommendations', context, input.id);
    if (recommendation.status !== 'PENDING') throw new Error('RECOMMENDATION_ALREADY_DECIDED');
    const decided: Recommendation = { ...recommendation, status: input.decision, decidedAt: now() };
    this.store.replace('recommendations', decided);
    emit(this.store, context, 'RecommendationDecided', 'Recommendation', recommendation.id, {
      decision: input.decision,
    });
    return decided;
  }
}

// Deterministic adapter for local development and certification only. Production
// deployments must supply a real `FinancialForecastGateway` backed by a governed
// model registered through Engine 60.
export const deterministicFinancialForecastGateway: FinancialForecastGateway = {
  async forecast(input) {
    const signalAverage = averageOf(Object.values(input.signals));
    return {
      modelId: 'deterministic-financial-forecast',
      modelVersion: '1',
      predictedValue: Math.round(100 - signalAverage),
      confidence: 0.6,
      rationale: `Deterministic baseline forecast for ${input.forecastType} derived from ${Object.keys(input.signals).length} signal(s).`,
    };
  },
};
