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

// Engine 51 — Execution Assurance Index
//
// Every index in this package is a governed READ MODEL: it never writes to, or
// reads directly from, another package's store. Every input factor and gate
// result is supplied by the caller, who already holds the relevant engines
// (see `apps/web/lib/trust-app.ts`) — this package only composes and scores
// what it is given, and never re-derives domain state on its own.

export type MandatoryGateResult = { gate: string; passed: boolean };

export type ExecutionAssuranceIndex = {
  id: string;
  workspaceId: string;
  scopeId: string;
  factors: Record<string, number>;
  mandatoryGates: MandatoryGateResult[];
  score: number;
  overridden: boolean;
  failedGates: string[];
  computedAt: string;
};

export class ExecutionAssuranceIndexEngine {
  constructor(private readonly store: TrustPersistence) {}

  compute(
    context: RequestContext,
    input: { scopeId: string; factors: Record<string, number>; mandatoryGates: MandatoryGateResult[] },
  ) {
    for (const [field, value] of Object.entries(input.factors)) requireScoreRange(value, field.toUpperCase());
    const failedGates = input.mandatoryGates.filter((x) => !x.passed).map((x) => x.gate);
    const overridden = failedGates.length > 0;
    const index: ExecutionAssuranceIndex = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      score: overridden ? 0 : Math.round(averageOf(Object.values(input.factors))),
      overridden,
      failedGates,
      computedAt: now(),
    };
    this.store.append('executionAssuranceIndices', index);
    emit(this.store, context, 'ExecutionAssuranceIndexComputed', 'ExecutionAssuranceIndex', index.id, {
      scopeId: index.scopeId,
      score: index.score,
      overridden: index.overridden,
    });
    return index;
  }

  latest(context: RequestContext, scopeId: string) {
    const workspaceId = ws(context);
    const records = this.store
      .list<ExecutionAssuranceIndex>('executionAssuranceIndices')
      .filter((x) => x.workspaceId === workspaceId && x.scopeId === scopeId);
    return records[records.length - 1];
  }
}

// Engine 52 — Settlement Assurance Index

export type SettlementAssuranceIndex = {
  id: string;
  workspaceId: string;
  scopeId: string;
  factors: Record<string, number>;
  activeHold: boolean;
  score: number;
  overridden: boolean;
  computedAt: string;
};

export class SettlementAssuranceIndexEngine {
  constructor(private readonly store: TrustPersistence) {}

  compute(context: RequestContext, input: { scopeId: string; factors: Record<string, number>; activeHold: boolean }) {
    for (const [field, value] of Object.entries(input.factors)) requireScoreRange(value, field.toUpperCase());
    const index: SettlementAssuranceIndex = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      score: input.activeHold ? 0 : Math.round(averageOf(Object.values(input.factors))),
      overridden: input.activeHold,
      computedAt: now(),
    };
    this.store.append('settlementAssuranceIndices', index);
    emit(this.store, context, 'SettlementAssuranceIndexComputed', 'SettlementAssuranceIndex', index.id, {
      scopeId: index.scopeId,
      score: index.score,
      overridden: index.overridden,
    });
    return index;
  }

  latest(context: RequestContext, scopeId: string) {
    const workspaceId = ws(context);
    const records = this.store
      .list<SettlementAssuranceIndex>('settlementAssuranceIndices')
      .filter((x) => x.workspaceId === workspaceId && x.scopeId === scopeId);
    return records[records.length - 1];
  }
}

// Engine 53 — Enterprise KPI

export type KpiDefinition = {
  id: string;
  workspaceId: string;
  kind: 'PORTFOLIO' | 'EXECUTION' | 'EVIDENCE' | 'RISK' | 'PAYMENT' | 'SETTLEMENT';
  name: string;
  targetValue: number;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  unit: string;
  status: 'ACTIVE' | 'RETIRED';
  createdAt: string;
};

export type KpiValue = {
  id: string;
  workspaceId: string;
  kpiDefinitionId: string;
  scopeId: string;
  actualValue: number;
  onTrack: boolean;
  recordedAt: string;
};

export class EnterpriseKpiEngine {
  constructor(private readonly store: TrustPersistence) {}

  define(
    context: RequestContext,
    input: { kind: KpiDefinition['kind']; name: string; targetValue: number; direction: KpiDefinition['direction']; unit: string },
  ) {
    if (!input.name.trim()) throw new Error('NAME_REQUIRED');
    const definition: KpiDefinition = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'ACTIVE',
      createdAt: now(),
    };
    this.store.append('kpiDefinitions', definition);
    return definition;
  }

  retire(context: RequestContext, id: string) {
    const definition = get<KpiDefinition>(this.store, 'kpiDefinitions', context, id);
    if (definition.status !== 'ACTIVE') throw new Error('KPI_DEFINITION_NOT_ACTIVE');
    const retired: KpiDefinition = { ...definition, status: 'RETIRED' };
    this.store.replace('kpiDefinitions', retired);
    return retired;
  }

  recordValue(context: RequestContext, input: { kpiDefinitionId: string; scopeId: string; actualValue: number }) {
    const definition = get<KpiDefinition>(this.store, 'kpiDefinitions', context, input.kpiDefinitionId);
    if (definition.status !== 'ACTIVE') throw new Error('KPI_DEFINITION_NOT_ACTIVE');
    if (!Number.isFinite(input.actualValue)) throw new Error('INVALID_ACTUAL_VALUE');
    const onTrack =
      definition.direction === 'HIGHER_IS_BETTER'
        ? input.actualValue >= definition.targetValue
        : input.actualValue <= definition.targetValue;
    const value: KpiValue = { id: randomUUID(), workspaceId: ws(context), ...input, onTrack, recordedAt: now() };
    this.store.append('kpiValues', value);
    emit(this.store, context, 'KpiValueRecorded', 'KpiValue', value.id, {
      kpiDefinitionId: value.kpiDefinitionId,
      onTrack: value.onTrack,
    });
    return value;
  }

  latest(context: RequestContext, input: { kpiDefinitionId: string; scopeId: string }) {
    const workspaceId = ws(context);
    const values = this.store
      .list<KpiValue>('kpiValues')
      .filter(
        (x) => x.workspaceId === workspaceId && x.kpiDefinitionId === input.kpiDefinitionId && x.scopeId === input.scopeId,
      );
    return values[values.length - 1];
  }
}

// Engine 54 — Executive Dashboard

export type DashboardWidget = { key: string; label: string; value: number | string; allowedRoles: string[] };

export type DashboardSnapshot = {
  id: string;
  workspaceId: string;
  role: string;
  widgets: DashboardWidget[];
  generatedFor: string;
  generatedAt: string;
};

export class ExecutiveDashboardEngine {
  constructor(private readonly store: TrustPersistence) {}

  compose(context: RequestContext, input: { role: string; widgets: DashboardWidget[] }) {
    if (!input.role.trim()) throw new Error('ROLE_REQUIRED');
    const visible = input.widgets.filter((w) => w.allowedRoles.includes(input.role));
    const snapshot: DashboardSnapshot = {
      id: randomUUID(),
      workspaceId: ws(context),
      role: input.role,
      widgets: visible,
      generatedFor: context.actorUserId,
      generatedAt: now(),
    };
    this.store.append('dashboardSnapshots', snapshot);
    emit(this.store, context, 'DashboardSnapshotGenerated', 'DashboardSnapshot', snapshot.id, {
      role: snapshot.role,
      widgetCount: snapshot.widgets.length,
    });
    return snapshot;
  }

  latest(context: RequestContext, role: string) {
    const workspaceId = ws(context);
    const snapshots = this.store
      .list<DashboardSnapshot>('dashboardSnapshots')
      .filter((x) => x.workspaceId === workspaceId && x.role === role);
    return snapshots[snapshots.length - 1];
  }
}

// Engine 55 — Predictive Execution Intelligence
//
// AI governance: forecasts are advisory only. `forecast` can call a model only
// through `ForecastGateway`; model id/version and confidence are always
// retained. A forecast can never auto-decide anything — it starts
// `NOT_REVIEWED` and a human must explicitly accept or reject it, mirroring the
// same AI-governance shape already established for Engine 16 (AI Contract
// Analysis) in `packages/agreement-intelligence`.

export interface ForecastGateway {
  forecast(input: {
    scopeId: string;
    forecastType: ExecutionForecast['forecastType'];
    signals: Record<string, number>;
  }): Promise<{ modelId: string; modelVersion: string; predictedValue: number; confidence: number; rationale: string }>;
}

export type ExecutionForecast = {
  id: string;
  workspaceId: string;
  scopeId: string;
  forecastType: 'DELAY' | 'QUALITY' | 'EVIDENCE' | 'CERTIFICATION';
  modelId: string;
  modelVersion: string;
  predictedValue: number;
  confidence: number;
  rationale: string;
  reviewStatus: 'NOT_REVIEWED' | 'ACCEPTED' | 'REJECTED';
  generatedAt: string;
};

export class PredictiveExecutionIntelligenceEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly gateway?: ForecastGateway,
  ) {}

  async forecast(
    context: RequestContext,
    input: { scopeId: string; forecastType: ExecutionForecast['forecastType']; signals: Record<string, number> },
  ) {
    if (!this.gateway) throw new Error('GOVERNED_FORECAST_GATEWAY_REQUIRED');
    const result = await this.gateway.forecast(input);
    if (result.confidence < 0 || result.confidence > 1) throw new Error('INVALID_CONFIDENCE');
    const forecast: ExecutionForecast = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      ...result,
      reviewStatus: 'NOT_REVIEWED',
      generatedAt: now(),
    };
    this.store.append('executionForecasts', forecast);
    emit(this.store, context, 'ExecutionForecastGenerated', 'ExecutionForecast', forecast.id, {
      scopeId: forecast.scopeId,
      forecastType: forecast.forecastType,
      confidence: forecast.confidence,
    });
    return forecast;
  }

  review(context: RequestContext, input: { id: string; decision: 'ACCEPTED' | 'REJECTED' }) {
    const forecast = get<ExecutionForecast>(this.store, 'executionForecasts', context, input.id);
    if (forecast.reviewStatus !== 'NOT_REVIEWED') throw new Error('FORECAST_ALREADY_REVIEWED');
    const reviewed: ExecutionForecast = { ...forecast, reviewStatus: input.decision };
    this.store.replace('executionForecasts', reviewed);
    emit(this.store, context, 'ExecutionForecastReviewed', 'ExecutionForecast', forecast.id, {
      decision: input.decision,
    });
    return reviewed;
  }

  latest(context: RequestContext, input: { scopeId: string; forecastType: ExecutionForecast['forecastType'] }) {
    const workspaceId = ws(context);
    const forecasts = this.store
      .list<ExecutionForecast>('executionForecasts')
      .filter(
        (x) => x.workspaceId === workspaceId && x.scopeId === input.scopeId && x.forecastType === input.forecastType,
      );
    return forecasts[forecasts.length - 1];
  }
}

// Deterministic adapter for local development and certification only. Production
// deployments must supply a real `ForecastGateway` backed by a governed model.
export const deterministicForecastGateway: ForecastGateway = {
  async forecast(input) {
    const signalAverage = averageOf(Object.values(input.signals));
    return {
      modelId: 'deterministic-forecast',
      modelVersion: '1',
      predictedValue: Math.round(100 - signalAverage),
      confidence: 0.6,
      rationale: `Deterministic baseline forecast for ${input.forecastType} derived from ${Object.keys(input.signals).length} signal(s).`,
    };
  },
};
