import { randomUUID } from 'node:crypto';
import type { Contract, Blueprint, Milestone, DefinitionOfDone, EvidenceItem, ValidationResult, AcceptanceDecision, CompletionCertificate, PaymentEligibilityRecord } from '@assurapay/shared';

export function createSeedScenario() {
  const tenantId = 'tenant-demo';
  const workspaceId = 'workspace-demo';
  const organizationId = 'org-demo';
  const contract: Contract = {
    id: 'contract-demo',
    workspaceId,
    tenantId,
    title: 'Customer Data Acquisition and Verification Agreement',
    description: 'Data provider delivers verified business records.',
    status: 'APPROVED',
    version: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    approvedAt: '2026-08-01T01:00:00.000Z',
    approvedBy: 'owner-demo',
  };

  const blueprint: Blueprint = {
    id: 'blueprint-demo',
    contractId: contract.id,
    workspaceId,
    tenantId,
    title: 'Data verification blueprint',
    version: 1,
    status: 'APPROVED',
    createdAt: '2026-08-01T02:00:00.000Z',
  };

  const milestone: Milestone = {
    id: 'milestone-demo',
    blueprintId: blueprint.id,
    workspaceId,
    tenantId,
    title: 'Deliver 10,000 verified business records',
    status: 'ACTIVE',
    dodApproved: true,
    dependenciesSatisfied: true,
    createdAt: '2026-08-01T03:00:00.000Z',
  };

  const dod: DefinitionOfDone = {
    id: 'dod-demo',
    milestoneId: milestone.id,
    workspaceId,
    tenantId,
    approved: true,
    version: 1,
    criteria: [
      '10,000 records delivered',
      'Required schema completed',
      'Duplicate rate below threshold',
      'Accuracy sampling passed',
      'Consent evidence attached',
    ],
    createdAt: '2026-08-01T03:30:00.000Z',
  };

  const evidence: EvidenceItem[] = [
    {
      id: randomUUID(),
      milestoneId: milestone.id,
      workspaceId,
      tenantId,
      title: 'Dataset manifest',
      status: 'VERIFIED',
      contentHash: 'hash-1',
      createdAt: '2026-08-01T04:00:00.000Z',
    },
    {
      id: randomUUID(),
      milestoneId: milestone.id,
      workspaceId,
      tenantId,
      title: 'Data quality report',
      status: 'VERIFIED',
      contentHash: 'hash-2',
      createdAt: '2026-08-01T04:10:00.000Z',
    },
  ];

  const validation: ValidationResult[] = [
    {
      id: randomUUID(),
      milestoneId: milestone.id,
      workspaceId,
      tenantId,
      criterion: 'Duplicate rate below threshold',
      status: 'PASSED',
      createdAt: '2026-08-01T04:20:00.000Z',
    },
    {
      id: randomUUID(),
      milestoneId: milestone.id,
      workspaceId,
      tenantId,
      criterion: 'Accuracy sample above threshold',
      status: 'PASSED',
      createdAt: '2026-08-01T04:25:00.000Z',
    },
  ];

  const acceptance: AcceptanceDecision = {
    id: randomUUID(),
    milestoneId: milestone.id,
    workspaceId,
    tenantId,
    decision: 'FULL_ACCEPTANCE',
    decisionMakerId: 'authority-demo',
    createdAt: '2026-08-01T05:00:00.000Z',
  };

  const certificate: CompletionCertificate = {
    id: randomUUID(),
    milestoneId: milestone.id,
    workspaceId,
    tenantId,
    certificateNumber: 'AP-CC-2026-000001',
    status: 'CERTIFIED',
    integrityHash: 'sha256:demo-certificate',
    issuedAt: '2026-08-01T05:30:00.000Z',
  };

  const paymentEligibility: PaymentEligibilityRecord = {
    id: randomUUID(),
    milestoneId: milestone.id,
    workspaceId,
    tenantId,
    status: 'ELIGIBLE',
    certificateId: certificate.id,
    createdAt: '2026-08-01T05:35:00.000Z',
  };

  return {
    organizationId,
    contract,
    blueprint,
    milestone,
    dod,
    evidence,
    validation,
    acceptance,
    certificate,
    paymentEligibility,
  };
}
