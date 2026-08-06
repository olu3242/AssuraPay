import { beforeEach, describe, expect, it } from 'vitest';
import { FileAssuraStore } from '@assurapay/database';
import { AssuraPayService } from './assurapay-service';

async function makeStore() {
  const store = await FileAssuraStore.load();
  await store.upsertWorkspaces([]);
  await store.upsertOrganizations([]);
  await store.upsertContracts([]);
  await store.upsertBlueprints([]);
  await store.upsertMilestones([]);
  await store.upsertDodPackages([]);
  await store.upsertEvidence([]);
  await store.upsertValidation([]);
  await store.upsertAcceptance([]);
  await store.upsertCertificates([]);
  await store.upsertPaymentEligibility([]);
  await store.upsertSettlementCases([]);
  await store.upsertFinancialEntitlements([]);
  await store.upsertInvoices([]);
  await store.upsertFundingCommitments([]);
  await store.upsertReleaseRequests([]);
  await store.upsertPaymentInstructions([]);
  await store.upsertLedgerEntries([]);
  await store.upsertAssuranceScores([]);
  await store.upsertCheckpoints([]);
  await store.upsertRebuildJobs([]);
  await store.upsertKPIDefinitions([]);
  await store.upsertKPIResults([]);
  await store.upsertKPIProfiles([]);
  await store.upsertExecutiveDashboards([]);
  await store.upsertDashboardSnapshots([]);
  await store.upsertGovernedAiReviews([]);
  return store;
}

describe('Batch 4 extensions', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    const store = await makeStore();
    service = new AssuraPayService(store);
  });

  it('replays projections idempotently and records checkpoints', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');

    const checkpoint = await service.createProjectionCheckpoint({ tenantId: 'tenant-a', workspaceId: workspace.id, projectionType: 'portfolio', status: 'RUNNING' });
    const event = {
      id: 'event-1',
      type: 'contract.approved',
      aggregateId: contract.id,
      tenantId: 'tenant-a',
      workspaceId: workspace.id,
      occurredAt: new Date().toISOString(),
      version: 1,
    };

    const projection = await service.consumeProjectionEvent(event as any);
    await service.consumeProjectionEvent(event as any);
    const rebuilt = await service.rebuildProjection({ tenantId: 'tenant-a', workspaceId: workspace.id, projectionType: 'portfolio' });

    expect(projection.id).toBeDefined();
    expect(rebuilt.projections.length).toBe(1);
    expect(checkpoint.projectionType).toBe('portfolio');
  });

  it('validates KPI formulas and preserves versioning', async () => {
    await expect(service.createKPIDefinition({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      kpiKey: 'bad-formula',
      name: 'Bad Formula',
      domain: 'Execution',
      aggregationType: 'FORMULA',
      formulaExpression: 'SELECT * FROM x',
      unit: '%',
      direction: 'HIGHER_IS_BETTER',
      status: 'DRAFT',
    })).rejects.toThrow('Invalid formula');

    const definition = await service.createKPIDefinition({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      kpiKey: 'on-time-milestone-rate',
      name: 'On-time milestone rate',
      domain: 'Execution',
      aggregationType: 'PERCENTAGE',
      formulaExpression: 'numerator/denominator',
      unit: '%',
      direction: 'HIGHER_IS_BETTER',
      status: 'DRAFT',
    });
    const published = await service.publishKPIDefinition(definition.id, 'owner-a');
    const result = await service.calculateKPIResult({
      kpiDefinitionId: published.id,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      scopeType: 'contract',
      scopeId: 'contract-1',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      numerator: 4,
      denominator: 5,
      resultUnit: '%',
    });

    expect(published.version).toBe(1);
    expect(result.resultValue).toBe(80);
  });

  it('marks forecasts stale and deduplicates alerts', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');
    const forecast = await service.createExecutionForecast({
      tenantId: 'tenant-a',
      workspaceId: workspace.id,
      forecastType: 'milestone-delay',
      scopeType: 'contract',
      scopeId: contract.id,
      outcome: 'medium-risk',
      confidence: 0.85,
      explanation: 'Based on current progress',
      recommendedActions: ['Review blockers'],
      modelVersion: 'v1',
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      reviewStatus: 'PENDING',
    });

    const stale = await service.markForecastsStale({ tenantId: 'tenant-a', workspaceId: workspace.id, reason: 'material-change' });
    expect(stale.some((entry) => entry.id === forecast.id && entry.reviewStatus === 'STALE')).toBe(true);

    const alerts = await service.createAlertInstance({
      tenantId: 'tenant-a',
      workspaceId: workspace.id,
      alertKey: 'milestone-delay-risk',
      severity: 'warning',
      title: 'Milestone delay risk',
      detail: 'Milestone risk is rising',
      assignment: 'ops',
      dedupeKey: 'milestone-delay-risk',
    });
    const duplicate = await service.createAlertInstance({
      tenantId: 'tenant-a',
      workspaceId: workspace.id,
      alertKey: 'milestone-delay-risk',
      severity: 'warning',
      title: 'Milestone delay risk',
      detail: 'Milestone risk is rising',
      assignment: 'ops',
      dedupeKey: 'milestone-delay-risk',
    });

    expect(alerts.id).toBeDefined();
    expect(duplicate.id).toBe(alerts.id);
  });

  it('creates masked reports and exports with security metadata', async () => {
    const report = await service.createReportDefinition({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      reportKey: 'portfolio',
      name: 'Portfolio',
      classification: 'internal',
      allowedRoles: ['executive'],
      fieldMasking: ['amount'],
      exportPolicy: 'restricted',
    });
    const run = await service.runReport({
      reportDefinitionId: report.id,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      actorId: 'executive',
      recordPermissions: ['portfolio:export'],
      maskedFields: ['amount'],
    });

    expect(run.maskedFields).toContain('amount');
    expect(run.exportPolicy).toBe('restricted');
  });

  it('enforces checkpoint uniqueness and monotonic event sequences', async () => {
    const checkpoint = await service.createProjectionCheckpoint({ tenantId: 'tenant-a', workspaceId: 'workspace-a', projectionName: 'portfolio', consumerName: 'worker-a' });
    await service.updateProjectionCheckpoint(checkpoint.id, { tenantId: 'tenant-a', workspaceId: 'workspace-a', lastEventId: 'event-2', lastEventSequence: 2 });
    await expect(service.updateProjectionCheckpoint(checkpoint.id, { tenantId: 'tenant-a', workspaceId: 'workspace-a', lastEventId: 'event-1', lastEventSequence: 1 })).rejects.toThrow('backwards');
    await expect(service.createProjectionCheckpoint({ tenantId: 'tenant-a', workspaceId: 'workspace-a', projectionName: 'portfolio', consumerName: 'worker-a' })).rejects.toThrow('already exists');
  });

  it('preserves forecast inputs while recording outcomes', async () => {
    const forecast = await service.createExecutionForecast({ tenantId: 'tenant-a', workspaceId: 'workspace-a', forecastType: 'delay', modelId: 'delay-model', modelVersion: 'v1', featureSnapshot: { progress: 40 }, predictedValue: 'late', confidenceScore: 0.8, explanation: 'Low progress', recommendedActions: [], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const outcome = await service.recordExecutionForecastOutcome(forecast.id, { tenantId: 'tenant-a', workspaceId: 'workspace-a', actualOutcome: 'on-time', recordedBy: 'reviewer-a' });
    const reloaded = await service.getExecutionForecast(forecast.id, 'tenant-a', 'workspace-a');
    expect(outcome.actualOutcome).toBe('on-time');
    expect(reloaded?.predictedValue).toBe('late');
    expect(reloaded?.featureSnapshot).toEqual({ progress: 40 });
  });

  it('generates deterministic report hashes and preserves masking controls', async () => {
    const report = await service.createReportDefinition({ tenantId: 'tenant-a', workspaceId: 'workspace-a', reportKey: 'portfolio', name: 'Portfolio', classification: 'internal', allowedRoles: ['executive'], fieldMasking: ['amount'], exportPolicy: 'restricted' });
    const input = { reportDefinitionId: report.id, tenantId: 'tenant-a', workspaceId: 'workspace-a', actorId: 'executive', recordPermissions: ['portfolio:export'], maskedFields: ['amount'], records: [{ name: 'A', amount: 100 }] };
    const first = await service.runReport(input);
    const second = await service.runReport(input);
    expect(first.maskedFields).toContain('amount');
    expect(first.outputHash).toBe(second.outputHash);
  });

  it('rejects unsafe formulas and treats divide by zero as not calculable', async () => {
    expect(service.validateKpiFormula('SUM(value)')).toMatchObject({ valid: true });
    expect(service.validateKpiFormula('value.constructor')).toMatchObject({ valid: false });
    const simulation = await service.simulateKpiDefinition({ formulaExpression: 'numerator/denominator', numerator: 1, denominator: 0 });
    expect(simulation.status).toBe('NOT_CALCULABLE');
  });

  it('normalizes missing Batch 4 arrays in legacy snapshots', async () => {
    const legacyStore = await FileAssuraStore.load();
    await legacyStore.setSnapshot({ workspaces: [{ id: 'kept' }] } as any);
    expect((await legacyStore.getSnapshot()).workspaces).toEqual([{ id: 'kept' }]);
    expect((await legacyStore.getSnapshot()).projectionCheckpoints).toEqual([]);
    expect((await legacyStore.getSnapshot()).executionForecasts).toEqual([]);
    expect((await legacyStore.getSnapshot()).reportRuns).toEqual([]);
  });
});
