import { z } from 'zod';
import {
  calendarDate,
  count,
  currencyCode,
  identifier,
  instant,
  minorUnits,
  percentage,
  positiveMinorUnits,
  requiredText,
  signedMinorUnits,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch G — the six performance-readiness aggregates of
 * canonical Engines 26-30.
 *
 * Batch G closes the reference Batch B had to leave open. `paymentEligibility.paymentTriggerRuleId` is
 * `NOT NULL` and has never been a foreign key, because the rule it names had no durable home; the
 * settlement path has therefore been citing an authority that could not be stored. That reference
 * becomes a real key in `202608110009`, which is the point of doing this batch next rather than by
 * catalogue order.
 *
 * These six tables have existed since `202608030005` with their own constraints and no production
 * reader or writer, the same starting position Batches A and E had. So this batch converges rather than
 * creates, and the discovery that matters is the one the register predicted: **the mutation boundary
 * disagrees with the engines, and in the direction that silently disables them.** `202608030005` put a
 * blanket `prevent_append_only_mutation` trigger on `acceptance_criteria`, `success_metrics` and
 * `payment_trigger_rules`, and all three are aggregates their engines transition:
 *
 *   - `AcceptanceCriteriaEngine.confirm` moves DRAFT → CONFIRMED;
 *   - `SuccessMetricsEngine.confirm` moves DRAFT → CONFIRMED;
 *   - `PaymentTriggerRuleEngine.activate` moves DRAFT → ACTIVE.
 *
 * On the durable path every one of those refuses. The third is the consequential one: a payment trigger
 * rule that cannot leave DRAFT is a rule that can never authorise anything, so the eligibility record
 * pointing at it would cite a rule that is permanently inert. `202608110009` replaces the blanket
 * triggers with governed-transition triggers that permit exactly the transitions the engines make.
 *
 * `dependencies` and the two baseline aggregates were already right, and are left alone:
 * `dependencies` carries no append-only trigger and is resolved by its engine; `performance_baselines`
 * has one status and never moves; `baseline_variances` is a record of an observation, not a state.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine won.
 */

/**
 * A tolerance band on an acceptance criterion.
 *
 * `BETWEEN` is the only operator with two bounds, and the upper one must exceed the target — the engine
 * refuses `INVALID_TOLERANCE_RANGE` otherwise. Stated here as well, because a tolerance whose upper
 * bound sits below its target admits nothing and would fail every measurement taken against it.
 */
export const toleranceRuleSchema = z
  .object({
    operator: z.enum(['EQ', 'GTE', 'LTE', 'BETWEEN']),
    target: z.number(),
    unit: requiredText,
    upperBound: z.number().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.operator !== 'BETWEEN' ||
      (value.upperBound !== undefined && value.upperBound > value.target),
    {
      message: 'a BETWEEN tolerance needs an upper bound above its target',
      path: ['upperBound'],
    },
  );

// Engine 26 — Acceptance Criteria

export const acceptanceCriterionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    deliverableId: identifier,
    description: requiredText,
    testMethod: z.enum(['INSPECTION', 'MEASUREMENT', 'DOCUMENT_REVIEW', 'FUNCTIONAL_TEST']),
    metric: requiredText,
    tolerance: toleranceRuleSchema,
    validatorRole: requiredText,
    retestAllowed: z.boolean(),
    maxRetests: count,
    status: z.enum(['DRAFT', 'CONFIRMED']),
    createdAt: instant,
  })
  .strict()
  // The retest configuration is one decision expressed in two fields, so the two have to agree. The
  // engine refuses `INVALID_RETEST_CONFIGURATION`; the database checked only `max_retests >= 0`, which
  // admits both nonsense readings — a criterion that forbids retests while allowing three, and one that
  // allows retests while permitting none.
  .refine((value) => (value.retestAllowed ? value.maxRetests >= 1 : value.maxRetests === 0), {
    message: 'retests allowed means at least one, and forbidden means none',
    path: ['maxRetests'],
  });

// Engine 27 — Success Metrics

export const successMetricSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    kind: z.enum(['KPI', 'SLA', 'QUALITY', 'TIMELINESS', 'OUTCOME', 'COST']),
    name: requiredText,
    targetValue: z.number(),
    unit: requiredText,
    direction: z.enum(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']),
    // A metric carrying no weight cannot affect the outcome it is supposed to measure, and one over 100
    // would exceed the whole allocation by itself.
    weightPercent: percentage.refine((value) => value > 0, {
      message: 'a metric must carry some weight',
    }),
    status: z.enum(['DRAFT', 'CONFIRMED']),
    createdAt: instant,
  })
  .strict();

// Engine 28 — Dependency Intelligence

export const dependencySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    kind: z.enum(['INTERNAL', 'EXTERNAL', 'VENDOR', 'CUSTOMER', 'REGULATORY', 'FUNDING']),
    description: requiredText,
    ownerId: identifier,
    dueDate: calendarDate,
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'BLOCKING']),
    status: z.enum(['OPEN', 'RESOLVED']),
    createdAt: instant,
    resolvedAt: instant.optional(),
  })
  .strict()
  // `blockers()` treats every OPEN BLOCKING dependency as a reason a milestone cannot proceed, so a
  // resolution that does not record when it happened cannot be placed in the audit chain, and an open
  // dependency carrying a resolution time is a contradiction a reader would have to guess about.
  .refine((value) => (value.status === 'RESOLVED') === (value.resolvedAt !== undefined), {
    message: 'a resolved dependency records when it resolved, and an open one does not',
    path: ['resolvedAt'],
  });

// Engine 29 — Payment Trigger

export const paymentTriggerRuleSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    name: requiredText,
    ruleType: z.enum(['MILESTONE_COMPLETION', 'DOD_PUBLISHED', 'ACCEPTANCE_PASSED', 'HYBRID']),
    requiredDodPackageId: identifier.optional(),
    requiredAcceptanceCriterionIds: z.array(identifier),
    // Money outside the settlement batches, so `docs/finance/MONETARY_INVARIANTS.md` governs it: minor
    // units, integral, and positive because a rule releasing nothing is not a trigger.
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']),
    createdAt: instant,
  })
  .strict()
  // What the rule type promises, the rule must carry. A DOD_PUBLISHED rule with no package to check
  // would be a condition with nothing to evaluate, and since `paymentEligibility` cites the rule as the
  // authority a release rests on, an unevaluable rule is worse than an absent one: it looks like a
  // condition and passes vacuously. The engine refuses both; so does the schema, and so does the
  // database in `202608110009`.
  .refine(
    (value) =>
      !['DOD_PUBLISHED', 'HYBRID'].includes(value.ruleType) ||
      value.requiredDodPackageId !== undefined,
    {
      message: 'a rule that turns on a definition of done must name one',
      path: ['requiredDodPackageId'],
    },
  )
  .refine(
    (value) =>
      !['ACCEPTANCE_PASSED', 'HYBRID'].includes(value.ruleType) ||
      value.requiredAcceptanceCriterionIds.length > 0,
    {
      message: 'a rule that turns on acceptance must name at least one criterion',
      path: ['requiredAcceptanceCriterionIds'],
    },
  );

// Engine 30 — Performance Baseline

export const performanceBaselineSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    milestoneId: identifier,
    plannedStartDate: calendarDate,
    plannedDueDate: calendarDate,
    plannedBudgetAmountMinor: positiveMinorUnits,
    plannedScopeItemCount: count,
    plannedQualityScore: percentage,
    plannedRiskScore: percentage,
    // One value, and it never moves. A baseline is the plan as it stood; revising it would destroy the
    // comparison every variance is measured against.
    status: z.literal('BASELINED'),
    createdAt: instant,
  })
  .strict()
  // A plan that finishes before it starts cannot be a plan, and `recordVariance` computes the schedule
  // variance as days from `plannedDueDate`, so an inverted pair yields a variance that reads as early
  // delivery.
  .refine((value) => value.plannedDueDate >= value.plannedStartDate, {
    message: 'the planned due date cannot precede the planned start',
    path: ['plannedDueDate'],
  });

export const baselineVarianceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    baselineId: identifier,
    actualStartDate: calendarDate.optional(),
    actualDueDate: calendarDate.optional(),
    // Absent means not yet observed, which is not the same as zero. Present means an actual cost, which
    // may be zero but never negative.
    actualCostAmountMinor: minorUnits.optional(),
    actualScopeItemCount: count.optional(),
    actualQualityScore: percentage.optional(),
    actualRiskScore: percentage.optional(),
    // Signed, all three: behind schedule and ahead of it are both real, as are overspend and underspend
    // and scope added and dropped. A magnitude with no direction would make the variance unreadable.
    scheduleVarianceDays: z.number().int(),
    costVarianceMinor: signedMinorUnits,
    scopeVarianceCount: z.number().int(),
    recordedBy: identifier,
    recordedAt: instant,
  })
  .strict();

/**
 * The schema version stored beside every Batch G row.
 *
 * One for all six, because they are activated together. A row declaring a version this build cannot
 * parse is refused rather than read optimistically.
 */
export const BATCH_G_SCHEMA_VERSION = 1;

export type BatchGAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_G_AGGREGATES: readonly BatchGAggregateContract[] = Object.freeze([
  { collection: 'acceptanceCriteria', table: 'acceptance_criteria', engine: '26', schema: acceptanceCriterionSchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
  { collection: 'successMetrics', table: 'success_metrics', engine: '27', schema: successMetricSchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
  { collection: 'dependencies', table: 'dependencies', engine: '28', schema: dependencySchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
  { collection: 'paymentTriggerRules', table: 'payment_trigger_rules', engine: '29', schema: paymentTriggerRuleSchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
  { collection: 'performanceBaselines', table: 'performance_baselines', engine: '30', schema: performanceBaselineSchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
  { collection: 'baselineVariances', table: 'baseline_variances', engine: '30', schema: baselineVarianceSchema, schemaVersion: BATCH_G_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_G_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_G_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_G_TABLES: readonly string[] = Object.freeze(
  BATCH_G_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Two, and only two. `202608030005` asserted five, which is the defect this batch found: three of those
 * five are transitioned by their engines, so the trigger did not describe an append-only aggregate — it
 * disabled a working one. A table is append-only because of what the engines do with it, not because of
 * what a historical migration hoped.
 */
export const BATCH_G_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'performanceBaselines',
  'baselineVariances',
]);

/** The contract for a collection, or `undefined` when Batch G does not own it. */
export function batchGContract(collection: string): BatchGAggregateContract | undefined {
  return BATCH_G_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}
