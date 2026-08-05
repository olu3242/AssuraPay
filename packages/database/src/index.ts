import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.resolve(process.cwd(), 'apps/web/data/assurapay.json');

export type Snapshot = {
  workspaces: any[];
  organizations: any[];
  contracts: any[];
  blueprints: any[];
  milestones: any[];
  dodPackages: any[];
  evidenceItems: any[];
  validationResults: any[];
  acceptanceDecisions: any[];
  certificates: any[];
  paymentEligibility: any[];
  settlementCases: any[];
  financialEntitlements: any[];
  invoices: any[];
  fundingCommitments: any[];
  releaseRequests: any[];
  paymentInstructions: any[];
  ledgerEntries: any[];
  assuranceScores: any[];
  checkpoints: any[];
  rebuildJobs: any[];
  kpiDefinitions: any[];
  kpiResults: any[];
  kpiProfiles: any[];
  executiveDashboards: any[];
  dashboardSnapshots: any[];
  governedAiReviews: any[];
  projectionCheckpoints: any[];
  projectionRebuildJobs: any[];
  projections: any[];
  executionForecasts: any[];
  forecastOutcomes: any[];
  alertInstances: any[];
  reportDefinitions: any[];
  reportRuns: any[];
};

const emptySnapshot: Snapshot = {
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
  assuranceScores: [],
  checkpoints: [],
  rebuildJobs: [],
  kpiDefinitions: [],
  kpiResults: [],
  kpiProfiles: [],
  executiveDashboards: [],
  dashboardSnapshots: [],
  governedAiReviews: [],
  projectionCheckpoints: [], projectionRebuildJobs: [], projections: [],
  executionForecasts: [], forecastOutcomes: [], alertInstances: [],
  reportDefinitions: [], reportRuns: [],
};

function normalizeSnapshot(snapshot: Partial<Snapshot> = {}): Snapshot {
  return {
    workspaces: snapshot.workspaces ?? [],
    organizations: snapshot.organizations ?? [],
    contracts: snapshot.contracts ?? [],
    blueprints: snapshot.blueprints ?? [],
    milestones: snapshot.milestones ?? [],
    dodPackages: snapshot.dodPackages ?? [],
    evidenceItems: snapshot.evidenceItems ?? [],
    validationResults: snapshot.validationResults ?? [],
    acceptanceDecisions: snapshot.acceptanceDecisions ?? [],
    certificates: snapshot.certificates ?? [],
    paymentEligibility: snapshot.paymentEligibility ?? [],
    settlementCases: snapshot.settlementCases ?? [],
    financialEntitlements: snapshot.financialEntitlements ?? [],
    invoices: snapshot.invoices ?? [],
    fundingCommitments: snapshot.fundingCommitments ?? [],
    releaseRequests: snapshot.releaseRequests ?? [],
    paymentInstructions: snapshot.paymentInstructions ?? [],
    ledgerEntries: snapshot.ledgerEntries ?? [],
    assuranceScores: snapshot.assuranceScores ?? [],
    checkpoints: snapshot.checkpoints ?? [],
    rebuildJobs: snapshot.rebuildJobs ?? [],
    kpiDefinitions: snapshot.kpiDefinitions ?? [],
    kpiResults: snapshot.kpiResults ?? [],
    kpiProfiles: snapshot.kpiProfiles ?? [],
    executiveDashboards: snapshot.executiveDashboards ?? [],
    dashboardSnapshots: snapshot.dashboardSnapshots ?? [],
    governedAiReviews: snapshot.governedAiReviews ?? [],
    projectionCheckpoints: snapshot.projectionCheckpoints ?? [],
    projectionRebuildJobs: snapshot.projectionRebuildJobs ?? [],
    projections: snapshot.projections ?? [],
    executionForecasts: snapshot.executionForecasts ?? [],
    forecastOutcomes: snapshot.forecastOutcomes ?? [],
    alertInstances: snapshot.alertInstances ?? [],
    reportDefinitions: snapshot.reportDefinitions ?? [],
    reportRuns: snapshot.reportRuns ?? [],
  };
}

export interface AssuraRepository {
  getSnapshot(): Snapshot;
  setSnapshot(snapshot: Partial<Snapshot>): void;
  upsertWorkspaces(items: any[]): Promise<void>;
  upsertOrganizations(items: any[]): Promise<void>;
  upsertContracts(items: any[]): Promise<void>;
  upsertBlueprints(items: any[]): Promise<void>;
  upsertMilestones(items: any[]): Promise<void>;
  upsertDodPackages(items: any[]): Promise<void>;
  upsertEvidence(items: any[]): Promise<void>;
  upsertValidation(items: any[]): Promise<void>;
  upsertAcceptance(items: any[]): Promise<void>;
  upsertCertificates(items: any[]): Promise<void>;
  upsertPaymentEligibility(items: any[]): Promise<void>;
  upsertSettlementCases(items: any[]): Promise<void>;
  upsertFinancialEntitlements(items: any[]): Promise<void>;
  upsertInvoices(items: any[]): Promise<void>;
  upsertFundingCommitments(items: any[]): Promise<void>;
  upsertReleaseRequests(items: any[]): Promise<void>;
  upsertPaymentInstructions(items: any[]): Promise<void>;
  upsertLedgerEntries(items: any[]): Promise<void>;
  upsertAssuranceScores(items: any[]): Promise<void>;
  upsertCheckpoints(items: any[]): Promise<void>;
  upsertRebuildJobs(items: any[]): Promise<void>;
  upsertKPIDefinitions(items: any[]): Promise<void>;
  upsertKPIResults(items: any[]): Promise<void>;
  upsertKpiResults(items: any[]): Promise<void>;
  upsertKPIProfiles(items: any[]): Promise<void>;
  upsertExecutiveDashboards(items: any[]): Promise<void>;
  upsertDashboardSnapshots(items: any[]): Promise<void>;
  upsertGovernedAiReviews(items: any[]): Promise<void>;
  upsertProjectionCheckpoints(items: any[]): Promise<void>;
  upsertProjectionRebuildJobs(items: any[]): Promise<void>;
  upsertProjections(items: any[]): Promise<void>;
  upsertExecutionForecasts(items: any[]): Promise<void>;
  upsertForecastOutcomes(items: any[]): Promise<void>;
  upsertAlertInstances(items: any[]): Promise<void>;
  upsertReportDefinitions(items: any[]): Promise<void>;
  upsertReportRuns(items: any[]): Promise<void>;
}

export class FileAssuraStore implements AssuraRepository {
  private snapshot: Snapshot;

  constructor(snapshot: Snapshot = emptySnapshot) {
    this.snapshot = normalizeSnapshot(snapshot);
  }

  static async load(): Promise<FileAssuraStore> {
    if (process.env.VITEST) return new FileAssuraStore(emptySnapshot);
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Snapshot;
      return new FileAssuraStore(parsed);
    } catch {
      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
      await fs.writeFile(DATA_FILE, JSON.stringify(emptySnapshot, null, 2));
      return new FileAssuraStore(emptySnapshot);
    }
  }

  async save(): Promise<void> {
    if (process.env.VITEST) return;
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(this.snapshot, null, 2));
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  setSnapshot(snapshot: Partial<Snapshot>): void {
    this.snapshot = normalizeSnapshot(snapshot);
  }

  async upsertWorkspaces(items: any[]): Promise<void> {
    this.snapshot.workspaces = items;
    await this.save();
  }

  async upsertOrganizations(items: any[]): Promise<void> {
    this.snapshot.organizations = items;
    await this.save();
  }

  async upsertContracts(items: any[]): Promise<void> {
    this.snapshot.contracts = items;
    await this.save();
  }

  async upsertBlueprints(items: any[]): Promise<void> {
    this.snapshot.blueprints = items;
    await this.save();
  }

  async upsertMilestones(items: any[]): Promise<void> {
    this.snapshot.milestones = items;
    await this.save();
  }

  async upsertDodPackages(items: any[]): Promise<void> {
    this.snapshot.dodPackages = items;
    await this.save();
  }

  async upsertEvidence(items: any[]): Promise<void> {
    this.snapshot.evidenceItems = items;
    await this.save();
  }

  async upsertValidation(items: any[]): Promise<void> {
    this.snapshot.validationResults = items;
    await this.save();
  }

  async upsertAcceptance(items: any[]): Promise<void> {
    this.snapshot.acceptanceDecisions = items;
    await this.save();
  }

  async upsertCertificates(items: any[]): Promise<void> {
    this.snapshot.certificates = items;
    await this.save();
  }

  async upsertPaymentEligibility(items: any[]): Promise<void> {
    this.snapshot.paymentEligibility = items;
    await this.save();
  }

  async upsertSettlementCases(items: any[]): Promise<void> {
    this.snapshot.settlementCases = items;
    await this.save();
  }

  async upsertFinancialEntitlements(items: any[]): Promise<void> {
    this.snapshot.financialEntitlements = items;
    await this.save();
  }

  async upsertInvoices(items: any[]): Promise<void> {
    this.snapshot.invoices = items;
    await this.save();
  }

  async upsertFundingCommitments(items: any[]): Promise<void> {
    this.snapshot.fundingCommitments = items;
    await this.save();
  }

  async upsertReleaseRequests(items: any[]): Promise<void> {
    this.snapshot.releaseRequests = items;
    await this.save();
  }

  async upsertPaymentInstructions(items: any[]): Promise<void> {
    this.snapshot.paymentInstructions = items;
    await this.save();
  }

  async upsertLedgerEntries(items: any[]): Promise<void> {
    this.snapshot.ledgerEntries = items;
    await this.save();
  }

  async upsertAssuranceScores(items: any[]): Promise<void> {
    this.snapshot.assuranceScores = items;
    await this.save();
  }

  async upsertCheckpoints(items: any[]): Promise<void> {
    this.snapshot.checkpoints = items;
    await this.save();
  }

  async upsertRebuildJobs(items: any[]): Promise<void> {
    this.snapshot.rebuildJobs = items;
    await this.save();
  }

  async upsertKPIDefinitions(items: any[]): Promise<void> {
    this.snapshot.kpiDefinitions = items;
    await this.save();
  }

  async upsertKPIResults(items: any[]): Promise<void> {
    this.snapshot.kpiResults = items;
    await this.save();
  }

  async upsertKpiResults(items: any[]): Promise<void> {
    this.snapshot.kpiResults = items;
    await this.save();
  }

  async upsertKPIProfiles(items: any[]): Promise<void> {
    this.snapshot.kpiProfiles = items;
    await this.save();
  }

  async upsertExecutiveDashboards(items: any[]): Promise<void> {
    this.snapshot.executiveDashboards = items;
    await this.save();
  }

  async upsertDashboardSnapshots(items: any[]): Promise<void> {
    this.snapshot.dashboardSnapshots = items;
    await this.save();
  }

  async upsertGovernedAiReviews(items: any[]): Promise<void> {
    this.snapshot.governedAiReviews = items;
    await this.save();
  }

  async upsertProjectionCheckpoints(items: any[]) { this.snapshot.projectionCheckpoints = items; await this.save(); }
  async upsertProjectionRebuildJobs(items: any[]) { this.snapshot.projectionRebuildJobs = items; await this.save(); }
  async upsertProjections(items: any[]) { this.snapshot.projections = items; await this.save(); }
  async upsertExecutionForecasts(items: any[]) { this.snapshot.executionForecasts = items; await this.save(); }
  async upsertForecastOutcomes(items: any[]) { this.snapshot.forecastOutcomes = items; await this.save(); }
  async upsertAlertInstances(items: any[]) { this.snapshot.alertInstances = items; await this.save(); }
  async upsertReportDefinitions(items: any[]) { this.snapshot.reportDefinitions = items; await this.save(); }
  async upsertReportRuns(items: any[]) { this.snapshot.reportRuns = items; await this.save(); }
}
export * from './trust-store';
export * from './conformance';
export * from './postgres-client';
export * from './postgres-store';
export * from './migrations';
