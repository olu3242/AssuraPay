/**
 * Generates the Wave 4 aggregate migration manifest from the certification inventory.
 *
 * Batch membership is declared here and cross-checked against the inventory, so a manifest can
 * never name an aggregate the repository does not have — the generator fails instead.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const inventory = JSON.parse(
  readFileSync(path.join(ROOT, 'artifacts/certification/engines-31-50-inventory.json'), 'utf8'),
);
const schema = JSON.parse(
  readFileSync(path.join(ROOT, 'artifacts/certification/engines-31-50-schema-readiness.json'), 'utf8'),
);

const BATCHES = {
  A: {
    title: 'Execution and evidence state',
    complexity: 'MEDIUM',
    financial: false,
    entryGate: 'schema foundation complete for the batch',
    exitGate:
      'live PostgreSQL tests per aggregate, forced RLS, cross-tenant denial proven, backfill idempotent, reconciliation deterministic',
    rollback: 'revert the read source; generic records remain and are not deleted',
    collections: [
      'executionWorkspaces', 'workItems', 'progressRecords', 'evidenceRequirements',
      'evidencePackages', 'validationTests', 'qualityPlans', 'qualityGateResults', 'defects',
      'inspections', 'issueRecords', 'correctiveActionPlans', 'changeRequests', 'changeApprovals',
      'acceptanceDecisions', 'completionCertificates',
    ],
  },
  B: {
    title: 'Entitlement and claim state',
    complexity: 'HIGH',
    financial: true,
    entryGate: 'Batch A certified and the monetary invariant set ratified',
    exitGate: 'money columns bigint minor units with currency, non-negativity enforced, approval separation enforced',
    rollback: 'revert the read source; no generic deletion',
    collections: [
      'paymentEligibilities', 'financialEntitlements', 'invoices', 'releaseRequests',
      'approvalThresholds', 'authorizationDecisions', 'financialApprovalDecisions',
    ],
  },
  C: {
    title: 'Settlement and money movement',
    complexity: 'VERY_HIGH',
    financial: true,
    entryGate: 'Batch B certified and the double-entry enforcement mechanism implemented',
    exitGate: 'balance enforced by the database, journal immutability on the written table, reconciliation uniqueness, non-custody re-certified',
    rollback: 'revert the read source; postings are immutable so rollback never edits history',
    collections: [
      'fundingCommitments', 'fundReservations', 'paymentInstructions', 'ledgerEntries',
      'reconciliationRecords', 'finalSettlementAccounts', 'financialClosureCertificates',
    ],
  },
  D: {
    title: 'Dispute and remediation',
    complexity: 'MEDIUM',
    financial: false,
    entryGate: 'Batches B and C certified, because linkage targets must exist',
    exitGate: 'dispute-to-settlement foreign-key integrity and hold enforcement',
    rollback: 'revert the read source; no generic deletion',
    collections: ['disputes', 'disputeEvidence', 'disputePositions', 'disputeDecisions', 'disputeHolds'],
  },
};

const byCollection = new Map(inventory.collections.map((entry) => [entry.collection, entry]));
const readiness = new Map(schema.results.map((entry) => [entry.collection, entry]));

const declared = Object.values(BATCHES).flatMap((batch) => batch.collections);
const unknown = declared.filter((collection) => !byCollection.has(collection));
if (unknown.length) throw new Error(`manifest names aggregates the repository lacks: ${unknown.join(', ')}`);
const unassigned = inventory.collections
  .map((entry) => entry.collection)
  .filter((collection) => !declared.includes(collection));
if (unassigned.length) throw new Error(`aggregates assigned to no batch: ${unassigned.join(', ')}`);

const manifest = {
  generatedFrom: 'artifacts/certification/engines-31-50-inventory.json',
  authority: 'docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md',
  decisions: {
    monetaryInvariants: 'docs/finance/MONETARY_INVARIANTS.md',
    doubleEntry: 'docs/finance/DOUBLE_ENTRY_POSTING_MODEL.md',
    architecture: 'docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md',
  },
  targetModel: 'relational core plus narrowed versioned JSONB extension envelope',
  migrationStrategy: 'batched one-way backfill with governed read cutover; dual write rejected on the evidence',
  aggregateCount: inventory.collections.length,
  batches: Object.entries(BATCHES).map(([id, batch]) => ({
    batch: id,
    title: batch.title,
    complexity: batch.complexity,
    financial: batch.financial,
    entryGate: batch.entryGate,
    exitGate: batch.exitGate,
    rollback: batch.rollback,
    aggregates: batch.collections.map((collection) => {
      const entry = byCollection.get(collection);
      const ready = readiness.get(collection);
      return {
        collection,
        owningPackages: entry.owningPackages,
        currentTable: entry.physicalTableWritten,
        targetTable: entry.purposeBuiltTable,
        targetTableCreatedBy: entry.purposeBuiltCreatedBy,
        classification: entry.classification,
        exportedType: ready.exportedType,
        typeDeclaredIn: ready.declaredIn,
        zodSchema: ready.zodSchema,
        schemaReadiness: ready.status,
      };
    }),
  })),
};

mkdirSync(path.join(ROOT, 'artifacts/persistence'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'artifacts/persistence/wave-4-aggregate-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  manifest.batches.map((b) => `Batch ${b.batch} (${b.complexity}): ${b.aggregates.length} aggregates`).join('\n'),
);
console.log('total assigned:', manifest.batches.reduce((n, b) => n + b.aggregates.length, 0), 'of', manifest.aggregateCount);
