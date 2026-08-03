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
  return store;
}

describe('Batch 4 intelligence layer', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    const store = await makeStore();
    service = new AssuraPayService(store);
  });

  it('computes explainable execution and settlement assurance scores', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await service.createDefinitionOfDone({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criteria: ['Evidence'] });
    await service.approveDefinitionOfDone(milestone.id);
    await service.activateMilestone(milestone.id);
    await service.uploadEvidence({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Evidence' });
    await service.validateCriterion({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criterion: 'Evidence', status: 'PASSED' });
    await service.createAcceptanceDecision({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', decision: 'FULL_ACCEPTANCE', decisionMakerId: 'authority-a' });
    const certificate = await service.certifyMilestone(milestone.id);
    const eligibility = await service.assessPaymentEligibility(milestone.id);

    const executionScore = await service.calculateExecutionAssuranceScore(milestone.id);
    expect(executionScore.score).toBeGreaterThan(70);
    expect(executionScore.factors.some((factor) => factor.id === 'certification')).toBe(true);
    expect(executionScore.summary).toContain('Execution assurance');

    const settlementCase = await service.createSettlementCase({ paymentEligibilityId: eligibility.id, workspaceId: workspace.id, tenantId: 'tenant-a', contractId: contract.id, milestoneId: milestone.id });
    await service.calculateFinancialEntitlement({ settlementCaseId: settlementCase.id, paymentEligibilityId: eligibility.id, grossAmountMinor: 5000000, retentionAmountMinor: 250000, taxWithholdingAmountMinor: 250000, penaltyAmountMinor: 100000 });
    await service.createInvoice({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', invoiceNumber: 'INV-001', grossAmountMinor: 4400000, netAmountMinor: 4400000, documentHash: 'doc-hash-1', supplierPartyId: 'supplier-a' });
    await service.createFundingCommitment({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', committedAmountMinor: 4400000, providerId: 'sandbox-provider' });
    const release = await service.createReleaseRequest({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', requestedAmountMinor: 4400000, beneficiaryAccountReferenceId: 'beneficiary-a' });
    await service.createPaymentInstruction({ releaseRequestId: release.id, workspaceId: workspace.id, tenantId: 'tenant-a', providerId: 'sandbox-provider', idempotencyKey: 'payment-1', amountMinor: 4400000 });

    const settlementScore = await service.calculateSettlementAssuranceScore(settlementCase.id);
    expect(settlementScore.score).toBeGreaterThan(70);
    expect(settlementScore.factors.some((factor) => factor.id === 'payment')).toBe(true);
    expect(settlementScore.summary).toContain('Settlement assurance');
  });

  it('builds KPI snapshots and executive dashboards from governed source data', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await service.createDefinitionOfDone({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criteria: ['Evidence'] });
    await service.approveDefinitionOfDone(milestone.id);
    await service.activateMilestone(milestone.id);
    await service.uploadEvidence({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Evidence' });
    await service.validateCriterion({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criterion: 'Evidence', status: 'PASSED' });
    await service.createAcceptanceDecision({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', decision: 'FULL_ACCEPTANCE', decisionMakerId: 'authority-a' });
    await service.certifyMilestone(milestone.id);
    await service.assessPaymentEligibility(milestone.id);

    const kpis = await service.generateKpiSnapshot({ tenantId: 'tenant-a', workspaceId: workspace.id });
    expect(kpis.length).toBeGreaterThan(0);
    expect(kpis.some((kpi) => kpi.id === 'execution-assurance')).toBe(true);

    const dashboard = await service.buildExecutiveDashboard({ tenantId: 'tenant-a', workspaceId: workspace.id, role: 'executive' });
    expect(dashboard.summary.totalMilestones).toBeGreaterThan(0);
    expect(dashboard.kpis.some((kpi) => kpi.id === 'execution-assurance')).toBe(true);
    expect(dashboard.alerts.length).toBeGreaterThanOrEqual(0);
  });

  it('creates governed AI review controls without bypassing policy', async () => {
    const review = await service.createGovernedAiReview({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-1',
      subject: 'dashboard',
      requestedBy: 'analyst-a',
      summary: 'Draft dashboard insight',
      approvedBy: 'auditor-a',
    });

    expect(review.status).toBe('APPROVED');
    expect(review.policy.allowOperationalDecisionMaking).toBe(false);
    expect(review.policy.requireHumanReview).toBe(true);
  });
});
