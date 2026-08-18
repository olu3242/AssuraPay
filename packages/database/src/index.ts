import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertDomainStoreAllowed,
  resolveDomainStoreFile,
} from './domain-store-environment';

/**
 * Resolved per call rather than captured at module load.
 *
 * A module-level constant froze whatever `process.cwd()` happened to be when the module was
 * first imported, which is both untestable and wrong: the same build read a different file
 * depending on how the process was started. See `domain-store-environment.ts`.
 */
function dataFile(): string {
  return resolveDomainStoreFile();
}

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

/**
 * A snapshot sharing no mutable object with its input.
 *
 * `normalizeSnapshot` fills in missing collections but copies nothing — the arrays in its result
 * are the arrays it was given. So handing its output to a caller still handed over the store's
 * interior, one level down. `structuredClone` is safe on this data because every value
 * originates from `JSON.parse` or a plain domain object; it also preserves `Date` rather than
 * stringifying it, which a JSON round-trip would not.
 */
function detachSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

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

/**
 * The domain persistence contract for Engines 06-60.
 *
 * Asynchronous in every method, for the same reason `TrustPersistence` is. A synchronous
 * `getSnapshot(): Snapshot` cannot be implemented over a network: there is no way to block on
 * I/O in JavaScript, so a relational adapter would have to cache the whole database in memory
 * and return the cache — arrays behind a PostgreSQL adapter, which is not durability. The
 * interface itself was made asynchronous rather than adding a parallel async variant, because
 * two interfaces let call sites keep the synchronous one and a `MaybePromise` union lets a
 * caller forget to await and still compile.
 *
 * `getSnapshot` returns a copy, not the store's own state. It previously returned
 * `this.snapshot` directly, so every caller held a live handle to the store's interior and
 * could mutate persisted state without going through a write method — a change no reader could
 * attribute and no store could refuse.
 */
export interface AssuraRepository {
  getSnapshot(): Promise<Snapshot>;
  setSnapshot(snapshot: Partial<Snapshot>): Promise<void>;
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

  /**
   * Loads the file-backed domain store, or refuses.
   *
   * The refusal is first, before any file is touched. A durable deployment must not end up with
   * a JSON file created as a side effect of discovering it is not allowed to have one.
   */
  static async load(): Promise<FileAssuraStore> {
    assertDomainStoreAllowed();
    if (process.env.VITEST) return new FileAssuraStore(emptySnapshot);
    const file = dataFile();
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Snapshot;
      return new FileAssuraStore(parsed);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(emptySnapshot, null, 2));
      return new FileAssuraStore(emptySnapshot);
    }
  }

  async save(): Promise<void> {
    // Checked on every write, not only at load. A store constructed directly — which tests do,
    // and which a future caller might — would otherwise bypass the gate and write anyway.
    assertDomainStoreAllowed();
    if (process.env.VITEST) return;
    const file = dataFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.snapshot, null, 2));
  }

  async getSnapshot(): Promise<Snapshot> {
    // A detached copy. Returning `this.snapshot` handed every caller a live reference to the
    // store's interior, so a caller could push onto a collection and have it persist on the
    // next unrelated save — a mutation with no write method, no validation and no audit.
    //
    // `normalizeSnapshot` alone is not enough: it builds a new outer object but reuses the same
    // arrays, so `(await store.getSnapshot()).contracts` was still the store's own array.
    return detachSnapshot(this.snapshot);
  }

  async setSnapshot(snapshot: Partial<Snapshot>): Promise<void> {
    // Detached on the way in as well. A caller that kept its argument could otherwise keep
    // editing the store's state after handing it over.
    this.snapshot = detachSnapshot(normalizeSnapshot(snapshot));
    // Persisted, not merely accepted. A write method that returns without durably recording
    // what it was given reports a success the next process restart contradicts.
    await this.save();
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
export * from './trust-scope';
export * from './rls-certification';
export * from './schema-ownership';
export * from './batch-a-repository';
export * from './batch-b-repository';
export * from './batch-c-repository';
export * from './batch-d-repository';
export * from './batch-e-repository';
export * from './batch-f-repository';
export * from './batch-g-repository';
export * from './domain-store-environment';
