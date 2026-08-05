import { beforeEach, describe, expect, it } from 'vitest';
import { FileAssuraStore } from '@assurapay/database';
import { AssuraPayService } from './assurapay-service';

async function createService() {
  const store = await FileAssuraStore.load();
  store.setSnapshot({
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
  return new AssuraPayService(store);
}

describe('Settlement assurance', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    service = await createService();
  });

  it('creates a settlement case and routes a certified milestone through entitlement, invoice, funding, and payment', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'Settlement test' });
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

    const settlementCase = await service.createSettlementCase({ paymentEligibilityId: eligibility.id, workspaceId: workspace.id, tenantId: 'tenant-a', contractId: contract.id, milestoneId: milestone.id });
    expect(settlementCase.status).toBe('ELIGIBILITY_CONFIRMED');
    const entitlement = await service.calculateFinancialEntitlement({ settlementCaseId: settlementCase.id, paymentEligibilityId: eligibility.id, grossAmountMinor: 5000000, retentionAmountMinor: 250000, taxWithholdingAmountMinor: 250000, penaltyAmountMinor: 100000 });
    const invoice = await service.createInvoice({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', invoiceNumber: 'INV-001', grossAmountMinor: 4400000, netAmountMinor: 4400000, documentHash: 'doc-hash-1', supplierPartyId: 'supplier-a' });
    const funding = await service.createFundingCommitment({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', committedAmountMinor: 4400000, providerId: 'sandbox-provider' });
    const release = await service.createReleaseRequest({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', requestedAmountMinor: 4400000, beneficiaryAccountReferenceId: 'beneficiary-a' });
    const payment = await service.createPaymentInstruction({ releaseRequestId: release.id, workspaceId: workspace.id, tenantId: 'tenant-a', providerId: 'sandbox-provider', idempotencyKey: 'payment-1', amountMinor: 4400000 });

    expect(entitlement.netPayableAmountMinor).toBe(4400000);
    expect(invoice.status).toBe('VALID');
    expect(funding.status).toBe('FUNDED');
    expect(release.status).toBe('APPROVED');
    expect(payment.status).toBe('SETTLED');
    expect(payment.providerReference).toContain('sandbox');
  });

  it('blocks duplicate invoices and duplicate payment instructions', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'Settlement test' });
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

    const settlementCase = await service.createSettlementCase({ paymentEligibilityId: eligibility.id, workspaceId: workspace.id, tenantId: 'tenant-a', contractId: contract.id, milestoneId: milestone.id });
    await service.calculateFinancialEntitlement({ settlementCaseId: settlementCase.id, paymentEligibilityId: eligibility.id, grossAmountMinor: 5000000, retentionAmountMinor: 250000, taxWithholdingAmountMinor: 250000, penaltyAmountMinor: 100000 });
    await service.createInvoice({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', invoiceNumber: 'INV-001', grossAmountMinor: 4400000, netAmountMinor: 4400000, documentHash: 'doc-hash-1', supplierPartyId: 'supplier-a' });
    await expect(await service.createInvoice({ settlementCaseId: settlementCase.id, workspaceId: workspace.id, tenantId: 'tenant-a', invoiceNumber: 'INV-001', grossAmountMinor: 4400000, netAmountMinor: 4400000, documentHash: 'doc-hash-2', supplierPartyId: 'supplier-a' })).rejects.toThrow('Duplicate invoice');
    await expect(await service.createPaymentInstruction({ releaseRequestId: 'missing', workspaceId: workspace.id, tenantId: 'tenant-a', providerId: 'sandbox-provider', idempotencyKey: 'payment-1', amountMinor: 4400000 })).rejects.toThrow('Release request not found');
  });
});
