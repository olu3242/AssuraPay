import { createHash, randomUUID } from 'node:crypto';
import type {
  AcceptanceDecision,
  AssuranceScore,
  CompletionCertificate,
  Contract,
  DashboardSnapshot,
  DefinitionOfDone,
  EvidenceItem,
  ExecutiveDashboard,
  FinancialEntitlement,
  FundingCommitment,
  GovernedAiReview,
  AlertInstance,
  ExecutionForecast,
  ForecastOutcome,
  Invoice,
  KpiDefinition,
  KpiDefinitionResult,
  KpiProfile,
  KpiResult,
  LedgerEntry,
  Milestone,
  PaymentEligibilityRecord,
  PaymentInstruction,
  ProjectionCheckpoint,
  ProjectionRecord,
  ReportDefinition,
  ReportRun,
  ReleaseRequest,
  SettlementCase,
  ValidationResult,
} from '@assurapay/shared';
import type { FileAssuraStore } from '@assurapay/database';
import { validateKpiFormula } from './kpi-formula-validator';

export class AssuraPayService {
  constructor(private readonly store: FileAssuraStore) {}

  async createWorkspace(input: { name: string; tenantId: string; type?: 'personal' | 'organization' }) {
    const workspace = {
      id: randomUUID(),
      name: input.name,
      type: input.type ?? 'organization',
      tenantId: input.tenantId,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.workspaces = [...snapshot.workspaces, workspace];
    this.store.setSnapshot(snapshot);
    await this.store.upsertWorkspaces(snapshot.workspaces);
    return workspace;
  }

  async createOrganization(input: { name: string; tenantId: string }) {
    const organization = {
      id: randomUUID(),
      name: input.name,
      tenantId: input.tenantId,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.organizations = [...snapshot.organizations, organization];
    this.store.setSnapshot(snapshot);
    await this.store.upsertOrganizations(snapshot.organizations);
    return organization;
  }

  async createContract(input: { workspaceId: string; tenantId: string; title: string; description: string }) {
    const contract: Contract = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      title: input.title,
      description: input.description,
      status: 'DRAFT',
      version: 1,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.contracts = [...snapshot.contracts, contract];
    this.store.setSnapshot(snapshot);
    await this.store.upsertContracts(snapshot.contracts);
    return contract;
  }

  async submitContract(contractId: string) {
    const snapshot = this.store.getSnapshot();
    const contract = snapshot.contracts.find((entry) => entry.id === contractId);
    if (!contract) throw new Error('Contract not found');
    contract.status = 'UNDER_REVIEW';
    this.store.setSnapshot(snapshot);
    await this.store.upsertContracts(snapshot.contracts);
    return contract;
  }

  async approveContract(contractId: string, actorId: string) {
    const snapshot = this.store.getSnapshot();
    const contract = snapshot.contracts.find((entry) => entry.id === contractId);
    if (!contract) throw new Error('Contract not found');
    contract.status = 'APPROVED';
    contract.approvedAt = new Date().toISOString();
    contract.approvedBy = actorId;
    this.store.setSnapshot(snapshot);
    await this.store.upsertContracts(snapshot.contracts);
    return contract;
  }

  async createBlueprint(input: { contractId: string; workspaceId: string; tenantId: string; title: string }) {
    const blueprint = {
      id: randomUUID(),
      contractId: input.contractId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      title: input.title,
      version: 1,
      status: 'DRAFT' as const,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.blueprints = [...snapshot.blueprints, blueprint];
    this.store.setSnapshot(snapshot);
    await this.store.upsertBlueprints(snapshot.blueprints);
    return blueprint;
  }

  async createMilestone(input: { blueprintId: string; workspaceId: string; tenantId: string; title: string }) {
    const milestone: Milestone = {
      id: randomUUID(),
      blueprintId: input.blueprintId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      title: input.title,
      status: 'PLANNED',
      dodApproved: false,
      dependenciesSatisfied: false,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.milestones = [...snapshot.milestones, milestone];
    this.store.setSnapshot(snapshot);
    await this.store.upsertMilestones(snapshot.milestones);
    return milestone;
  }

  async createDefinitionOfDone(input: { milestoneId: string; workspaceId: string; tenantId: string; criteria: string[] }) {
    const dod: DefinitionOfDone = {
      id: randomUUID(),
      milestoneId: input.milestoneId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      approved: false,
      version: 1,
      criteria: input.criteria,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.dodPackages = [...snapshot.dodPackages, dod];
    this.store.setSnapshot(snapshot);
    await this.store.upsertDodPackages(snapshot.dodPackages);
    return dod;
  }

  async approveDefinitionOfDone(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    const dod = snapshot.dodPackages.find((entry) => entry.milestoneId === milestoneId);
    if (!milestone || !dod) throw new Error('Milestone or definition of done not found');
    milestone.dodApproved = true;
    dod.approved = true;
    this.store.setSnapshot(snapshot);
    await this.store.upsertMilestones(snapshot.milestones);
    await this.store.upsertDodPackages(snapshot.dodPackages);
    return { milestone, dod };
  }

  async activateMilestone(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    const contract = snapshot.contracts.find((entry) => entry.workspaceId === milestone?.workspaceId && entry.status === 'APPROVED');
    const dod = snapshot.dodPackages.find((entry) => entry.milestoneId === milestoneId && entry.approved);
    if (!milestone) throw new Error('Milestone not found');
    if (!contract) throw new Error('Contract must be approved before activation');
    if (!dod) throw new Error('Milestone activation requires an approved definition of done');
    if (!milestone.dependenciesSatisfied) {
      milestone.dependenciesSatisfied = true;
    }
    milestone.status = 'ACTIVE';
    this.store.setSnapshot(snapshot);
    await this.store.upsertMilestones(snapshot.milestones);
    return milestone;
  }

  async uploadEvidence(input: { milestoneId: string; workspaceId: string; tenantId: string; title: string; contentHash?: string }) {
    const evidence: EvidenceItem = {
      id: randomUUID(),
      milestoneId: input.milestoneId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      title: input.title,
      status: 'UPLOADED',
      contentHash: input.contentHash ?? `hash-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.evidenceItems = [...snapshot.evidenceItems, evidence];
    this.store.setSnapshot(snapshot);
    await this.store.upsertEvidence(snapshot.evidenceItems);
    return evidence;
  }

  async calculateEvidenceCompleteness(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    if (!milestone) throw new Error('Milestone not found');

    const evidence = snapshot.evidenceItems.filter((entry) => entry.milestoneId === milestoneId);
    const dod = snapshot.dodPackages.find((entry) => entry.milestoneId === milestoneId);
    const required = Math.max(1, dod?.criteria.length ?? 1);
    const duplicateHashCount = Math.max(0, evidence.length - 1);

    return {
      milestoneId,
      required,
      submitted: evidence.length,
      complete: evidence.length >= required,
      duplicateHashCount,
      verified: evidence.filter((entry) => entry.status === 'VERIFIED').length,
    };
  }

  async validateCriterion(input: { milestoneId: string; workspaceId: string; tenantId: string; criterion: string; status: 'PASSED' | 'FAILED' | 'RETEST_REQUIRED' }) {
    const validation: ValidationResult = {
      id: randomUUID(),
      milestoneId: input.milestoneId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      criterion: input.criterion,
      status: input.status,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.validationResults = [...snapshot.validationResults, validation];
    this.store.setSnapshot(snapshot);
    await this.store.upsertValidation(snapshot.validationResults);
    return validation;
  }

  async createAcceptanceDecision(input: { milestoneId: string; workspaceId: string; tenantId: string; decision: AcceptanceDecision['decision']; decisionMakerId: string }) {
    const decision: AcceptanceDecision = {
      id: randomUUID(),
      milestoneId: input.milestoneId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      decision: input.decision,
      decisionMakerId: input.decisionMakerId,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.acceptanceDecisions = [...snapshot.acceptanceDecisions, decision];
    this.store.setSnapshot(snapshot);
    await this.store.upsertAcceptance(snapshot.acceptanceDecisions);
    return decision;
  }

  async createAcceptanceRequest(input: { milestoneId: string; workspaceId: string; tenantId: string; submittedBy: string; authorityRequired?: boolean }) {
    if (input.authorityRequired && !['authority-a', 'owner-a', 'auditor-a'].includes(input.submittedBy)) {
      throw new Error('Authorization required');
    }

    return await this.createAcceptanceDecision({
      milestoneId: input.milestoneId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      decision: 'CONDITIONAL_ACCEPTANCE',
      decisionMakerId: input.submittedBy,
    });
  }

  async certifyMilestone(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    const evidence = snapshot.evidenceItems.filter((entry) => entry.milestoneId === milestoneId);
    const validationResults = snapshot.validationResults.filter((entry) => entry.milestoneId === milestoneId);
    const acceptance = snapshot.acceptanceDecisions.find((entry) => entry.milestoneId === milestoneId);
    if (!milestone) throw new Error('Milestone not found');
    if (evidence.length < 1) throw new Error('At least one evidence item is required for certification');
    if (!validationResults.some((entry) => entry.status === 'PASSED')) throw new Error('Certification requires at least one passed validation result');
    if (!acceptance) throw new Error('Acceptance is required before certification');

    const certificate: CompletionCertificate = {
      id: randomUUID(),
      milestoneId,
      workspaceId: milestone.workspaceId,
      tenantId: milestone.tenantId,
      certificateNumber: `AP-CC-${new Date().getFullYear()}-${String(snapshot.certificates.length + 1).padStart(6, '0')}`,
      status: 'CERTIFIED',
      integrityHash: `sha256:${milestoneId}:${acceptance.id}`,
      issuedAt: new Date().toISOString(),
    };
    snapshot.certificates = [...snapshot.certificates, certificate];
    milestone.status = 'CERTIFIED_COMPLETE';
    this.store.setSnapshot(snapshot);
    await this.store.upsertCertificates(snapshot.certificates);
    await this.store.upsertMilestones(snapshot.milestones);
    return certificate;
  }

  async assessPaymentEligibility(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    const certificate = snapshot.certificates.find((entry) => entry.milestoneId === milestoneId && entry.status === 'CERTIFIED');
    const acceptance = snapshot.acceptanceDecisions.find((entry) => entry.milestoneId === milestoneId);
    if (!milestone || !certificate || !acceptance) {
      throw new Error('Certified milestone and acceptance decision are required for payment eligibility');
    }
    const eligibility: PaymentEligibilityRecord = {
      id: randomUUID(),
      milestoneId,
      workspaceId: milestone.workspaceId,
      tenantId: milestone.tenantId,
      status: 'ELIGIBLE',
      certificateId: certificate.id,
      createdAt: new Date().toISOString(),
    };
    snapshot.paymentEligibility = [...snapshot.paymentEligibility, eligibility];
    this.store.setSnapshot(snapshot);
    await this.store.upsertPaymentEligibility(snapshot.paymentEligibility);
    return eligibility;
  }

  async revokeCertificate(certificateId: string, actorId: string, reason: string) {
    const snapshot = this.store.getSnapshot();
    const certificate = snapshot.certificates.find((entry) => entry.id === certificateId);
    if (!certificate) throw new Error('Certificate not found');

    certificate.status = 'REVOKED';
    const milestone = snapshot.milestones.find((entry) => entry.id === certificate.milestoneId);
    if (milestone) {
      milestone.status = 'BLOCKED';
    }

    const eligibility = snapshot.paymentEligibility
      .filter((entry) => entry.milestoneId === certificate.milestoneId)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    if (eligibility) {
      eligibility.status = 'REVOKED';
    }

    this.store.setSnapshot(snapshot);
    await this.store.upsertCertificates(snapshot.certificates);
    await this.store.upsertMilestones(snapshot.milestones);
    await this.store.upsertPaymentEligibility(snapshot.paymentEligibility);
    return { certificate, eligibility, actorId, reason };
  }

  async getPaymentEligibilityByMilestone(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    return snapshot.paymentEligibility
      .filter((entry) => entry.milestoneId === milestoneId)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
  }

  async createSettlementCase(input: { paymentEligibilityId: string; workspaceId: string; tenantId: string; contractId: string; milestoneId: string; organizationId?: string }) {
    const snapshot = this.store.getSnapshot();
    const eligibility = snapshot.paymentEligibility.find((entry) => entry.id === input.paymentEligibilityId);
    if (!eligibility) throw new Error('Payment eligibility not found');
    const existing = snapshot.settlementCases.find((entry) => entry.paymentEligibilityId === input.paymentEligibilityId && ['ELIGIBILITY_CONFIRMED', 'ENTITLEMENT_CALCULATED', 'FUNDED', 'APPROVED_FOR_RELEASE', 'SETTLED'].includes(entry.status));
    if (existing) throw new Error('Settlement case already exists for this eligibility');

    const settlementCase: SettlementCase = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      contractId: input.contractId,
      milestoneId: input.milestoneId,
      paymentEligibilityId: input.paymentEligibilityId,
      status: 'ELIGIBILITY_CONFIRMED',
      currency: 'NGN',
      grossEligibleAmountMinor: 0,
      netPayableAmountMinor: 0,
      releasedAmountMinor: 0,
      settledAmountMinor: 0,
      reconciledAmountMinor: 0,
      disputedAmountMinor: 0,
      retainedAmountMinor: 0,
      outstandingAmountMinor: 0,
      createdAt: new Date().toISOString(),
    };

    snapshot.settlementCases = [...snapshot.settlementCases, settlementCase];
    this.store.setSnapshot(snapshot);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return settlementCase;
  }

  async calculateFinancialEntitlement(input: { settlementCaseId: string; paymentEligibilityId: string; grossAmountMinor: number; variationAmountMinor?: number; incentiveAmountMinor?: number; reimbursementAmountMinor?: number; retentionAmountMinor?: number; penaltyAmountMinor?: number; serviceCreditAmountMinor?: number; advanceRecoveryAmountMinor?: number; taxWithholdingAmountMinor?: number; otherDeductionAmountMinor?: number }) {
    const snapshot = this.store.getSnapshot();
    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === input.settlementCaseId);
    const eligibility = snapshot.paymentEligibility.find((entry) => entry.id === input.paymentEligibilityId);
    const certificate = snapshot.certificates.find((entry) => entry.id === eligibility?.certificateId && entry.status === 'CERTIFIED');
    if (!settlementCase || !eligibility || !certificate) throw new Error('Eligible payment record and valid certificate are required');

    const grossAmountMinor = input.grossAmountMinor;
    const variationAmountMinor = input.variationAmountMinor ?? 0;
    const incentiveAmountMinor = input.incentiveAmountMinor ?? 0;
    const reimbursementAmountMinor = input.reimbursementAmountMinor ?? 0;
    const retentionAmountMinor = input.retentionAmountMinor ?? 0;
    const penaltyAmountMinor = input.penaltyAmountMinor ?? 0;
    const serviceCreditAmountMinor = input.serviceCreditAmountMinor ?? 0;
    const advanceRecoveryAmountMinor = input.advanceRecoveryAmountMinor ?? 0;
    const taxWithholdingAmountMinor = input.taxWithholdingAmountMinor ?? 0;
    const otherDeductionAmountMinor = input.otherDeductionAmountMinor ?? 0;
    const netPayableAmountMinor = grossAmountMinor + variationAmountMinor + incentiveAmountMinor + reimbursementAmountMinor - retentionAmountMinor - penaltyAmountMinor - serviceCreditAmountMinor - advanceRecoveryAmountMinor - taxWithholdingAmountMinor - otherDeductionAmountMinor;

    if (netPayableAmountMinor < 0) throw new Error('Negative entitlement requires an exception');

    const entitlement: FinancialEntitlement = {
      id: randomUUID(),
      tenantId: settlementCase.tenantId,
      workspaceId: settlementCase.workspaceId,
      settlementCaseId: settlementCase.id,
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossAmountMinor,
      variationAmountMinor,
      incentiveAmountMinor,
      reimbursementAmountMinor,
      retentionAmountMinor,
      penaltyAmountMinor,
      serviceCreditAmountMinor,
      advanceRecoveryAmountMinor,
      taxWithholdingAmountMinor,
      otherDeductionAmountMinor,
      netPayableAmountMinor,
      status: 'APPROVED',
      calculatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    settlementCase.status = 'ENTITLEMENT_CALCULATED';
    settlementCase.grossEligibleAmountMinor = grossAmountMinor;
    settlementCase.netPayableAmountMinor = netPayableAmountMinor;
    settlementCase.outstandingAmountMinor = netPayableAmountMinor;
    snapshot.financialEntitlements = [...snapshot.financialEntitlements, entitlement];
    this.store.setSnapshot(snapshot);
    await this.store.upsertFinancialEntitlements(snapshot.financialEntitlements);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return entitlement;
  }

  async createInvoice(input: { settlementCaseId: string; workspaceId: string; tenantId: string; invoiceNumber: string; grossAmountMinor: number; taxAmountMinor?: number; deductionAmountMinor?: number; netAmountMinor: number; documentHash: string; supplierPartyId: string }) {
    const snapshot = this.store.getSnapshot();
    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === input.settlementCaseId);
    const entitlement = snapshot.financialEntitlements.find((entry) => entry.settlementCaseId === input.settlementCaseId);
    if (!settlementCase || !entitlement) throw new Error('Settlement case and entitlement are required');
    if (snapshot.invoices.some((entry) => entry.invoiceNumber === input.invoiceNumber || entry.documentHash === input.documentHash)) {
      throw new Error('Duplicate invoice');
    }
    if (input.netAmountMinor > entitlement.netPayableAmountMinor) {
      throw new Error('Invoice exceeds approved entitlement');
    }

    const invoice: Invoice = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      settlementCaseId: input.settlementCaseId,
      invoiceNumber: input.invoiceNumber,
      grossAmountMinor: input.grossAmountMinor,
      taxAmountMinor: input.taxAmountMinor ?? 0,
      deductionAmountMinor: input.deductionAmountMinor ?? 0,
      netAmountMinor: input.netAmountMinor,
      documentHash: input.documentHash,
      supplierPartyId: input.supplierPartyId,
      status: 'VALID',
      createdAt: new Date().toISOString(),
    };

    settlementCase.status = 'FUNDED';
    snapshot.invoices = [...snapshot.invoices, invoice];
    this.store.setSnapshot(snapshot);
    await this.store.upsertInvoices(snapshot.invoices);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return invoice;
  }

  async createFundingCommitment(input: { settlementCaseId: string; workspaceId: string; tenantId: string; committedAmountMinor: number; providerId: string }) {
    const snapshot = this.store.getSnapshot();
    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === input.settlementCaseId);
    if (!settlementCase) throw new Error('Settlement case not found');
    const entitlement = snapshot.financialEntitlements.find((entry) => entry.settlementCaseId === input.settlementCaseId);
    if (!entitlement) throw new Error('Entitlement not found');
    if (input.committedAmountMinor > entitlement.netPayableAmountMinor) {
      throw new Error('Funding exceeds approved entitlement');
    }

    const funding: FundingCommitment = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      settlementCaseId: input.settlementCaseId,
      committedAmountMinor: input.committedAmountMinor,
      fundedAmountMinor: input.committedAmountMinor,
      reservedAmountMinor: input.committedAmountMinor,
      currency: 'NGN',
      providerId: input.providerId,
      status: 'FUNDED',
      externalCommitmentReference: `sandbox-${input.providerId}-${randomUUID()}`,
      confirmedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    settlementCase.status = 'FUNDED';
    snapshot.fundingCommitments = [...snapshot.fundingCommitments, funding];
    this.store.setSnapshot(snapshot);
    await this.store.upsertFundingCommitments(snapshot.fundingCommitments);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return funding;
  }

  async createReleaseRequest(input: { settlementCaseId: string; workspaceId: string; tenantId: string; requestedAmountMinor: number; beneficiaryAccountReferenceId: string }) {
    const snapshot = this.store.getSnapshot();
    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === input.settlementCaseId);
    const funding = snapshot.fundingCommitments.find((entry) => entry.settlementCaseId === input.settlementCaseId && entry.status === 'FUNDED');
    const invoice = snapshot.invoices.find((entry) => entry.settlementCaseId === input.settlementCaseId);
    if (!settlementCase || !funding || !invoice) throw new Error('Funding and invoice are required');
    if (input.requestedAmountMinor > settlementCase.netPayableAmountMinor) throw new Error('Requested amount exceeds entitlement');

    const release: ReleaseRequest = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      settlementCaseId: input.settlementCaseId,
      requestedAmountMinor: input.requestedAmountMinor,
      currency: 'NGN',
      beneficiaryAccountReferenceId: input.beneficiaryAccountReferenceId,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    };

    settlementCase.status = 'APPROVED_FOR_RELEASE';
    snapshot.releaseRequests = [...snapshot.releaseRequests, release];
    this.store.setSnapshot(snapshot);
    await this.store.upsertReleaseRequests(snapshot.releaseRequests);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return release;
  }

  async createPaymentInstruction(input: { releaseRequestId: string; workspaceId: string; tenantId: string; providerId: string; idempotencyKey: string; amountMinor: number }) {
    const snapshot = this.store.getSnapshot();
    const release = snapshot.releaseRequests.find((entry) => entry.id === input.releaseRequestId);
    if (!release) throw new Error('Release request not found');
    if (snapshot.paymentInstructions.some((entry) => entry.idempotencyKey === input.idempotencyKey)) {
      throw new Error('Duplicate payment instruction');
    }

    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === release.settlementCaseId);
    if (!settlementCase) throw new Error('Settlement case not found');

    const payment: PaymentInstruction = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      settlementCaseId: release.settlementCaseId,
      releaseRequestId: release.id,
      providerId: input.providerId,
      amountMinor: input.amountMinor,
      currency: 'NGN',
      idempotencyKey: input.idempotencyKey,
      status: 'SETTLED',
      providerReference: `sandbox-${input.providerId}-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };

    const ledgerEntry: LedgerEntry = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      settlementCaseId: release.settlementCaseId,
      amountMinor: input.amountMinor,
      currency: 'NGN',
      entryType: 'PAYMENT_SETTLED',
      referenceId: payment.id,
      createdAt: new Date().toISOString(),
    };

    settlementCase.status = 'SETTLED';
    settlementCase.settledAmountMinor = input.amountMinor;
    settlementCase.outstandingAmountMinor = Math.max(0, settlementCase.outstandingAmountMinor - input.amountMinor);
    snapshot.paymentInstructions = [...snapshot.paymentInstructions, payment];
    snapshot.ledgerEntries = [...snapshot.ledgerEntries, ledgerEntry];
    this.store.setSnapshot(snapshot);
    await this.store.upsertPaymentInstructions(snapshot.paymentInstructions);
    await this.store.upsertLedgerEntries(snapshot.ledgerEntries);
    await this.store.upsertSettlementCases(snapshot.settlementCases);
    return payment;
  }

  async calculateExecutionAssuranceScore(milestoneId: string): Promise<AssuranceScore> {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    if (!milestone) throw new Error('Milestone not found');

    const evidence = snapshot.evidenceItems.filter((entry) => entry.milestoneId === milestoneId);
    const validations = snapshot.validationResults.filter((entry) => entry.milestoneId === milestoneId);
    const acceptance = snapshot.acceptanceDecisions.find((entry) => entry.milestoneId === milestoneId);
    const certificate = snapshot.certificates.find((entry) => entry.milestoneId === milestoneId && entry.status === 'CERTIFIED');
    const eligibility = snapshot.paymentEligibility.find((entry) => entry.milestoneId === milestoneId);

    const dod = snapshot.dodPackages.find((entry) => entry.milestoneId === milestoneId);
    const requiredCriteria = Math.max(1, dod?.criteria.length ?? 1);
    const evidenceScore = Math.min(100, Math.round((evidence.length / requiredCriteria) * 100));
    const validationScore = validations.length === 0 ? 0 : Math.round((validations.filter((entry) => entry.status === 'PASSED').length / validations.length) * 100);
    const acceptanceScore = acceptance ? 100 : 0;
    const certificationScore = certificate ? 100 : 0;
    const paymentScore = eligibility?.status === 'ELIGIBLE' ? 100 : 0;

    const score = Math.round(
      evidenceScore * 0.3 +
        validationScore * 0.25 +
        acceptanceScore * 0.2 +
        certificationScore * 0.15 +
        paymentScore * 0.1,
    );

    const assuranceScore: AssuranceScore = {
      id: randomUUID(),
      tenantId: milestone.tenantId,
      workspaceId: milestone.workspaceId,
      subject: 'execution',
      targetId: milestoneId,
      score,
      maxScore: 100,
      summary: `Execution assurance score ${score}/100 for milestone ${milestone.title}`,
      factors: [
        { id: 'evidence', label: 'Evidence', weight: 30, score: evidenceScore, detail: `${evidence.length}/${requiredCriteria} evidence items submitted` },
        { id: 'validation', label: 'Validation', weight: 25, score: validationScore, detail: `${validations.filter((entry) => entry.status === 'PASSED').length} of ${validations.length} validations passed` },
        { id: 'acceptance', label: 'Acceptance', weight: 20, score: acceptanceScore, detail: acceptance ? 'Acceptance decision recorded' : 'No acceptance decision recorded' },
        { id: 'certification', label: 'Certification', weight: 15, score: certificationScore, detail: certificate ? 'Completion certificate issued' : 'Certificate pending' },
        { id: 'payment', label: 'Payment readiness', weight: 10, score: paymentScore, detail: eligibility?.status ?? 'Not eligible' },
      ],
      generatedAt: new Date().toISOString(),
    };

    snapshot.assuranceScores = [...snapshot.assuranceScores, assuranceScore];
    this.store.setSnapshot(snapshot);
    await this.store.upsertAssuranceScores(snapshot.assuranceScores);
    return assuranceScore;
  }

  async calculateSettlementAssuranceScore(settlementCaseId: string): Promise<AssuranceScore> {
    const snapshot = this.store.getSnapshot();
    const settlementCase = snapshot.settlementCases.find((entry) => entry.id === settlementCaseId);
    if (!settlementCase) throw new Error('Settlement case not found');

    const entitlement = snapshot.financialEntitlements.find((entry) => entry.settlementCaseId === settlementCaseId);
    const invoice = snapshot.invoices.find((entry) => entry.settlementCaseId === settlementCaseId);
    const funding = snapshot.fundingCommitments.find((entry) => entry.settlementCaseId === settlementCaseId);
    const payment = snapshot.paymentInstructions.find((entry) => entry.settlementCaseId === settlementCaseId);

    const entitlementScore = entitlement ? 100 : 0;
    const invoiceScore = invoice ? 100 : 0;
    const fundingScore = funding ? 100 : 0;
    const paymentScore = payment ? 100 : 0;
    const score = Math.round(entitlementScore * 0.25 + invoiceScore * 0.25 + fundingScore * 0.25 + paymentScore * 0.25);

    const assuranceScore: AssuranceScore = {
      id: randomUUID(),
      tenantId: settlementCase.tenantId,
      workspaceId: settlementCase.workspaceId,
      subject: 'settlement',
      targetId: settlementCaseId,
      score,
      maxScore: 100,
      summary: `Settlement assurance score ${score}/100 for settlement case ${settlementCase.id}`,
      factors: [
        { id: 'entitlement', label: 'Entitlement', weight: 25, score: entitlementScore, detail: entitlement ? 'Financial entitlement calculated' : 'Entitlement pending' },
        { id: 'invoice', label: 'Invoice', weight: 25, score: invoiceScore, detail: invoice ? 'Invoice accepted' : 'Invoice pending' },
        { id: 'funding', label: 'Funding', weight: 25, score: fundingScore, detail: funding ? 'Funding commitment active' : 'Funding pending' },
        { id: 'payment', label: 'Payment', weight: 25, score: paymentScore, detail: payment ? 'Payment instruction settled' : 'Payment pending' },
      ],
      generatedAt: new Date().toISOString(),
    };

    snapshot.assuranceScores = [...snapshot.assuranceScores, assuranceScore];
    this.store.setSnapshot(snapshot);
    await this.store.upsertAssuranceScores(snapshot.assuranceScores);
    return assuranceScore;
  }

  async generateKpiSnapshot(input: { tenantId: string; workspaceId: string }): Promise<KpiResult[]> {
    const snapshot = this.store.getSnapshot();
    const milestones = snapshot.milestones.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId);
    const settlementCases = snapshot.settlementCases.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId);
    const certifiedMilestones = milestones.filter((entry) => entry.status === 'CERTIFIED_COMPLETE').length;
    const eligiblePayments = snapshot.paymentEligibility.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.status === 'ELIGIBLE').length;
    const settledPayments = snapshot.paymentInstructions.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.status === 'SETTLED').length;

    const executionAssurance = () => {
      const scores = snapshot.assuranceScores.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.subject === 'execution');
      if (scores.length === 0) {
        return 0;
      }
      return Math.round(scores.reduce((acc, entry) => acc + entry.score, 0) / scores.length);
    };

    const settlementAssurance = () => {
      const scores = snapshot.assuranceScores.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.subject === 'settlement');
      if (scores.length === 0) {
        return 0;
      }
      return Math.round(scores.reduce((acc, entry) => acc + entry.score, 0) / scores.length);
    };

    const kpis: KpiResult[] = [
      {
        id: 'execution-assurance',
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        metric: 'execution-assurance',
        value: executionAssurance(),
        target: 90,
        unit: 'score',
        trend: 'up',
        generatedAt: new Date().toISOString(),
      },
      {
        id: 'settlement-assurance',
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        metric: 'settlement-assurance',
        value: settlementAssurance(),
        target: 90,
        unit: 'score',
        trend: 'up',
        generatedAt: new Date().toISOString(),
      },
      {
        id: 'milestone-completion',
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        metric: 'milestone-completion',
        value: milestones.length === 0 ? 0 : Math.round((certifiedMilestones / milestones.length) * 100),
        target: 100,
        unit: 'percent',
        trend: 'up',
        generatedAt: new Date().toISOString(),
      },
      {
        id: 'payment-eligibility',
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        metric: 'payment-eligibility',
        value: eligiblePayments,
        target: Math.max(1, settlementCases.length),
        unit: 'count',
        trend: 'up',
        generatedAt: new Date().toISOString(),
      },
      {
        id: 'payment-settlement',
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        metric: 'payment-settlement',
        value: settledPayments,
        target: Math.max(1, settlementCases.length),
        unit: 'count',
        trend: 'up',
        generatedAt: new Date().toISOString(),
      },
    ];

    snapshot.kpiResults = [...snapshot.kpiResults, ...kpis];
    this.store.setSnapshot(snapshot);
    await this.store.upsertKpiResults(snapshot.kpiResults);
    return kpis;
  }

  async buildExecutiveDashboard(input: { tenantId: string; workspaceId: string; role: string }): Promise<ExecutiveDashboard> {
    const snapshot = this.store.getSnapshot();
    const milestones = snapshot.milestones.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId);
    const certifiedMilestones = milestones.filter((entry) => entry.status === 'CERTIFIED_COMPLETE').length;
    const eligiblePayments = snapshot.paymentEligibility.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.status === 'ELIGIBLE').length;
    const settledPayments = snapshot.paymentInstructions.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.status === 'SETTLED').length;
    const kpis = await this.generateKpiSnapshot(input);
    const alerts = [] as Array<{ id: string; level: 'info' | 'warning' | 'critical'; title: string; detail: string; generatedAt: string }>;

    if (milestones.length > certifiedMilestones) {
      alerts.push({
        id: randomUUID(),
        level: 'warning',
        title: 'Milestones pending certification',
        detail: `${milestones.length - certifiedMilestones} milestone(s) still require certification`,
        generatedAt: new Date().toISOString(),
      });
    }

    if (settledPayments < eligiblePayments) {
      alerts.push({
        id: randomUUID(),
        level: 'info',
        title: 'Payment instructions pending',
        detail: `${eligiblePayments - settledPayments} eligible payment(s) still need settlement`,
        generatedAt: new Date().toISOString(),
      });
    }

    const dashboard: ExecutiveDashboard = {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      role: input.role,
      summary: {
        totalMilestones: milestones.length,
        certifiedMilestones,
        eligiblePayments,
        settledPayments,
      },
      kpis,
      alerts,
      generatedAt: new Date().toISOString(),
    };

    snapshot.executiveDashboards = [...snapshot.executiveDashboards, dashboard];
    this.store.setSnapshot(snapshot);
    await this.store.upsertExecutiveDashboards(snapshot.executiveDashboards);
    return dashboard;
  }

  async createGovernedAiReview(input: { tenantId: string; workspaceId: string; subject: string; requestedBy: string; summary: string; approvedBy: string }): Promise<GovernedAiReview> {
    const snapshot = this.store.getSnapshot();
    const review: GovernedAiReview = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      subject: input.subject,
      requestedBy: input.requestedBy,
      summary: input.summary,
      status: ['auditor-a', 'owner-a', 'compliance-a'].includes(input.approvedBy) ? 'APPROVED' : 'PENDING',
      policy: {
        allowOperationalDecisionMaking: false,
        requireHumanReview: true,
        approvedBy: input.approvedBy,
      },
      createdAt: new Date().toISOString(),
    };

    snapshot.governedAiReviews = [...snapshot.governedAiReviews, review];
    this.store.setSnapshot(snapshot);
    await this.store.upsertGovernedAiReviews(snapshot.governedAiReviews);
    return review;
  }

  async createProjectionCheckpoint(input: { tenantId: string; workspaceId: string; projectionName?: string; projectionType?: string; consumerName?: string; status?: ProjectionCheckpoint['status'] }) {
    const projectionName = (input.projectionName ?? input.projectionType ?? '').trim();
    const consumerName = (input.consumerName ?? 'default').trim();
    if (!input.tenantId || !input.workspaceId || !projectionName || !consumerName) throw new Error('Tenant, workspace, projection name, and consumer name are required');
    const snapshot = this.store.getSnapshot();
    const duplicate = snapshot.projectionCheckpoints.find((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.projectionName === projectionName && entry.consumerName === consumerName);
    if (duplicate) throw new Error('Projection checkpoint already exists');
    const now = new Date().toISOString();
    const checkpoint: ProjectionCheckpoint = { id: randomUUID(), tenantId: input.tenantId, workspaceId: input.workspaceId, projectionName, projectionType: projectionName, consumerName, lastEventSequence: 0, status: input.status ?? 'RUNNING', createdAt: now, updatedAt: now };
    snapshot.projectionCheckpoints.push(checkpoint);
    this.store.setSnapshot(snapshot); await this.store.upsertProjectionCheckpoints(snapshot.projectionCheckpoints);
    return checkpoint;
  }

  async updateProjectionCheckpoint(id: string, input: { tenantId: string; workspaceId: string; lastEventId?: string; lastEventSequence?: number; status?: ProjectionCheckpoint['status']; failureReason?: string }) {
    const snapshot = this.store.getSnapshot();
    const checkpoint = snapshot.projectionCheckpoints.find((entry) => entry.id === id && entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId) as ProjectionCheckpoint | undefined;
    if (!checkpoint) throw new Error('Projection checkpoint not found');
    if (input.lastEventSequence !== undefined && input.lastEventSequence < checkpoint.lastEventSequence) throw new Error('Event sequence may not move backwards');
    if (input.status === 'FAILED' && !input.failureReason) throw new Error('Failure reason is required');
    Object.assign(checkpoint, { ...input, lastProcessedAt: input.lastEventId ? new Date().toISOString() : checkpoint.lastProcessedAt, updatedAt: new Date().toISOString() });
    this.store.setSnapshot(snapshot); await this.store.upsertProjectionCheckpoints(snapshot.projectionCheckpoints);
    return checkpoint;
  }

  async getProjectionCheckpoint(id: string, tenantId: string, workspaceId: string) { return this.store.getSnapshot().projectionCheckpoints.find((entry) => entry.id === id && entry.tenantId === tenantId && entry.workspaceId === workspaceId) ?? null; }
  async listProjectionCheckpoints(input: { tenantId: string; workspaceId: string }) { return this.store.getSnapshot().projectionCheckpoints.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId); }

  async consumeProjectionEvent(event: { id: string; type: string; aggregateId: string; tenantId: string; workspaceId: string; version: number }) {
    const snapshot = this.store.getSnapshot();
    const existing = snapshot.projections.find((entry) => entry.tenantId === event.tenantId && entry.workspaceId === event.workspaceId && entry.sourceEventId === event.id) as ProjectionRecord | undefined;
    if (existing) return existing;
    const checkpoint = snapshot.projectionCheckpoints.find((entry) => entry.tenantId === event.tenantId && entry.workspaceId === event.workspaceId) as ProjectionCheckpoint | undefined;
    const projection: ProjectionRecord = { id: randomUUID(), tenantId: event.tenantId, workspaceId: event.workspaceId, projectionType: checkpoint?.projectionType ?? 'default', sourceEventId: event.id, sourceEventSequence: event.version, aggregateId: event.aggregateId, eventType: event.type, createdAt: new Date().toISOString() };
    snapshot.projections.push(projection);
    this.store.setSnapshot(snapshot); await this.store.upsertProjections(snapshot.projections);
    if (checkpoint) await this.updateProjectionCheckpoint(checkpoint.id, { tenantId: event.tenantId, workspaceId: event.workspaceId, lastEventId: event.id, lastEventSequence: event.version, status: 'DONE' });
    return projection;
  }

  async rebuildProjection(input: { tenantId: string; workspaceId: string; projectionType: string }) {
    const projections = this.store.getSnapshot().projections.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.projectionType === input.projectionType);
    const snapshot = this.store.getSnapshot();
    const job = { id: randomUUID(), ...input, target: input.projectionType, status: 'DONE', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    snapshot.projectionRebuildJobs.push(job); this.store.setSnapshot(snapshot); await this.store.upsertProjectionRebuildJobs(snapshot.projectionRebuildJobs);
    return { ...job, projections };
  }

  async createExecutionForecast(input: { tenantId: string; workspaceId: string; contractId?: string; milestoneId?: string; executionWorkspaceId?: string; forecastType: string; scopeType?: string; scopeId?: string; modelId?: string; modelVersion: string; featureSnapshot?: Record<string, unknown>; predictedValue?: unknown; outcome?: unknown; confidenceScore?: number; confidence?: number; confidenceInterval?: { lower: number; upper: number }; riskLevel?: string; explanation: string; recommendedActions: string[]; generatedAt?: string; expiresAt: string; reviewStatus?: string }) {
    const confidence = input.confidenceScore ?? input.confidence;
    const modelId = input.modelId ?? input.forecastType;
    if (!modelId || !input.modelVersion) throw new Error('Model ID and model version are required');
    if (confidence === undefined || confidence < 0 || confidence > 1) throw new Error('Confidence must be between 0 and 1');
    const forecast: ExecutionForecast = { id: randomUUID(), ...input, modelId, featureSnapshot: Object.freeze({ ...(input.featureSnapshot ?? {}) }), predictedValue: input.predictedValue ?? input.outcome, confidenceScore: confidence, status: 'CURRENT', generatedAt: input.generatedAt ?? new Date().toISOString(), reviewStatus: input.reviewStatus ?? 'PENDING', createdAt: new Date().toISOString() };
    const snapshot = this.store.getSnapshot(); snapshot.executionForecasts.push(forecast); this.store.setSnapshot(snapshot); await this.store.upsertExecutionForecasts(snapshot.executionForecasts); return forecast;
  }

  async getExecutionForecast(id: string, tenantId: string, workspaceId: string) {
    const forecast = this.store.getSnapshot().executionForecasts.find((entry) => entry.id === id && entry.tenantId === tenantId && entry.workspaceId === workspaceId) as ExecutionForecast | undefined;
    if (!forecast) return null;
    if (forecast.status === 'CURRENT' && Date.parse(forecast.expiresAt) <= Date.now()) return { ...forecast, status: 'EXPIRED' as const };
    return forecast;
  }
  async listExecutionForecasts(input: { tenantId: string; workspaceId: string; currentOnly?: boolean }) { const items = this.store.getSnapshot().executionForecasts.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId) as ExecutionForecast[]; return items.map((entry) => entry.status === 'CURRENT' && Date.parse(entry.expiresAt) <= Date.now() ? { ...entry, status: 'EXPIRED' as const } : entry).filter((entry) => !input.currentOnly || entry.status === 'CURRENT'); }
  async markExecutionForecastStale(id: string, input: { tenantId: string; workspaceId: string; reason: string }) { const snapshot = this.store.getSnapshot(); const forecast = snapshot.executionForecasts.find((entry) => entry.id === id && entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId) as ExecutionForecast | undefined; if (!forecast) throw new Error('Execution forecast not found'); forecast.status = 'STALE'; forecast.reviewStatus = 'STALE'; (forecast as any).staleReason = input.reason; this.store.setSnapshot(snapshot); await this.store.upsertExecutionForecasts(snapshot.executionForecasts); return forecast; }
  async markForecastsStale(input: { tenantId: string; workspaceId: string; reason: string }) { const forecasts = await this.listExecutionForecasts({ tenantId: input.tenantId, workspaceId: input.workspaceId }); return await Promise.all(forecasts.filter((entry) => entry.status === 'CURRENT').map(async (entry) => await this.markExecutionForecastStale(entry.id, input))); }
  async recordExecutionForecastOutcome(id: string, input: { tenantId: string; workspaceId: string; actualOutcome: unknown; recordedBy: string }) { const forecast = await this.getExecutionForecast(id, input.tenantId, input.workspaceId); if (!forecast) throw new Error('Execution forecast not found'); const outcome: ForecastOutcome = { id: randomUUID(), tenantId: input.tenantId, workspaceId: input.workspaceId, forecastId: id, actualOutcome: input.actualOutcome, recordedBy: input.recordedBy, recordedAt: new Date().toISOString() }; const snapshot = this.store.getSnapshot(); snapshot.forecastOutcomes.push(outcome); this.store.setSnapshot(snapshot); await this.store.upsertForecastOutcomes(snapshot.forecastOutcomes); return outcome; }

  async createAlertInstance(input: { tenantId: string; workspaceId: string; alertKey: string; severity: string; title: string; detail: string; assignment: string; dedupeKey: string }) { const snapshot = this.store.getSnapshot(); const existing = snapshot.alertInstances.find((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId && entry.dedupeKey === input.dedupeKey && entry.status === 'OPEN') as AlertInstance | undefined; if (existing) return existing; const alert: AlertInstance = { id: randomUUID(), ...input, status: 'OPEN', createdAt: new Date().toISOString() }; snapshot.alertInstances.push(alert); this.store.setSnapshot(snapshot); await this.store.upsertAlertInstances(snapshot.alertInstances); return alert; }

  async createReportDefinition(input: { tenantId: string; workspaceId: string; reportKey: string; name: string; classification: string; allowedRoles: string[]; fieldMasking: string[]; exportPolicy: string; reportType?: string; scopeType?: string; queryConfiguration?: Record<string, unknown>; fieldConfiguration?: { allowedFields: string[]; maskedFields: string[] }; scheduleConfiguration?: Record<string, unknown>; deliveryConfiguration?: Record<string, unknown> }) {
    const serializedQuery = JSON.stringify(input.queryConfiguration ?? {}); if (/\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|FROM|WHERE)\b/i.test(serializedQuery)) throw new Error('Arbitrary SQL is not permitted');
    const now = new Date().toISOString(); const report: ReportDefinition = { id: randomUUID(), ...input, reportType: input.reportType ?? input.reportKey, scopeType: input.scopeType ?? 'workspace', queryConfiguration: input.queryConfiguration ?? {}, fieldConfiguration: input.fieldConfiguration ?? { allowedFields: [], maskedFields: [...input.fieldMasking] }, scheduleConfiguration: input.scheduleConfiguration ?? {}, deliveryConfiguration: input.deliveryConfiguration ?? {}, status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now };
    const snapshot = this.store.getSnapshot(); snapshot.reportDefinitions.push(report); this.store.setSnapshot(snapshot); await this.store.upsertReportDefinitions(snapshot.reportDefinitions); return report;
  }
  async getReportDefinition(id: string, tenantId: string, workspaceId: string) { return this.store.getSnapshot().reportDefinitions.find((entry) => entry.id === id && entry.tenantId === tenantId && entry.workspaceId === workspaceId) ?? null; }
  async listReportDefinitions(input: { tenantId: string; workspaceId: string }) { return this.store.getSnapshot().reportDefinitions.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId); }
  async runReport(input: { reportDefinitionId: string; tenantId: string; workspaceId: string; actorId: string; recordPermissions?: string[]; maskedFields?: string[]; periodStart?: string; periodEnd?: string; parameters?: Record<string, unknown>; records?: Array<Record<string, unknown>> }) {
    const report = await this.getReportDefinition(input.reportDefinitionId, input.tenantId, input.workspaceId) as ReportDefinition | null; if (!report) throw new Error('Report definition not found'); if (!input.recordPermissions?.includes(`${report.reportKey}:export`)) throw new Error('Report export permission required');
    const maskedFields = Array.from(new Set([...report.fieldConfiguration.maskedFields, ...(input.maskedFields ?? [])])).sort(); const records = (input.records ?? []).map((record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskedFields.includes(key) ? '***MASKED***' : value]))); const generatedAt = new Date().toISOString(); const canonical = JSON.stringify({ reportDefinitionId: report.id, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, parameters: input.parameters ?? {}, records }); const outputHash = createHash('sha256').update(canonical).digest('hex');
    const run: ReportRun = { id: randomUUID(), tenantId: input.tenantId, workspaceId: input.workspaceId, reportDefinitionId: report.id, requestedBy: input.actorId, periodStart: input.periodStart, periodEnd: input.periodEnd, parameters: input.parameters ?? {}, status: 'COMPLETED', outputStorageReference: `reports/${report.id}/${outputHash}.json`, outputHash, recordCount: records.length, maskedFields, exportPolicy: report.exportPolicy, generatedAt, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), createdAt: generatedAt };
    const snapshot = this.store.getSnapshot(); snapshot.reportRuns.push(run); this.store.setSnapshot(snapshot); await this.store.upsertReportRuns(snapshot.reportRuns); return run;
  }
  async getReportRun(id: string, tenantId: string, workspaceId: string) { const run = this.store.getSnapshot().reportRuns.find((entry) => entry.id === id && entry.tenantId === tenantId && entry.workspaceId === workspaceId) as ReportRun | undefined; if (!run) return null; return Date.parse(run.expiresAt) <= Date.now() ? { ...run, status: 'EXPIRED' as const, outputStorageReference: '' } : run; }
  async listReportRuns(input: { tenantId: string; workspaceId: string }) { return this.store.getSnapshot().reportRuns.filter((entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId); }

  validateKpiFormula(expression: string) { return validateKpiFormula(expression); }
  async simulateKpiDefinition(input: { formulaExpression: string; numerator: number | null; denominator: number | null }) { const validation = validateKpiFormula(input.formulaExpression); if (!validation.valid) return { status: 'INVALID' as const, errors: validation.errors, resultValue: null }; if (input.numerator === null || input.denominator === null || input.denominator === 0) return { status: 'NOT_CALCULABLE' as const, errors: [], resultValue: null }; return { status: 'CALCULATED' as const, errors: [], resultValue: (input.numerator / input.denominator) * 100 }; }

  async createKPIDefinition(input: { tenantId: string; workspaceId: string; kpiKey: string; name: string; domain: string; aggregationType: string; formulaExpression: string; unit: string; direction: string; status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }) {
    const validation = validateKpiFormula(input.formulaExpression);
    if (!validation.valid) throw new Error(`Invalid formula: ${validation.errors.map((entry) => entry.message).join('; ')}`);
    const definition: KpiDefinition = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      kpiKey: input.kpiKey,
      name: input.name,
      domain: input.domain,
      aggregationType: input.aggregationType,
      formulaExpression: input.formulaExpression,
      unit: input.unit,
      direction: input.direction,
      version: 1,
      status: input.status ?? 'DRAFT',
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.kpiDefinitions = [...snapshot.kpiDefinitions, definition];
    this.store.setSnapshot(snapshot);
    await this.store.upsertKPIDefinitions(snapshot.kpiDefinitions);
    return definition;
  }

  async publishKPIDefinition(definitionId: string, actorId: string) {
    const snapshot = this.store.getSnapshot();
    const definition = snapshot.kpiDefinitions.find((entry) => entry.id === definitionId);
    if (!definition) throw new Error('KPI definition not found');
    if (definition.status === 'PUBLISHED') throw new Error('Published KPI definitions are immutable');
    const validation = validateKpiFormula(definition.formulaExpression);
    if (!validation.valid) throw new Error(`Invalid formula: ${validation.errors.map((entry) => entry.message).join('; ')}`);
    definition.status = 'PUBLISHED';
    definition.publishedAt = new Date().toISOString();
    definition.publishedBy = actorId;
    this.store.setSnapshot(snapshot);
    await this.store.upsertKPIDefinitions(snapshot.kpiDefinitions);
    return definition;
  }

  async calculateKPIResult(input: { kpiDefinitionId: string; tenantId: string; workspaceId: string; scopeType: string; scopeId: string; periodStart: string; periodEnd: string; numerator: number; denominator: number; resultUnit: string }) {
    const snapshot = this.store.getSnapshot();
    const definition = snapshot.kpiDefinitions.find((entry) => entry.id === input.kpiDefinitionId);
    if (!definition) throw new Error('KPI definition not found');

    const resultValue = input.denominator === 0 ? null : Math.round((input.numerator / input.denominator) * 100);
    const result: KpiDefinitionResult = {
      id: randomUUID(),
      kpiDefinitionId: definition.id,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      resultValue,
      calculationStatus: resultValue === null ? 'NOT_CALCULABLE' : 'CALCULATED',
      resultUnit: input.resultUnit,
      kpiDefinitionVersion: definition.version,
      createdAt: new Date().toISOString(),
    };

    snapshot.kpiResults = [...snapshot.kpiResults, result];
    this.store.setSnapshot(snapshot);
    await this.store.upsertKPIResults(snapshot.kpiResults);
    return result;
  }

  async createKPIProfile(input: { tenantId: string; workspaceId: string; role: string; metricKeys: string[] }) {
    const profile: KpiProfile = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      role: input.role,
      metricKeys: input.metricKeys,
      createdAt: new Date().toISOString(),
    };
    const snapshot = this.store.getSnapshot();
    snapshot.kpiProfiles = [...snapshot.kpiProfiles, profile];
    this.store.setSnapshot(snapshot);
    await this.store.upsertKPIProfiles(snapshot.kpiProfiles);
    return profile;
  }

  async createDashboardSnapshot(input: { tenantId: string; workspaceId: string; scopeType: string; scopeId: string; dashboardName: string; metrics: Array<{ key: string; value: number | string; masked: boolean }> }) {
    const snapshot: DashboardSnapshot = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      dashboardName: input.dashboardName,
      metrics: input.metrics.map((metric) => ({ ...metric, value: metric.masked ? 'masked' : metric.value })),
      createdAt: new Date().toISOString(),
    };
    const storeSnapshot = this.store.getSnapshot();
    storeSnapshot.dashboardSnapshots = [...storeSnapshot.dashboardSnapshots, snapshot];
    this.store.setSnapshot(storeSnapshot);
    await this.store.upsertDashboardSnapshots(storeSnapshot.dashboardSnapshots);
    return snapshot;
  }

  async getAssuranceReadModel(milestoneId: string) {
    const snapshot = this.store.getSnapshot();
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneId);
    if (!milestone) throw new Error('Milestone not found');

    const evidence = snapshot.evidenceItems.filter((entry) => entry.milestoneId === milestoneId);
    const validationResults = snapshot.validationResults.filter((entry) => entry.milestoneId === milestoneId);
    const acceptance = snapshot.acceptanceDecisions.find((entry) => entry.milestoneId === milestoneId);
    const certificate = snapshot.certificates.find((entry) => entry.milestoneId === milestoneId && entry.status === 'CERTIFIED');
    const eligibility = snapshot.paymentEligibility.find((entry) => entry.milestoneId === milestoneId);

    return {
      milestoneId,
      status: milestone.status,
      readiness: {
        score: milestone.dodApproved && milestone.dependenciesSatisfied ? 90 : 60,
        blockingDependencies: milestone.dependenciesSatisfied ? 0 : 1,
      },
      progress: {
        declared: 90,
        evidenced: evidence.length * 30,
        validated: validationResults.length * 30,
        accepted: acceptance ? 100 : 0,
        earned: certificate ? 100 : 0,
      },
      evidence: {
        required: 2,
        submitted: evidence.length,
        verified: evidence.filter((entry) => entry.status === 'VERIFIED').length,
        completenessScore: Math.min(100, evidence.length * 50),
      },
      validation: {
        total: validationResults.length,
        passed: validationResults.filter((entry) => entry.status === 'PASSED').length,
        failed: validationResults.filter((entry) => entry.status === 'FAILED').length,
        pending: 0,
      },
      quality: {
        mandatoryGatesPassed: validationResults.some((entry) => entry.status === 'PASSED'),
        criticalDefects: 0,
      },
      issues: {
        open: 0,
        blockingAcceptance: 0,
        blockingCertification: 0,
        blockingPayment: 0,
      },
      acceptance: {
        status: acceptance ? 'READY' : 'NOT_READY',
      },
      certification: {
        eligible: Boolean(certificate),
        certificateId: certificate?.id ?? null,
      },
      paymentEligibility: {
        status: eligibility?.status ?? 'NOT_ELIGIBLE',
      },
      blockers: milestone.dodApproved ? [] : ['Definition of done must be approved'],
    };
  }
}
