import { z } from 'zod';
import { identifier, instant, percentage, requiredText } from './primitives';

/**
 * The canonical persisted-state schemas for Batch K — the six enterprise-intelligence aggregates of
 * canonical Engines 51-55.
 *
 * These are the first of the group the accepted decision deferred "until the persistence boundary is
 * resolved". Batch J resolved it, and these six turn out to be on the critical path rather than at the end of
 * it: their tables are six of the sixteen still referencing the deprecated `workspaces`, and six of the
 * fifteen whose policies still call `has_active_workspace_membership()` — which is what keeps
 * `workspace_memberships` and `user_identities` alive.
 *
 * ## The closure is exactly the six
 *
 * For the first time in the register, nothing outside the batch references it and nothing inside it
 * references anything outside except the deprecated workspace table. The single intra-set key is
 * `kpi_values.kpi_definition_id → kpi_definitions.id`. That makes this the cleanest conversion in the
 * programme and the reason it is the right batch to take first.
 *
 * ## Four are measurements, two are decisions
 *
 * An assurance index, a KPI value and a dashboard snapshot are all *a value at a moment*: recomputing is a
 * new row, and the engines only ever append them. The other two transition, and both were blocked — see
 * `202608110014`. A KPI definition is retired, and a forecast is reviewed.
 *
 * ## Derived fields, and why they are constrained rather than trusted
 *
 * Three of these aggregates carry a field the engine computes from the others in the same row, which means
 * the row can be internally inconsistent and read as authoritative:
 *
 *   - an execution index's `score` is zero and `overridden` true whenever any mandatory gate failed, and
 *     `failedGates` is exactly the gates that failed. A row with a high score and a failed gate is a green
 *     banner over work that did not pass its mandatory gates;
 *   - a settlement index is the same shape driven by `activeHold`, which is CLAUDE.md's dispute hold — a
 *     settlement index reading healthy while a hold is active is the second hard constraint appearing to
 *     hold when it does not;
 *   - a KPI value's `onTrack` follows from the definition's `direction` and `targetValue`. It cannot be
 *     checked from the value's own row — the target lives on the parent — so it is the one derived field
 *     here that stays an application invariant, and the schema says so rather than pretending.
 *
 * ## `confidence` is bounded here, unlike Batch I's
 *
 * `forecast()` refuses `INVALID_CONFIDENCE` outside 0-1 and the column has `CHECK (confidence BETWEEN 0 AND
 * 1)`, so the scale is stated by both. Batch I recorded the opposite for `agreement-intelligence`, where
 * nothing bounds it and the scale is unstated; the contrast is worth keeping, because it shows the gap there
 * is a gap in that model rather than a convention the platform lacks.
 *
 * Derived from engine semantics, not from table introspection.
 */

/** A mandatory gate's result, as `compute` receives it. */
export const mandatoryGateResultSchema = z
  .object({
    gate: requiredText,
    passed: z.boolean(),
  })
  .strict();

/**
 * A factor set: named scores, each out of a hundred.
 *
 * `requireScoreRange` refuses anything outside 0-100 per factor, and at least one factor is required —
 * `averageOf` returns 0 for an empty set, so an index with no factors scores zero and shows the worst
 * possible reading as though it had been measured.
 */
export const factorsSchema = z.record(percentage).refine((value) => Object.keys(value).length > 0, {
  message: 'an index scores at least one factor',
});

// Engine 51 — Execution Assurance Index

export const executionAssuranceIndexSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    factors: factorsSchema,
    mandatoryGates: z.array(mandatoryGateResultSchema),
    score: percentage,
    overridden: z.boolean(),
    failedGates: z.array(requiredText),
    computedAt: instant,
  })
  .strict()
  // `failedGates` is derived: exactly the gates in `mandatoryGates` that did not pass. A row naming a failed
  // gate that is not in its own gate list, or omitting one that is, describes a different evaluation from the
  // one it carries.
  .refine(
    (value) => {
      const failed = value.mandatoryGates.filter((gate) => !gate.passed).map((gate) => gate.gate);
      return (
        failed.length === value.failedGates.length &&
        failed.every((gate) => value.failedGates.includes(gate))
      );
    },
    { message: 'failedGates is exactly the mandatory gates that did not pass', path: ['failedGates'] },
  )
  // `overridden` follows from whether anything failed.
  .refine((value) => value.overridden === value.failedGates.length > 0, {
    message: 'overridden is true exactly when a mandatory gate failed',
    path: ['overridden'],
  })
  // And a failed mandatory gate scores zero. This is the one that matters: a high score beside a failed gate
  // is a green banner over work that did not pass, and the banner is what a reader acts on.
  .refine((value) => !value.overridden || value.score === 0, {
    message: 'an overridden index scores zero',
    path: ['score'],
  });

// Engine 52 — Settlement Assurance Index

export const settlementAssuranceIndexSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    factors: factorsSchema,
    activeHold: z.boolean(),
    score: percentage,
    overridden: z.boolean(),
    computedAt: instant,
  })
  .strict()
  // The hold is the override, and CLAUDE.md's second hard constraint is what an active hold enforces. A
  // settlement index reading healthy while a hold is active shows the constraint holding when it is not.
  .refine((value) => value.overridden === value.activeHold, {
    message: 'overridden is true exactly when a hold is active',
    path: ['overridden'],
  })
  .refine((value) => !value.activeHold || value.score === 0, {
    message: 'an index computed under an active hold scores zero',
    path: ['score'],
  });

// Engine 53 — Enterprise KPI

export const kpiDefinitionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    kind: z.enum(['PORTFOLIO', 'EXECUTION', 'EVIDENCE', 'RISK', 'PAYMENT', 'SETTLEMENT']),
    // `define` refuses a blank name, and the name is how a KPI is identified in every dashboard that
    // reports it.
    name: requiredText,
    targetValue: z.number().finite(),
    direction: z.enum(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']),
    unit: requiredText,
    status: z.enum(['ACTIVE', 'RETIRED']),
    createdAt: instant,
  })
  .strict();

export const kpiValueSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    kpiDefinitionId: identifier,
    scopeId: identifier,
    // `recordValue` refuses a non-finite actual. Deliberately unbounded otherwise: a KPI's unit is free text,
    // so the value's range is the definition's business and not something to guess at here.
    actualValue: z.number().finite(),
    onTrack: z.boolean(),
    recordedAt: instant,
  })
  .strict();

/**
 * Whether a value is on track, on the engine's own comparison.
 *
 * Repeated here rather than described, so the engine and this contract cannot drift apart silently — the same
 * reason `riskLevelForScore` is exported from Batch I. It takes the definition because `onTrack` cannot be
 * checked from the value's row alone: the target lives on the parent, and PostgreSQL forbids a subquery in a
 * CHECK constraint against another table. So this is the one derived field in the batch that stays an
 * application invariant, enforced by `kpiValuesOnTrack` in the store's suite rather than by the database, and
 * saying so is better than a constraint that looks like it covers it.
 */
export function kpiValueIsOnTrack(
  definition: { direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER'; targetValue: number },
  actualValue: number,
): boolean {
  return definition.direction === 'HIGHER_IS_BETTER'
    ? actualValue >= definition.targetValue
    : actualValue <= definition.targetValue;
}

// Engine 54 — Executive Dashboard

export const dashboardWidgetSchema = z
  .object({
    key: requiredText,
    label: requiredText,
    value: z.union([z.number(), z.string()]),
    allowedRoles: z.array(requiredText),
  })
  .strict();

export const dashboardSnapshotSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    role: requiredText,
    widgets: z.array(dashboardWidgetSchema),
    generatedFor: identifier,
    generatedAt: instant,
  })
  .strict()
  // `compose` filters the widgets to those the role may see, so a stored widget outside the role's allow-list
  // is a figure the viewer was never entitled to — materialised, persisted, and readable from the snapshot
  // rather than from the engine that filtered it.
  .refine((value) => value.widgets.every((widget) => widget.allowedRoles.includes(value.role)), {
    message: 'a snapshot holds only widgets its role may see',
    path: ['widgets'],
  });

// Engine 55 — Predictive Execution Intelligence

export const executionForecastSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    scopeId: identifier,
    forecastType: z.enum(['DELAY', 'QUALITY', 'EVIDENCE', 'CERTIFICATION']),
    // A forecast that cannot name what produced it is a prediction no one can reproduce or attribute, which
    // for an AI-derived claim is the whole of its evidential value. The package's own header makes model
    // retention part of its AI-governance contract.
    modelId: identifier,
    modelVersion: identifier,
    predictedValue: z.number().finite(),
    // Bounded 0-1 by the engine and by the column. See this file's header for the contrast with Batch I.
    confidence: z.number().min(0).max(1),
    rationale: requiredText,
    reviewStatus: z.enum(['NOT_REVIEWED', 'ACCEPTED', 'REJECTED']),
    generatedAt: instant,
  })
  .strict();

/**
 * The schema version stored beside every Batch K row.
 *
 * One for all six, because they are activated together.
 */
export const BATCH_K_SCHEMA_VERSION = 1;

export type BatchKAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_K_AGGREGATES: readonly BatchKAggregateContract[] = Object.freeze([
  { collection: 'executionAssuranceIndices', table: 'execution_assurance_indices', engine: '51', schema: executionAssuranceIndexSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
  { collection: 'settlementAssuranceIndices', table: 'settlement_assurance_indices', engine: '52', schema: settlementAssuranceIndexSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
  { collection: 'kpiDefinitions', table: 'kpi_definitions', engine: '53', schema: kpiDefinitionSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
  { collection: 'kpiValues', table: 'kpi_values', engine: '53', schema: kpiValueSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
  { collection: 'dashboardSnapshots', table: 'dashboard_snapshots', engine: '54', schema: dashboardSnapshotSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
  { collection: 'executionForecasts', table: 'execution_forecasts', engine: '55', schema: executionForecastSchema, schemaVersion: BATCH_K_SCHEMA_VERSION },
]);

export const BATCH_K_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_K_AGGREGATES.map((aggregate) => aggregate.collection),
);

export const BATCH_K_TABLES: readonly string[] = Object.freeze(
  BATCH_K_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Four of six. An assurance index, a KPI value and a dashboard snapshot are each a value at a moment:
 * recomputing produces a new row, and no engine passes any of them to `replace`. The other two transition —
 * a KPI definition is retired and a forecast is reviewed — and until `202608110014` a blanket append-only
 * trigger refused both.
 */
export const BATCH_K_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'dashboardSnapshots',
  'executionAssuranceIndices',
  'kpiValues',
  'settlementAssuranceIndices',
]);

/** The contract for a collection, or `undefined` when Batch K does not own it. */
export function batchKContract(collection: string): BatchKAggregateContract | undefined {
  return BATCH_K_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}
