import { beforeEach, describe, expect, it } from 'vitest';
import { FileAssuraStore } from '@assurapay/database';
import { AssuraPayService } from './assurapay-service';

const makeStore = async () => {
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
  return store;
};

describe('AssuraPayService', () => {
  let service: AssuraPayService;

  beforeEach(async () => {
    const store = await makeStore();
    service = new AssuraPayService(store);
  });

  it('denies activation until the definition of done is approved', async () => {
    const workspace = await service.createWorkspace({ name: 'Demo Workspace', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'Testing' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await expect(service.activateMilestone(milestone.id)).rejects.toThrow('Milestone activation requires an approved definition of done');
  });

  it('creates a certificate and payment eligibility from a completed milestone', async () => {
    const workspace = await service.createWorkspace({ name: 'Demo Workspace', tenantId: 'tenant-a' });
    const contract = await service.createContract({ workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Agreement', description: 'Testing' });
    await service.approveContract(contract.id, 'owner-a');
    const blueprint = await service.createBlueprint({ contractId: contract.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Blueprint' });
    const milestone = await service.createMilestone({ blueprintId: blueprint.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Milestone' });
    await service.createDefinitionOfDone({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criteria: ['Evidence attached'] });
    await service.approveDefinitionOfDone(milestone.id);
    await service.activateMilestone(milestone.id);
    await service.uploadEvidence({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', title: 'Evidence' });
    await service.validateCriterion({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', criterion: 'Evidence attached', status: 'PASSED' });
    await service.createAcceptanceDecision({ milestoneId: milestone.id, workspaceId: workspace.id, tenantId: 'tenant-a', decision: 'FULL_ACCEPTANCE', decisionMakerId: 'authority-a' });
    const certificate = await service.certifyMilestone(milestone.id);
    const eligibility = await service.assessPaymentEligibility(milestone.id);

    expect(certificate.status).toBe('CERTIFIED');
    expect(eligibility.status).toBe('ELIGIBLE');
  });
});
