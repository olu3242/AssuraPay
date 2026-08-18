import { z } from 'zod';
import {
  calendarDate,
  count,
  currencyCode,
  identifier,
  instant,
  minorUnits,
  percentage,
  requiredText,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch L — the nine enterprise-analytics aggregates of
 * canonical Engines 56-60.
 *
 * The last batch in the register, and the one that frees the three trust-domain compatibility tables:
 * these nine are all that still reference the deprecated `workspaces`, and all that still predicate their
 * policies on `has_active_workspace_membership()`, which is what keeps `workspace_memberships` and
 * `user_identities` alive.
 *
 * ## The closure is exactly the nine
 *
 * Every inbound foreign key comes from inside the batch, all of them pointing at `model_registrations` —
 * the hub, with four children. Outbound, everything points at `workspaces` and nothing else. So the
 * conversion set is closed in both directions, verified against a live migrated instance.
 *
 * ## Four transition, and every one of them was broken
 *
 * This batch's discovery is the sharpest instance of a pattern that has recurred since Batch A, and it
 * lands on the engine whose own header calls it "the capstone AI-governance engine for the whole
 * platform". Three of the four transitioning aggregates carried a blanket append-only trigger, so the
 * transition refused; the fourth carried **no mutation boundary at all**.
 *
 *   - `financialForecasts.review` — refused. These forecast `FUNDING_DELAY`, `PAYMENT_FAILURE`,
 *     `LEAKAGE` and `RECONCILIATION_EXCEPTION`, so the unreviewable output is about money;
 *   - `modelRegistrations.deprecateModel` — refused. `recordEvaluation` raises a drift alert
 *     automatically when a score falls below its threshold, so the platform could detect that a model
 *     had gone wrong and could not take it out of service;
 *   - `recommendations.decideRecommendation` — refused. The header states a recommendation "is never
 *     auto-executed — it starts PENDING and requires an explicit human decideRecommendation call";
 *   - `driftAlerts.acknowledgeDrift` / `resolveDrift` — worked, because `drift_alerts` had no trigger.
 *     The record that a model has drifted was the one thing anybody could rewrite or delete.
 *
 * Every human decision point in the platform's AI governance was unperformable on PostgreSQL, and the
 * evidence of model failure was freely editable. `202608110015` inverts both.
 *
 * ## Derived fields that a row can check, and one that already had a constraint
 *
 * `evaluation_records.passed` follows from `score >= threshold`, and unlike Batch K's `kpi_values.on_track`
 * both operands live in the same row — so this one becomes a real CHECK rather than an application
 * invariant. A row claiming a passing evaluation below its own threshold is a model certified against a
 * bar it did not clear.
 *
 * `performance_scorecards.overall_score` is the rounded mean of `metrics`, and `period_end > period_start`
 * was already constrained by `202608030009` — the one pre-existing invariant in the batch, kept rather
 * than restated.
 *
 * Two status/timestamp pairs must agree: a RESOLVED drift alert has a `resolved_at` and an unresolved one
 * does not, and a decided recommendation has a `decided_at` while a PENDING one does not. A resolved alert
 * with no resolution time cannot be aged, and a pending recommendation carrying a decision time reads as
 * decided to anything sorting by it.
 *
 * Derived from engine semantics, not from table introspection.
 */

// Engine 56 — Financial & Payment Intelligence

export const financialForecastSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    forecastType: z.enum([
      'FUNDING_DELAY',
      'RELEASE_DELAY',
      'PAYMENT_FAILURE',
      'LEAKAGE',
      'RECONCILIATION_EXCEPTION',
    ]),
    // A forecast that cannot name what produced it is a prediction no one can reproduce or attribute.
    // Engine 60 is where these models are meant to be registered, which is what makes the pair meaningful
    // rather than decorative.
    modelId: identifier,
    modelVersion: identifier,
    predictedValue: z.number().finite(),
    // Bounded by the engine and the column alike, as in Batch K.
    confidence: z.number().min(0).max(1),
    rationale: requiredText,
    reviewStatus: z.enum(['NOT_REVIEWED', 'ACCEPTED', 'REJECTED']),
    generatedAt: instant,
  })
  .strict();

// Engine 57 — Vendor & Customer Performance

/** Named metrics, each a score out of a hundred. `score()` refuses anything outside 0-100 per metric. */
export const metricsSchema = z.record(percentage).refine((value) => Object.keys(value).length > 0, {
  message: 'a scorecard measures at least one metric',
});

export const performanceScorecardSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    partyId: identifier,
    partyRole: z.enum(['VENDOR', 'CUSTOMER']),
    periodStart: calendarDate,
    periodEnd: calendarDate,
    metrics: metricsSchema,
    overallScore: percentage,
    computedAt: instant,
  })
  .strict()
  // `score()` refuses `INVALID_PERIOD_RANGE`, and `202608030009` already constrains it in the table. A
  // scorecard whose period ends before it starts measures a negative interval, and every trend that sorts
  // by period places it arbitrarily.
  .refine((value) => Date.parse(value.periodEnd) > Date.parse(value.periodStart), {
    message: 'a scoring period ends after it starts',
    path: ['periodEnd'],
  })
  // The overall score is the rounded mean of the metrics, not a separate judgement. A scorecard whose
  // headline disagrees with its own measurements is the number a reader acts on.
  .refine((value) => value.overallScore === scorecardOverallScore(value.metrics), {
    message: 'the overall score is the rounded mean of the metrics',
    path: ['overallScore'],
  });

/**
 * The engine's own aggregation, in one place.
 *
 * `score()` computes `Math.round(averageOf(Object.values(metrics)))`. Repeated here rather than described,
 * so the schema and the engine cannot drift apart silently — the same reason `riskLevelForScore` is
 * exported from Batch I and `kpiValueIsOnTrack` from Batch K.
 */
export function scorecardOverallScore(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Engine 58 — Portfolio Analytics

export const portfolioSnapshotSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    atRiskCount: count,
    blockedCount: count,
    // Integer minor units, per CLAUDE.md's fourth constraint. The columns are already BIGINT with a
    // non-negative check — the one place in the deferred group where the money shape was got right first
    // time — so this mirrors them rather than correcting them.
    unpaidAmountMinor: minorUnits,
    disputedCount: count,
    retainedAmountMinor: minorUnits,
    concentrationTopPartyPercent: percentage,
    currency: currencyCode,
    computedAt: instant,
  })
  .strict();

// Engine 59 — Renewal & Relationship Intelligence

export const renewalAssessmentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    renewalReadinessScore: percentage,
    performanceHistorySummary: requiredText,
    recommendedAction: z.enum(['RENEW', 'RENEGOTIATE', 'DO_NOT_RENEW', 'REVIEW_REQUIRED']),
    // `assess()` refuses `RATIONALE_REQUIRED`. A recommendation to renew or not renew a contract with no
    // stated reasoning is a conclusion nobody can review.
    rationale: requiredText,
    assessedBy: identifier,
    assessedAt: instant,
  })
  .strict();

// Engine 60 — AI Decision Support & Continuous Improvement

export const modelRegistrationSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    modelId: identifier,
    modelVersion: identifier,
    // `registerModel` refuses `PURPOSE_REQUIRED`. A registered model with no stated purpose cannot be
    // assessed for whether it is being used for what it was approved for.
    purpose: requiredText,
    governedBy: requiredText,
    status: z.enum(['ACTIVE', 'DEPRECATED']),
    registeredAt: instant,
  })
  .strict();

export const evaluationRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    modelRegistrationId: identifier,
    metric: requiredText,
    score: z.number().finite(),
    threshold: z.number().finite(),
    passed: z.boolean(),
    evaluatedAt: instant,
  })
  .strict()
  // Derived, and checkable from the row because both operands are in it. A record claiming a pass below
  // its own threshold is a model certified against a bar it did not clear — and `recordEvaluation` raises a
  // drift alert on a failure, so a falsified pass also suppresses the alert.
  .refine((value) => value.passed === value.score >= value.threshold, {
    message: 'passed follows from score against threshold',
    path: ['passed'],
  });

export const driftAlertSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    modelRegistrationId: identifier,
    description: requiredText,
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
    raisedAt: instant,
    resolvedAt: instant.optional(),
  })
  .strict()
  // `resolveDrift` sets both together. A RESOLVED alert with no resolution time cannot be aged or audited,
  // and an OPEN one carrying a resolution time reads as closed to anything filtering on the timestamp
  // rather than the status — `openDrifts` filters on status, so the two would disagree.
  .refine((value) => (value.status === 'RESOLVED') === (value.resolvedAt !== undefined), {
    message: 'a resolved alert records when, and an unresolved one records nothing',
    path: ['resolvedAt'],
  })
  .refine(
    (value) => value.resolvedAt === undefined || Date.parse(value.resolvedAt) >= Date.parse(value.raisedAt),
    { message: 'an alert cannot be resolved before it was raised', path: ['resolvedAt'] },
  );

export const modelFeedbackSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    modelRegistrationId: identifier,
    outputReference: requiredText,
    rating: z.enum(['POSITIVE', 'NEGATIVE']),
    comment: requiredText,
    submittedBy: identifier,
    submittedAt: instant,
  })
  .strict();

export const recommendationSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    modelRegistrationId: identifier,
    recommendation: requiredText,
    confidence: z.number().min(0).max(1),
    status: z.enum(['PENDING', 'ACCEPTED', 'DISMISSED']),
    createdAt: instant,
    decidedAt: instant.optional(),
  })
  .strict()
  // `decideRecommendation` sets both together, and the engine's contract is that a recommendation is never
  // auto-executed. A PENDING row carrying a decision time reads as decided to anything sorting by it; a
  // decided row with none cannot be attributed to a moment.
  .refine((value) => (value.status !== 'PENDING') === (value.decidedAt !== undefined), {
    message: 'a decided recommendation records when, and a pending one records nothing',
    path: ['decidedAt'],
  })
  .refine(
    (value) => value.decidedAt === undefined || Date.parse(value.decidedAt) >= Date.parse(value.createdAt),
    { message: 'a recommendation cannot be decided before it existed', path: ['decidedAt'] },
  );

/**
 * The schema version stored beside every Batch L row.
 *
 * One for all nine, because they are activated together.
 */
export const BATCH_L_SCHEMA_VERSION = 1;

export type BatchLAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_L_AGGREGATES: readonly BatchLAggregateContract[] = Object.freeze([
  { collection: 'financialForecasts', table: 'financial_forecasts', engine: '56', schema: financialForecastSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'performanceScorecards', table: 'performance_scorecards', engine: '57', schema: performanceScorecardSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'portfolioSnapshots', table: 'portfolio_snapshots', engine: '58', schema: portfolioSnapshotSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'renewalAssessments', table: 'renewal_assessments', engine: '59', schema: renewalAssessmentSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'modelRegistrations', table: 'model_registrations', engine: '60', schema: modelRegistrationSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'evaluationRecords', table: 'evaluation_records', engine: '60', schema: evaluationRecordSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'driftAlerts', table: 'drift_alerts', engine: '60', schema: driftAlertSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'modelFeedback', table: 'model_feedback', engine: '60', schema: modelFeedbackSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
  { collection: 'recommendations', table: 'recommendations', engine: '60', schema: recommendationSchema, schemaVersion: BATCH_L_SCHEMA_VERSION },
]);

export const BATCH_L_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_L_AGGREGATES.map((aggregate) => aggregate.collection),
);

export const BATCH_L_TABLES: readonly string[] = Object.freeze(
  BATCH_L_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Five of nine. A scorecard, a portfolio snapshot, a renewal assessment, an evaluation record and a piece
 * of model feedback are each a measurement or a statement made at a moment: recomputing or reassessing
 * produces a new row, and no engine passes any of them to `replace`.
 *
 * The other four transition, and `202608110015` is why they now can — three were refused by a blanket
 * append-only trigger, and `driftAlerts` had no boundary at all.
 */
export const BATCH_L_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'evaluationRecords',
  'modelFeedback',
  'performanceScorecards',
  'portfolioSnapshots',
  'renewalAssessments',
]);

/** The contract for a collection, or `undefined` when Batch L does not own it. */
export function batchLContract(collection: string): BatchLAggregateContract | undefined {
  return BATCH_L_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}
