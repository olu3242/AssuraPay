import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  EnterpriseKpiEngine,
  ExecutionAssuranceIndexEngine,
  ExecutiveDashboardEngine,
  PredictiveExecutionIntelligenceEngine,
  SettlementAssuranceIndexEngine,
} from './index';

describe('e2e Batch 11 execution and settlement signals into a role-filtered executive dashboard', () => {
  it('composes indices, a KPI and an unreviewed forecast into widgets visible only to the requesting role', async () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'executive',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const executionIndex = new ExecutionAssuranceIndexEngine(s).compute(c, {
      scopeId: 'erection-milestone',
      factors: { quality: 92, timeliness: 88 },
      mandatoryGates: [{ gate: 'QUALITY_GATE', passed: true }],
    });
    const settlementIndex = new SettlementAssuranceIndexEngine(s).compute(c, {
      scopeId: 'erection-milestone',
      factors: { eligibility: 100, funding: 100 },
      activeHold: false,
    });

    const kpis = new EnterpriseKpiEngine(s);
    const onTimeDelivery = kpis.define(c, {
      kind: 'EXECUTION',
      name: 'On-time delivery rate',
      targetValue: 90,
      direction: 'HIGHER_IS_BETTER',
      unit: 'percent',
    });
    const kpiValue = kpis.recordValue(c, { kpiDefinitionId: onTimeDelivery.id, scopeId: 'portfolio', actualValue: 94 });

    const forecasts = new PredictiveExecutionIntelligenceEngine(s, {
      async forecast(input) {
        return {
          modelId: 'deterministic-forecast',
          modelVersion: '1',
          predictedValue: 2,
          confidence: 0.65,
          rationale: `${input.forecastType} forecast from ${Object.keys(input.signals).length} signal(s)`,
        };
      },
    });
    const forecast = await forecasts.forecast(c, {
      scopeId: 'erection-milestone',
      forecastType: 'DELAY',
      signals: { progress: 88, qualityGateScore: executionIndex.score },
    });
    expect(forecast.reviewStatus).toBe('NOT_REVIEWED');

    const dashboards = new ExecutiveDashboardEngine(s);
    const snapshot = dashboards.compose(c, {
      role: 'EXECUTIVE',
      widgets: [
        { key: 'execution-index', label: 'Execution Assurance Index', value: executionIndex.score, allowedRoles: ['EXECUTIVE'] },
        { key: 'settlement-index', label: 'Settlement Assurance Index', value: settlementIndex.score, allowedRoles: ['EXECUTIVE'] },
        { key: 'on-time-delivery', label: 'On-time delivery rate', value: kpiValue.actualValue, allowedRoles: ['EXECUTIVE'] },
        { key: 'delay-forecast', label: 'Delay forecast (unreviewed)', value: forecast.predictedValue, allowedRoles: ['OPERATIONS_LEAD'] },
      ],
    });
    expect(snapshot.widgets.map((w) => w.key)).toEqual(['execution-index', 'settlement-index', 'on-time-delivery']);
  });
});
