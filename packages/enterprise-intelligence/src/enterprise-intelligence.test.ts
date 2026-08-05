import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  EnterpriseKpiEngine,
  ExecutionAssuranceIndexEngine,
  ExecutiveDashboardEngine,
  PredictiveExecutionIntelligenceEngine,
  SettlementAssuranceIndexEngine,
} from './index';

const c = {
  actorUserId: 'executive',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 51 Execution Assurance Index', () => {
  it('averages weighted factors but forces the score to zero when any mandatory gate fails', async () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutionAssuranceIndexEngine(s);
    await expect(await e.compute(c, { scopeId: 'wi', factors: { quality: 150 }, mandatoryGates: [] })).rejects.toThrow('MUST_BE_BETWEEN_0_AND_100');
    const clean = await e.compute(c, {
      scopeId: 'wi',
      factors: { quality: 90, timeliness: 80 },
      mandatoryGates: [{ gate: 'QUALITY_GATE', passed: true }],
    });
    expect(clean).toMatchObject({ score: 85, overridden: false, failedGates: [] });
    const overridden = await e.compute(c, {
      scopeId: 'wi',
      factors: { quality: 95, timeliness: 95 },
      mandatoryGates: [{ gate: 'QUALITY_GATE', passed: false }],
    });
    expect(overridden).toMatchObject({ score: 0, overridden: true, failedGates: ['QUALITY_GATE'] });
    expect((await e.latest(c, 'wi'))?.id).toBe(overridden.id);
  });
});

describe('Engine 52 Settlement Assurance Index', () => {
  it('forces the score to zero whenever an active dispute hold is reported', async () => {
    const s = new InMemoryTrustStore();
    const e = new SettlementAssuranceIndexEngine(s);
    const clean = await e.compute(c, { scopeId: 'm', factors: { eligibility: 100, funding: 100 }, activeHold: false });
    expect(clean).toMatchObject({ score: 100, overridden: false });
    const held = await e.compute(c, { scopeId: 'm', factors: { eligibility: 100, funding: 100 }, activeHold: true });
    expect(held).toMatchObject({ score: 0, overridden: true });
  });
});

describe('Engine 53 Enterprise KPI', () => {
  it('computes on-track status per direction and blocks recording against a retired definition', async () => {
    const s = new InMemoryTrustStore();
    const e = new EnterpriseKpiEngine(s);
    const onTimeDelivery = await e.define(c, {
      kind: 'EXECUTION',
      name: 'On-time delivery rate',
      targetValue: 90,
      direction: 'HIGHER_IS_BETTER',
      unit: 'percent',
    });
    const defectRate = await e.define(c, {
      kind: 'RISK',
      name: 'Defect rate',
      targetValue: 5,
      direction: 'LOWER_IS_BETTER',
      unit: 'percent',
    });
    expect((await e.recordValue(c, { kpiDefinitionId: onTimeDelivery.id, scopeId: 'portfolio', actualValue: 92 })).onTrack).toBe(
      true,
    );
    expect((await e.recordValue(c, { kpiDefinitionId: defectRate.id, scopeId: 'portfolio', actualValue: 8 })).onTrack).toBe(
      false,
    );
    expect((await e.latest(c, { kpiDefinitionId: onTimeDelivery.id, scopeId: 'portfolio' }))?.actualValue).toBe(92);
    await e.retire(c, onTimeDelivery.id);
    await expect(await e.recordValue(c, { kpiDefinitionId: onTimeDelivery.id, scopeId: 'portfolio', actualValue: 95 })).rejects.toThrow(
      'KPI_DEFINITION_NOT_ACTIVE',
    );
  });
});

describe('Engine 54 Executive Dashboard', () => {
  it('filters widgets to only those visible to the requested role', async () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutiveDashboardEngine(s);
    const snapshot = await e.compose(c, {
      role: 'FINANCE_DIRECTOR',
      widgets: [
        { key: 'execution-index', label: 'Execution Assurance Index', value: 92, allowedRoles: ['EXECUTIVE', 'FINANCE_DIRECTOR'] },
        { key: 'ops-detail', label: 'Field Operations Detail', value: 'active', allowedRoles: ['OPERATIONS_LEAD'] },
      ],
    });
    expect(snapshot.widgets.map((w) => w.key)).toEqual(['execution-index']);
    expect((await e.latest(c, 'FINANCE_DIRECTOR'))?.id).toBe(snapshot.id);
    expect(await e.latest(c, 'OPERATIONS_LEAD')).toBeUndefined();
  });
});

describe('Engine 55 Predictive Execution Intelligence', () => {
  it('requires a governed gateway, validates confidence and starts every forecast unreviewed', async () => {
    const s = new InMemoryTrustStore();
    const noGateway = new PredictiveExecutionIntelligenceEngine(s);
    await expect(await noGateway.forecast(c, { scopeId: 'm', forecastType: 'DELAY', signals: { progress: 60 } })).rejects.toThrow(
      'GOVERNED_FORECAST_GATEWAY_REQUIRED',
    );
    const invalidGateway = new PredictiveExecutionIntelligenceEngine(s, {
      async forecast() {
        return { modelId: 'm', modelVersion: '1', predictedValue: 10, confidence: 1.5, rationale: 'bad confidence' };
      },
    });
    await expect(
      await invalidGateway.forecast(c, { scopeId: 'm', forecastType: 'DELAY', signals: { progress: 60 } }),
    ).rejects.toThrow('INVALID_CONFIDENCE');
    const e = new PredictiveExecutionIntelligenceEngine(s, {
      async forecast(input) {
        return { modelId: 'deterministic', modelVersion: '1', predictedValue: 3, confidence: 0.7, rationale: `forecast for ${input.forecastType}` };
      },
    });
    const forecast = await e.forecast(c, { scopeId: 'm', forecastType: 'DELAY', signals: { progress: 60 } });
    expect(forecast.reviewStatus).toBe('NOT_REVIEWED');
    expect((await e.review(c, { id: forecast.id, decision: 'ACCEPTED' })).reviewStatus).toBe('ACCEPTED');
    await expect(await e.review(c, { id: forecast.id, decision: 'REJECTED' })).rejects.toThrow('FORECAST_ALREADY_REVIEWED');
    expect((await e.latest(c, { scopeId: 'm', forecastType: 'DELAY' }))?.id).toBe(forecast.id);
  });
});
