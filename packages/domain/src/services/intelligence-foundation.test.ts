import { beforeEach, describe, expect, it } from 'vitest';
import { FileAssuraStore } from '@assurapay/database';
import { AssuraPayService } from './assurapay-service';

async function createService() {
  const store = await FileAssuraStore.load();
  await store.setSnapshot({
    workspaces: [],
    organizations: [],
    contracts: [],
    blueprints: [],
    milestones: [],
    dodPackages: [],
    evidenceItems: [],
    validationResults: [],
    acceptanceDecisions: [],
    certificates: [],
    paymentEligibility: [],
    settlementCases: [],
    financialEntitlements: [],
    invoices: [],
    fundingCommitments: [],
    releaseRequests: [],
    paymentInstructions: [],
    ledgerEntries: [],
    checkpoints: [],
    rebuildJobs: [],
    kpiDefinitions: [],
    kpiResults: [],
    kpiProfiles: [],
    dashboardSnapshots: [],
  });
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
  await store.upsertCheckpoints([]);
  await store.upsertRebuildJobs([]);
  await store.upsertKPIDefinitions([]);
  await store.upsertKPIResults([]);
  await store.upsertKPIProfiles([]);
  await store.upsertDashboardSnapshots([]);
  return new AssuraPayService(store);
}

describe('Intelligence foundation', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    service = await createService();
  });

  it('publishes a KPI definition and calculates a versioned result', async () => {
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

    expect(published.status).toBe('PUBLISHED');
    expect(result.resultValue).toBe(80);
    expect(result.kpiDefinitionVersion).toBe(1);
  });

  it('creates an executive dashboard snapshot with masked metrics', async () => {
    const snapshot = await service.createDashboardSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      scopeType: 'workspace',
      scopeId: 'workspace-a',
      dashboardName: 'Executive',
      metrics: [
        { key: 'eligibleUnpaidValue', value: 4000000, masked: false },
        { key: 'paymentSuccessRate', value: 0.95, masked: true },
      ],
    });

    expect(snapshot.dashboardName).toBe('Executive');
    expect(snapshot.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'eligibleUnpaidValue' })]));
    expect(snapshot.metrics.find((item: any) => item.key === 'paymentSuccessRate')?.value).toBe('masked');
  });
});
