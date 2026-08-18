import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  dashboardSnapshotSchema,
  dashboardWidgetSchema,
  executionAssuranceIndexSchema,
  executionForecastSchema,
  kpiDefinitionSchema,
  kpiValueIsOnTrack,
  kpiValueSchema,
  mandatoryGateResultSchema,
  settlementAssuranceIndexSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  DashboardSnapshot,
  DashboardWidget,
  ExecutionAssuranceIndex,
  ExecutionForecast,
  KpiDefinition,
  KpiValue,
  MandatoryGateResult,
  SettlementAssuranceIndex,
} from './index';

/**
 * Compile-time proof that this package's Batch K domain types and their canonical Zod schemas describe the
 * same shape, plus the rules those schemas enforce.
 *
 * One invariant is deliberately absent, and it is the only derived field in the batch that a row cannot
 * check. `kpiValue.onTrack` follows from the *definition's* `direction` and `targetValue`, which live on the
 * parent row — and PostgreSQL forbids a subquery inside a CHECK constraint, so the database cannot express it
 * either. `kpiValueIsOnTrack` is exported so the engine and any checker share one comparison rather than two
 * that can drift, and the assertion below exercises it directly. Saying this plainly is better than a
 * constraint that looks like it covers the rule and does not.
 */

export const mandatoryGateResultConforms: SchemaMatchesType<
  z.infer<typeof mandatoryGateResultSchema>,
  MandatoryGateResult
> = true;

export const executionAssuranceIndexConforms: SchemaMatchesType<
  z.infer<typeof executionAssuranceIndexSchema>,
  ExecutionAssuranceIndex
> = true;

export const settlementAssuranceIndexConforms: SchemaMatchesType<
  z.infer<typeof settlementAssuranceIndexSchema>,
  SettlementAssuranceIndex
> = true;

export const kpiDefinitionConforms: SchemaMatchesType<
  z.infer<typeof kpiDefinitionSchema>,
  KpiDefinition
> = true;

export const kpiValueConforms: SchemaMatchesType<z.infer<typeof kpiValueSchema>, KpiValue> = true;

export const dashboardWidgetConforms: SchemaMatchesType<
  z.infer<typeof dashboardWidgetSchema>,
  DashboardWidget
> = true;

export const dashboardSnapshotConforms: SchemaMatchesType<
  z.infer<typeof dashboardSnapshotSchema>,
  DashboardSnapshot
> = true;

export const executionForecastConforms: SchemaMatchesType<
  z.infer<typeof executionForecastSchema>,
  ExecutionForecast
> = true;

const stamp = '2026-08-18T09:00:00.000Z';

const executionIndex = (o: Record<string, unknown> = {}) => ({
  id: 'eai-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  factors: { evidence: 80, schedule: 70 },
  mandatoryGates: [{ gate: 'DEFINITION_OF_DONE', passed: true }],
  score: 75,
  overridden: false,
  failedGates: [],
  computedAt: stamp,
  ...o,
});

const settlementIndex = (o: Record<string, unknown> = {}) => ({
  id: 'sai-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  factors: { funding: 90, entitlement: 80 },
  activeHold: false,
  score: 85,
  overridden: false,
  computedAt: stamp,
  ...o,
});

const definition = (o: Record<string, unknown> = {}) => ({
  id: 'kpi-1',
  workspaceId: 'ws-1',
  kind: 'EXECUTION' as const,
  name: 'Milestones certified on time',
  targetValue: 90,
  direction: 'HIGHER_IS_BETTER' as const,
  unit: 'percent',
  status: 'ACTIVE' as const,
  createdAt: stamp,
  ...o,
});

const snapshot = (o: Record<string, unknown> = {}) => ({
  id: 'ds-1',
  workspaceId: 'ws-1',
  role: 'FINANCE_DIRECTOR',
  widgets: [
    {
      key: 'net-payable',
      label: 'Net payable',
      value: 5_000_000,
      allowedRoles: ['FINANCE_DIRECTOR'],
    },
  ],
  generatedFor: 'user-1',
  generatedAt: stamp,
  ...o,
});

const forecast = (o: Record<string, unknown> = {}) => ({
  id: 'ef-1',
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  forecastType: 'DELAY' as const,
  modelId: 'deterministic-forecast',
  modelVersion: '1',
  predictedValue: 12,
  confidence: 0.6,
  rationale: 'Deterministic baseline forecast for DELAY derived from 2 signal(s).',
  reviewStatus: 'NOT_REVIEWED' as const,
  generatedAt: stamp,
  ...o,
});

describe('Batch K persisted contracts', () => {
  it('accepts what the engines write', () => {
    expect(executionAssuranceIndexSchema.safeParse(executionIndex()).success).toBe(true);
    expect(settlementAssuranceIndexSchema.safeParse(settlementIndex()).success).toBe(true);
    expect(kpiDefinitionSchema.safeParse(definition()).success).toBe(true);
    expect(
      kpiValueSchema.safeParse({
        id: 'kv-1',
        workspaceId: 'ws-1',
        kpiDefinitionId: 'kpi-1',
        scopeId: 'scope-1',
        actualValue: 95,
        onTrack: true,
        recordedAt: stamp,
      }).success,
    ).toBe(true);
    expect(dashboardSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(executionForecastSchema.safeParse(forecast()).success).toBe(true);
  });

  it('refuses an index that scores nothing', () => {
    // `averageOf` returns 0 for an empty set, so an index with no factors scores zero and shows the worst
    // possible reading as though something had been measured.
    expect(executionAssuranceIndexSchema.safeParse(executionIndex({ factors: {} })).success).toBe(false);
    expect(settlementAssuranceIndexSchema.safeParse(settlementIndex({ factors: {} })).success).toBe(false);
  });

  it('refuses a factor outside the scale', () => {
    expect(
      executionAssuranceIndexSchema.safeParse(executionIndex({ factors: { evidence: 140 } })).success,
    ).toBe(false);
  });

  it('refuses a green banner over a failed mandatory gate', () => {
    // The row that matters. `compute` sets score 0 and overridden true whenever a gate failed; a row with a
    // high score beside a failed gate is a reading a viewer acts on and should not.
    const lying = executionIndex({
      mandatoryGates: [{ gate: 'DEFINITION_OF_DONE', passed: false }],
      failedGates: ['DEFINITION_OF_DONE'],
      overridden: true,
      score: 75,
    });
    expect(executionAssuranceIndexSchema.safeParse(lying).success).toBe(false);

    // And with `overridden` also lowered, so only the gate list disagrees with the flag.
    const quiet = executionIndex({
      mandatoryGates: [{ gate: 'DEFINITION_OF_DONE', passed: false }],
      failedGates: ['DEFINITION_OF_DONE'],
      overridden: false,
      score: 0,
    });
    expect(executionAssuranceIndexSchema.safeParse(quiet).success).toBe(false);
  });

  it('refuses a failed-gate list that does not match its own gates', () => {
    expect(
      executionAssuranceIndexSchema.safeParse(
        executionIndex({ failedGates: ['SOMETHING_ELSE'], overridden: true, score: 0 }),
      ).success,
    ).toBe(false);
    // A gate that failed but is not listed, which understates the failure.
    expect(
      executionAssuranceIndexSchema.safeParse(
        executionIndex({ mandatoryGates: [{ gate: 'EVIDENCE', passed: false }] }),
      ).success,
    ).toBe(false);
  });

  it('refuses a healthy settlement index under an active hold', () => {
    // An active hold is CLAUDE.md's second hard constraint holding. An index reading 85 beside it shows the
    // constraint satisfied when it is not.
    expect(
      settlementAssuranceIndexSchema.safeParse(
        settlementIndex({ activeHold: true, overridden: true, score: 85 }),
      ).success,
    ).toBe(false);
    // And the flag disagreeing with the hold.
    expect(
      settlementAssuranceIndexSchema.safeParse(settlementIndex({ activeHold: true, overridden: false }))
        .success,
    ).toBe(false);
  });

  it('refuses a snapshot holding a widget its role may not see', () => {
    // `compose` filters to the role's allow-list. A stored widget outside it is a figure the viewer was never
    // entitled to, materialised and readable from the snapshot rather than from the engine that filtered it.
    expect(
      dashboardSnapshotSchema.safeParse(
        snapshot({
          widgets: [
            { key: 'payroll', label: 'Payroll', value: 1, allowedRoles: ['CHIEF_EXECUTIVE'] },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a forecast with an out-of-scale confidence or no model', () => {
    expect(executionForecastSchema.safeParse(forecast({ confidence: 1.4 })).success).toBe(false);
    expect(executionForecastSchema.safeParse(forecast({ modelId: '' })).success).toBe(false);
    // A blank rationale is a forecast with nothing behind it, which for an advisory AI output is the whole of
    // its reviewable content.
    expect(executionForecastSchema.safeParse(forecast({ rationale: '   ' })).success).toBe(false);
  });

  it('agrees with the engine on whether a value is on track, in both directions', () => {
    // The one derived field no row can check: the target lives on the parent, so this comparison is shared
    // rather than duplicated.
    expect(kpiValueIsOnTrack({ direction: 'HIGHER_IS_BETTER', targetValue: 90 }, 95)).toBe(true);
    expect(kpiValueIsOnTrack({ direction: 'HIGHER_IS_BETTER', targetValue: 90 }, 90)).toBe(true);
    expect(kpiValueIsOnTrack({ direction: 'HIGHER_IS_BETTER', targetValue: 90 }, 89)).toBe(false);
    expect(kpiValueIsOnTrack({ direction: 'LOWER_IS_BETTER', targetValue: 5 }, 4)).toBe(true);
    expect(kpiValueIsOnTrack({ direction: 'LOWER_IS_BETTER', targetValue: 5 }, 5)).toBe(true);
    expect(kpiValueIsOnTrack({ direction: 'LOWER_IS_BETTER', targetValue: 5 }, 6)).toBe(false);
  });

  it('refuses an unknown field on every aggregate', () => {
    // `.strict()` throughout. A field the schema does not know is a field no reader will read, and accepting
    // it silently is how a payload drifts away from the columns that hold it.
    for (const [schema, value] of [
      [executionAssuranceIndexSchema, executionIndex()],
      [settlementAssuranceIndexSchema, settlementIndex()],
      [kpiDefinitionSchema, definition()],
      [dashboardSnapshotSchema, snapshot()],
      [executionForecastSchema, forecast()],
    ] as const) {
      expect(schema.safeParse({ ...value, surprise: true }).success).toBe(false);
    }
  });
});
