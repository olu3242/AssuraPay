import type { AssuraRepository, Snapshot } from './index';
import type { SqlClient } from './postgres-client';
import { currentTrustScope, isTenantScoped } from './trust-scope';

export const DOMAIN_AGGREGATE_OWNERSHIP = Object.freeze([
  'workspaces', 'organizations', 'contracts', 'blueprints', 'milestones', 'dodPackages',
  'evidenceItems', 'validationResults', 'acceptanceDecisions', 'certificates',
  'paymentEligibility', 'settlementCases', 'financialEntitlements', 'invoices',
  'fundingCommitments', 'releaseRequests', 'paymentInstructions', 'ledgerEntries',
  'assuranceScores', 'checkpoints', 'rebuildJobs', 'kpiDefinitions', 'kpiResults',
  'kpiProfiles', 'executiveDashboards', 'dashboardSnapshots', 'governedAiReviews',
  'projectionCheckpoints', 'projectionRebuildJobs', 'projections', 'executionForecasts',
  'forecastOutcomes', 'alertInstances', 'reportDefinitions', 'reportRuns',
] as const satisfies readonly (keyof Snapshot)[]);

type DomainCollection = (typeof DOMAIN_AGGREGATE_OWNERSHIP)[number];

export class DomainStoreScopeError extends Error {
  readonly code = 'DOMAIN_STORE_SCOPE_REQUIRED';
  constructor() {
    super('DOMAIN_STORE_SCOPE_REQUIRED: domain persistence requires an authorized tenant scope');
    this.name = 'DomainStoreScopeError';
  }
}

export class PostgresDomainStore implements AssuraRepository {
  constructor(private readonly sql: SqlClient) {}

  private scope() {
    const scope = currentTrustScope();
    if (!isTenantScoped(scope)) throw new DomainStoreScopeError();
    return scope;
  }

  private async scoped<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
    const scope = this.scope();
    return await this.sql.begin(async (sql) => {
      await sql`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
      await sql`SELECT set_config('app.workspace_id', ${scope.workspaceId ?? ''}, true)`;
      await sql`SELECT set_config('app.actor_id', ${scope.actorId ?? ''}, true)`;
      return await operation(sql);
    });
  }

  async getSnapshot(): Promise<Snapshot> {
    const rows = await this.scoped((sql) => sql<{ collection: DomainCollection; payload: unknown }[]>`
      SELECT collection, payload FROM domain_records ORDER BY collection, record_id
    `);
    const snapshot = Object.fromEntries(
      DOMAIN_AGGREGATE_OWNERSHIP.map((key) => [key, []]),
    ) as unknown as Snapshot;
    for (const row of rows) snapshot[row.collection].push(row.payload);
    return structuredClone(snapshot);
  }

  async setSnapshot(snapshot: Partial<Snapshot>): Promise<void> {
    await this.scoped(async (sql) => {
      for (const collection of DOMAIN_AGGREGATE_OWNERSHIP) {
        if (snapshot[collection] === undefined) continue;
        await this.replaceCollection(sql, collection, snapshot[collection] ?? []);
      }
    });
  }

  private async replace(collection: DomainCollection, items: any[]): Promise<void> {
    await this.scoped((sql) => this.replaceCollection(sql, collection, items));
  }

  private async replaceCollection(sql: SqlClient, collection: DomainCollection, items: any[]) {
    const scope = this.scope();
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || item.tenantId !== scope.tenantId)
        throw new DomainStoreScopeError();
      if (scope.workspaceId && item.workspaceId && item.workspaceId !== scope.workspaceId)
        throw new DomainStoreScopeError();
    }
    await sql`DELETE FROM domain_records WHERE collection = ${collection}`;
    for (const item of items) await sql`
      INSERT INTO domain_records (tenant_id, workspace_id, collection, record_id, payload, version)
      VALUES (${scope.tenantId}, ${item.workspaceId ?? scope.workspaceId ?? null}, ${collection}, ${item.id}, ${sql.json(item)}, 1)
    `;
  }

  async upsertWorkspaces(v: any[]) { await this.replace('workspaces', v); }
  async upsertOrganizations(v: any[]) { await this.replace('organizations', v); }
  async upsertContracts(v: any[]) { await this.replace('contracts', v); }
  async upsertBlueprints(v: any[]) { await this.replace('blueprints', v); }
  async upsertMilestones(v: any[]) { await this.replace('milestones', v); }
  async upsertDodPackages(v: any[]) { await this.replace('dodPackages', v); }
  async upsertEvidence(v: any[]) { await this.replace('evidenceItems', v); }
  async upsertValidation(v: any[]) { await this.replace('validationResults', v); }
  async upsertAcceptance(v: any[]) { await this.replace('acceptanceDecisions', v); }
  async upsertCertificates(v: any[]) { await this.replace('certificates', v); }
  async upsertPaymentEligibility(v: any[]) { await this.replace('paymentEligibility', v); }
  async upsertSettlementCases(v: any[]) { await this.replace('settlementCases', v); }
  async upsertFinancialEntitlements(v: any[]) { await this.replace('financialEntitlements', v); }
  async upsertInvoices(v: any[]) { await this.replace('invoices', v); }
  async upsertFundingCommitments(v: any[]) { await this.replace('fundingCommitments', v); }
  async upsertReleaseRequests(v: any[]) { await this.replace('releaseRequests', v); }
  async upsertPaymentInstructions(v: any[]) { await this.replace('paymentInstructions', v); }
  async upsertLedgerEntries(v: any[]) { await this.replace('ledgerEntries', v); }
  async upsertAssuranceScores(v: any[]) { await this.replace('assuranceScores', v); }
  async upsertCheckpoints(v: any[]) { await this.replace('checkpoints', v); }
  async upsertRebuildJobs(v: any[]) { await this.replace('rebuildJobs', v); }
  async upsertKPIDefinitions(v: any[]) { await this.replace('kpiDefinitions', v); }
  async upsertKPIResults(v: any[]) { await this.replace('kpiResults', v); }
  async upsertKpiResults(v: any[]) { await this.replace('kpiResults', v); }
  async upsertKPIProfiles(v: any[]) { await this.replace('kpiProfiles', v); }
  async upsertExecutiveDashboards(v: any[]) { await this.replace('executiveDashboards', v); }
  async upsertDashboardSnapshots(v: any[]) { await this.replace('dashboardSnapshots', v); }
  async upsertGovernedAiReviews(v: any[]) { await this.replace('governedAiReviews', v); }
  async upsertProjectionCheckpoints(v: any[]) { await this.replace('projectionCheckpoints', v); }
  async upsertProjectionRebuildJobs(v: any[]) { await this.replace('projectionRebuildJobs', v); }
  async upsertProjections(v: any[]) { await this.replace('projections', v); }
  async upsertExecutionForecasts(v: any[]) { await this.replace('executionForecasts', v); }
  async upsertForecastOutcomes(v: any[]) { await this.replace('forecastOutcomes', v); }
  async upsertAlertInstances(v: any[]) { await this.replace('alertInstances', v); }
  async upsertReportDefinitions(v: any[]) { await this.replace('reportDefinitions', v); }
  async upsertReportRuns(v: any[]) { await this.replace('reportRuns', v); }
}
