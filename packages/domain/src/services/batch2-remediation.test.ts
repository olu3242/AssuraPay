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
  return new AssuraPayService(store);
}

describe('Batch 2 remediation', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    service = await createService();
  });

  it('detects duplicate evidence by hash and reports completeness', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await service.createDefinitionOfDone({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criteria: ['Evidence'] });
    await service.approveDefinitionOfDone(milestone.id);
    await service.activateMilestone(milestone.id);
    await service.uploadEvidence({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'First evidence' });
    await service.uploadEvidence({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Duplicate evidence' });

    const completeness = await service.calculateEvidenceCompleteness(milestone.id);
    expect(completeness.required).toBe(1);
    expect(completeness.duplicateHashCount).toBeGreaterThanOrEqual(1);
  });

  it('requires authority for acceptance decisions', async () => {
    const workspace = await service.createWorkspace({ name: 'Tenant A', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'test' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await service.createDefinitionOfDone({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criteria: ['Evidence'] });
    await service.approveDefinitionOfDone(milestone.id);
    await service.activateMilestone(milestone.id);

    await expect(service.createAcceptanceRequest({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', submittedBy: 'vendor-a', authorityRequired: true })).rejects.toThrow('Authorization required');
  });

  it('revokes payment eligibility after certificate revocation', async () => {
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

    await service.revokeCertificate(certificate.id, 'auditor-a', 'test revocation');
    const refreshed = await service.getPaymentEligibilityByMilestone(milestone.id);

    expect(refreshed?.status).toBe('REVOKED');
  });
});
