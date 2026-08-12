import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_F_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_F_AGGREGATES,
  BATCH_F_APPEND_ONLY_COLLECTIONS,
  BATCH_F_CANONICAL_CHAIN_LINKS,
  BATCH_F_CREATED_TABLES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch F persists to its own tables, and the canonical chain closes.
 *
 * The largest batch in `docs/persistence/DURABILITY_GAP_ANALYSIS.md` — fifteen aggregates of canonical
 * Engines 11-15 — and the one that takes the chain census in `durability-coverage.test.ts` from ten of
 * eleven to eleven of eleven. `agreements` is the last link.
 *
 * Three things here that no earlier batch had to prove:
 *
 *   - **Two tables are created rather than converged.** `contract_comments` and `signature_callbacks`
 *     had no relation among the ninety-eight the migrations declared, so a comment on a contract and a
 *     consumed provider callback could not be stored anywhere at all.
 *   - **Four columns are not the snake_case of their field**, and the round-trip has to survive the
 *     mapping in both directions. `agreement_document_versions.version` is the domain's `number`, which
 *     is the sharpest case: the name it does *not* mean is the name three other tables in this batch use
 *     for a revision.
 *   - **The digest chain is a foreign key.** An approval request, the package that signs its document
 *     and the certificate that attests the signature each carry the digest as part of the key, so no
 *     row can name one document and carry another's hash.
 *
 * Every refusal is exercised through a direct statement as well as, or instead of, the store — a store
 * that refuses is not evidence that the database would.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-f';
const OTHER_TENANT = 'tenant-f-other';
const WORKSPACE = 'workspace-f';
const OTHER_WORKSPACE = 'workspace-f-other';
const ACTOR = 'user-counsel';
const APPROVER = 'user-legal';

/** SHA-256 digests. The columns constrain the shape, so these have to be real ones. */
const DOC_HASH = 'a'.repeat(64);
const REVISED_HASH = 'b'.repeat(64);
const TEMPLATE_HASH = 'c'.repeat(64);
const CLAUSE_HASH = 'd'.repeat(64);
const CANONICAL_HASH = 'e'.repeat(64);

const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

/**
 * One migrated database per describe block, created on first use and shared by its tests.
 *
 * Not an optimisation. A database instance holds a connection pool of up to four, and every instance
 * this file creates stays open until `afterAll` — so a database per test meant seventeen pools, up to
 * sixty-eight connections, against a server whose `max_connections` is 100 and which the rest of the
 * suite is also connecting to. That is what made this file fail in CI while passing locally: the same
 * work, on a faster machine, opens more of those connections at once.
 *
 * The cost is that tests within a block share state and therefore run in order. That is the tradeoff
 * Batch E's suite already makes, and where a test here depends on what the one before it did, it says so.
 */
function sharedDatabase(seed?: (database: TestDatabase) => Promise<void>): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () =>
    (pending ??= (async () => {
      const database = await migratedDatabase();
      if (seed) await seed(database);
      return database;
    })());
}

const stamp = '2026-08-11T09:00:00.000Z';

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch F table forces row-level security. */
function raw<T>(
  database: TestDatabase,
  work: (tx: SqlClient) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  return database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return await work(tx);
  });
}

// ---------------------------------------------------------------------------------------
// Records, in the domain's vocabulary — which is not always the column's
// ---------------------------------------------------------------------------------------

const record = {
  agreement: (o: Record<string, unknown> = {}) => ({
    id: 'ag-1',
    workspaceId: WORKSPACE,
    contractNumber: 'AP-2026-1',
    title: 'Vendor Data Agreement',
    contractType: 'DATA',
    ownerUserId: ACTOR,
    status: 'DRAFT',
    createdAt: stamp,
    version: 1,
    ...o,
  }),
  templateVersion: (o: Record<string, unknown> = {}) => ({
    id: 'tv-1',
    workspaceId: WORKSPACE,
    templateKey: 'vendor',
    version: 1,
    variableSchema: [{ key: 'vendor', required: true }],
    contentHash: TEMPLATE_HASH,
    status: 'PUBLISHED',
    createdBy: ACTOR,
    createdAt: stamp,
    ...o,
  }),
  // `number`, not `version` — the column is `version` and the field is not.
  documentVersion: (o: Record<string, unknown> = {}) => ({
    id: 'dv-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    draftId: 'dr-1',
    number: 1,
    contentReference: 'draft/1',
    contentHash: DOC_HASH,
    status: 'DRAFT',
    createdBy: ACTOR,
    createdAt: stamp,
    aiProposed: false,
    ...o,
  }),
  // `documentVersionId`, not `currentDocumentVersionId`.
  contractDraft: (o: Record<string, unknown> = {}) => ({
    id: 'dr-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    templateVersionId: 'tv-1',
    documentVersionId: 'dv-1',
    status: 'WORKING',
    variables: { vendor: 'Fictional Data Ltd' },
    createdBy: ACTOR,
    createdAt: stamp,
    version: 1,
    ...o,
  }),
  contractComment: (o: Record<string, unknown> = {}) => ({
    id: 'cc-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    body: 'Liability cap is below policy; escalate before signature.',
    visibility: 'INTERNAL',
    authorId: ACTOR,
    createdAt: stamp,
    ...o,
  }),
  // `guidance`, not `guidanceReference`.
  clauseVersion: (o: Record<string, unknown> = {}) => ({
    id: 'cv-1',
    workspaceId: WORKSPACE,
    clauseKey: 'liability',
    version: 1,
    bodyHash: CLAUSE_HASH,
    risk: 'HIGH',
    guidance: 'Escalate to general counsel above ₦50m exposure',
    status: 'PUBLISHED',
    createdAt: stamp,
    ...o,
  }),
  clauseInstance: (o: Record<string, unknown> = {}) => ({
    id: 'ci-1',
    workspaceId: WORKSPACE,
    draftId: 'dr-1',
    clauseVersionId: 'cv-1',
    bodyHash: CLAUSE_HASH,
    source: 'LIBRARY',
    createdAt: stamp,
    ...o,
  }),
  clauseDeviation: (o: Record<string, unknown> = {}) => ({
    id: 'cd-1',
    workspaceId: WORKSPACE,
    instanceId: 'ci-1',
    baselineVersionId: 'cv-1',
    risk: 'HIGH',
    summary: 'Liability cap reduced to 50% of fees',
    status: 'PENDING',
    createdAt: stamp,
    ...o,
  }),
  // `number`, not `roundNumber`.
  negotiationRound: (o: Record<string, unknown> = {}) => ({
    id: 'nr-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    number: 1,
    submittedBy: ACTOR,
    documentVersionId: 'dv-1',
    status: 'SUBMITTED',
    mandatoryOpenItems: ['liability'],
    createdAt: stamp,
    ...o,
  }),
  approvalPolicy: (o: Record<string, unknown> = {}) => ({
    id: 'ap-1',
    workspaceId: WORKSPACE,
    version: 1,
    steps: [{ role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' }],
    status: 'PUBLISHED',
    createdAt: stamp,
    ...o,
  }),
  approvalRequest: (o: Record<string, unknown> = {}) => ({
    id: 'ar-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    documentVersionId: 'dv-1',
    documentHash: DOC_HASH,
    policyId: 'ap-1',
    requesterId: ACTOR,
    status: 'PENDING',
    completedSteps: 0,
    createdAt: stamp,
    ...o,
  }),
  approvalDecision: (o: Record<string, unknown> = {}) => ({
    id: 'ad-1',
    workspaceId: WORKSPACE,
    requestId: 'ar-1',
    step: 0,
    approverId: APPROVER,
    decision: 'APPROVE',
    conditions: [],
    createdAt: stamp,
    ...o,
  }),
  signaturePackage: (o: Record<string, unknown> = {}) => ({
    id: 'sp-1',
    workspaceId: WORKSPACE,
    contractId: 'ag-1',
    approvalRequestId: 'ar-1',
    documentVersionId: 'dv-1',
    documentHash: DOC_HASH,
    signers: [
      { userId: 'signer-1', authorityReference: 'board-resolution-14', witnessRequired: false },
    ],
    status: 'SENT',
    providerKey: 'sandbox',
    createdAt: stamp,
    ...o,
  }),
  signatureCallback: (o: Record<string, unknown> = {}) => ({
    id: 'sc-1',
    workspaceId: WORKSPACE,
    eventId: 'evt_9f2',
    createdAt: stamp,
    ...o,
  }),
  executionCertificate: (o: Record<string, unknown> = {}) => ({
    id: 'ec-1',
    workspaceId: WORKSPACE,
    packageId: 'sp-1',
    contractId: 'ag-1',
    documentHash: DOC_HASH,
    canonicalHash: CANONICAL_HASH,
    status: 'VALID',
    issuedAt: stamp,
    ...o,
  }),
};

/**
 * The whole agreement, through the production store, in foreign-key order.
 *
 * Written as one function rather than per-test fixtures because the order *is* part of what is being
 * certified: the digest-carrying foreign keys mean a package cannot precede its approval request, and an
 * approval request cannot precede the document version whose hash it carries.
 */
async function executeAgreement(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    const k = (base: string) => `${base}${suffix}`;
    const scope = { workspaceId };
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append(
      'agreements',
      record.agreement({ id: k('ag-1'), ...scope, contractNumber: `AP-2026-1${suffix}` }),
    );
    await store.append('templateVersions', record.templateVersion({ id: k('tv-1'), ...scope }));
    await store.append(
      'documentVersions',
      record.documentVersion({ id: k('dv-1'), ...scope, contractId: k('ag-1'), draftId: k('dr-1') }),
    );
    await store.append(
      'contractDrafts',
      record.contractDraft({
        id: k('dr-1'),
        ...scope,
        contractId: k('ag-1'),
        templateVersionId: k('tv-1'),
        documentVersionId: k('dv-1'),
      }),
    );
    await store.append(
      'contractComments',
      record.contractComment({ id: k('cc-1'), ...scope, contractId: k('ag-1') }),
    );
    await store.append('clauseVersions', record.clauseVersion({ id: k('cv-1'), ...scope }));
    await store.append(
      'clauseInstances',
      record.clauseInstance({
        id: k('ci-1'),
        ...scope,
        draftId: k('dr-1'),
        clauseVersionId: k('cv-1'),
      }),
    );
    await store.append(
      'clauseDeviations',
      record.clauseDeviation({
        id: k('cd-1'),
        ...scope,
        instanceId: k('ci-1'),
        baselineVersionId: k('cv-1'),
      }),
    );
    await store.append(
      'negotiationRounds',
      record.negotiationRound({
        id: k('nr-1'),
        ...scope,
        contractId: k('ag-1'),
        documentVersionId: k('dv-1'),
      }),
    );
    await store.append('approvalPolicies', record.approvalPolicy({ id: k('ap-1'), ...scope }));
    await store.append(
      'approvalRequests',
      record.approvalRequest({
        id: k('ar-1'),
        ...scope,
        contractId: k('ag-1'),
        documentVersionId: k('dv-1'),
        policyId: k('ap-1'),
      }),
    );
    await store.append(
      'approvalDecisions',
      record.approvalDecision({ id: k('ad-1'), ...scope, requestId: k('ar-1') }),
    );
    await store.append(
      'signaturePackages',
      record.signaturePackage({
        id: k('sp-1'),
        ...scope,
        contractId: k('ag-1'),
        approvalRequestId: k('ar-1'),
        documentVersionId: k('dv-1'),
      }),
    );
    await store.append(
      'signatureCallbacks',
      record.signatureCallback({ id: k('sc-1'), ...scope }),
    );
    await store.append(
      'agreementExecutionCertificates',
      record.executionCertificate({
        id: k('ec-1'),
        ...scope,
        packageId: k('sp-1'),
        contractId: k('ag-1'),
      }),
    );
  });
}

describe('integration: Batch F is activated and the canonical chain closes', () => {
  // Read-only against the migrated schema, so one database serves every test that needs one. The
  // populated-table refusal below builds its own, because it applies a partial migration set.
  const schemaOnly = sharedDatabase();

  it('pairs all fifteen contracts with a relational repository', () => {
    expect(Object.keys(BATCH_F_RELATIONS)).toHaveLength(15);
    expect(BATCH_F_AGGREGATES).toHaveLength(15);
    for (const aggregate of BATCH_F_AGGREGATES) {
      const relation = BATCH_F_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('agrees with the contract registry about which aggregates are append-only', () => {
    // Checked at module load too, because the two are declared in different packages. Asserted here as
    // well so a failure names the mismatch rather than surfacing as an import-time crash.
    const fromRelations = Object.values(BATCH_F_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    expect(fromRelations).toEqual([...BATCH_F_APPEND_ONLY_COLLECTIONS].sort());
    expect(fromRelations).toHaveLength(5);
  });

  it('closes the canonical chain, and requires all fifteen tables', async () => {
    expect([...BATCH_F_CANONICAL_CHAIN_LINKS]).toEqual(['agreements']);
    expect(Object.keys(BATCH_F_RELATIONS)).toContain('agreements');

    for (const aggregate of BATCH_F_AGGREGATES)
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, aggregate.table).toContain(aggregate.table);
    // Forty-one from Batches A-E plus these fifteen. Asserted as a containment and a total rather than
    // as an exact count of some earlier batch's registry, which is the correction Batch E made to Batch
    // D's suite: a bare count becomes false the moment the next batch lands.
    expect(REQUIRED_DOMAIN_AGGREGATE_TABLES).toHaveLength(56);
    expect(new Set(REQUIRED_DOMAIN_AGGREGATE_TABLES).size).toBe(56);

    const database = await schemaOnly();
    const compatible = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);
  }, 300_000);

  it('keys every Batch F table as TEXT and forces row-level security', async () => {
    const database = await schemaOnly();
    const tables = BATCH_F_AGGREGATES.map((aggregate) => aggregate.table);
    const uuid = await database.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${tables}) AND data_type = 'uuid'
    `;
    expect(uuid).toEqual([]);

    for (const table of tables) {
      const [flags] = await database.sql<{ forced: boolean }[]>`
        SELECT c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}
      `;
      // All thirteen existing tables carried ENABLE without FORCE; the two new ones are FORCE from
      // their first statement.
      expect(flags.forced, table).toBe(true);
    }
  }, 300_000);

  it('creates the two tables that had no relation anywhere', async () => {
    const database = await schemaOnly();
    expect([...BATCH_F_CREATED_TABLES].sort()).toEqual(['contract_comments', 'signature_callbacks']);
    for (const table of BATCH_F_CREATED_TABLES) {
      // Not present in any migration before `202608110005`, which is the difference between this batch
      // and every one before it: `contractComments` and `signatureCallbacks` were unstorable rather
      // than merely unrouted.
      const earlier = readMigrations(migrationsDirectory()).filter(
        (entry) => entry.id < '202608110005',
      );
      expect(
        earlier.some((entry) => entry.sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
        table,
      ).toBe(false);

      const [present] = await database.sql<{ n: bigint }[]>`
        SELECT count(*) AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${table}
      `;
      expect(Number(present.n), table).toBe(1);
    }
  }, 300_000);

  it('adds the constraint set the thirteen carried none of', async () => {
    const database = await schemaOnly();
    const tables = BATCH_F_AGGREGATES.map((aggregate) => aggregate.table);
    const [counted] = await database.sql<{ checks: bigint }[]>`
      SELECT count(*) AS checks FROM pg_constraint
      WHERE contype = 'c' AND conrelid::regclass::text = ANY(${tables})
    `;
    // Zero before this migration, measured against a live migrated instance: `pg_constraint` held seven
    // UNIQUE constraints and not one CHECK across all thirteen. A status column that accepts any string
    // is a lifecycle with no states.
    expect(Number(counted.checks)).toBeGreaterThan(100);

    // Every table with a status column has a value set on it. Which tables those are is read from the
    // catalogue rather than listed, so the assertion cannot drift from the schema: four of the fifteen
    // have no lifecycle at all — a comment, a consumed callback, a clause instance and an approval
    // decision are each a record of one moment, and `source` and `decision` are value sets rather than
    // statuses.
    const statusTables = (
      await database.sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY(${tables}) AND column_name = 'status'
        ORDER BY table_name
      `
    ).map((row) => row.table_name);
    expect(statusTables).toHaveLength(11);
    for (const table of statusTables) {
      const [present] = await database.sql<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_constraint
        WHERE contype = 'c' AND conrelid::regclass::text = ${table}
          AND conname = ${`${table}_status_ck`}
      `;
      expect(Number(present.n), table).toBe(1);
    }
  }, 300_000);

  it('refuses the migration when a Batch F table holds rows', async () => {
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const earlier = readMigrations(migrationsDirectory()).filter(
      (entry) => entry.id < '202608110005',
    );
    await database.sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS trust_migration_ledger (
          migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT NOT NULL,
          execution_ms INTEGER NOT NULL, ordinal INTEGER NOT NULL)`;
      for (const migration of earlier) {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
          VALUES (${migration.id}, ${migration.checksum}, 'test', 0, ${migration.ordinal})
          ON CONFLICT (migration_id) DO NOTHING`;
      }
    });
    // Through the pre-convergence shape: `workspace_id` is still a UUID into `workspaces`.
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
              'Legacy', 'ORGANISATION')
    `;
    await database.sql`
      INSERT INTO agreements_v2
        (id, workspace_id, contract_number, title, contract_type, owner_user_id, status)
      VALUES ('33333333-3333-3333-3333-333333333333',
              '11111111-1111-1111-1111-111111111111', 'LEGACY-1', 'Legacy', 'DATA',
              '44444444-4444-4444-4444-444444444444', 'DRAFT')
    `;

    const failure = await applyMigrations(database.sql, migrationsDirectory(), {
      appliedBy: 'integration-test',
    }).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('WAVE6_BATCH_F_AUTHORITY_REFUSED');
    expect(String(failure)).toContain('agreements_v2=1');

    // Nothing changed: the row is still there, still UUID-keyed, and no tenant column was added.
    const [after] = await database.sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agreements_v2' AND column_name = 'id'
    `;
    expect(after.data_type).toBe('uuid');
  }, 300_000);
});

describe('integration: Batch F round-trips the agreement, including the columns that are renamed', () => {
  const seeded = sharedDatabase(executeAgreement);

  it('stores and reads back every one of the fifteen aggregates exactly', async () => {
    const database = await seeded();

    const seen = await as(database, async (store) => ({
      agreements: await store.list('agreements'),
      templateVersions: await store.list('templateVersions'),
      documentVersions: await store.list('documentVersions'),
      contractDrafts: await store.list('contractDrafts'),
      contractComments: await store.list('contractComments'),
      clauseVersions: await store.list('clauseVersions'),
      clauseInstances: await store.list('clauseInstances'),
      clauseDeviations: await store.list('clauseDeviations'),
      negotiationRounds: await store.list('negotiationRounds'),
      approvalPolicies: await store.list('approvalPolicies'),
      approvalRequests: await store.list('approvalRequests'),
      approvalDecisions: await store.list('approvalDecisions'),
      signaturePackages: await store.list('signaturePackages'),
      signatureCallbacks: await store.list('signatureCallbacks'),
      agreementExecutionCertificates: await store.list('agreementExecutionCertificates'),
    }));

    for (const [collection, rows] of Object.entries(seen))
      expect(rows, collection).toHaveLength(1);

    expect(seen.agreements[0]).toEqual(record.agreement());
    expect(seen.templateVersions[0]).toEqual(record.templateVersion());
    expect(seen.contractComments[0]).toEqual(record.contractComment());
    expect(seen.clauseInstances[0]).toEqual(record.clauseInstance());
    expect(seen.clauseDeviations[0]).toEqual(record.clauseDeviation());
    expect(seen.approvalPolicies[0]).toEqual(record.approvalPolicy());
    expect(seen.approvalRequests[0]).toEqual(record.approvalRequest());
    expect(seen.approvalDecisions[0]).toEqual(record.approvalDecision());
    expect(seen.signaturePackages[0]).toEqual(record.signaturePackage());
    expect(seen.signatureCallbacks[0]).toEqual(record.signatureCallback());
    expect(seen.agreementExecutionCertificates[0]).toEqual(record.executionCertificate());
  }, 300_000);

  it('maps the four fields whose column has a different name, in both directions', async () => {
    const database = await seeded();

    const seen = await as(database, async (store) => ({
      documentVersions: (await store.list('documentVersions')) as Record<string, unknown>[],
      contractDrafts: (await store.list('contractDrafts')) as Record<string, unknown>[],
      clauseVersions: (await store.list('clauseVersions')) as Record<string, unknown>[],
      negotiationRounds: (await store.list('negotiationRounds')) as Record<string, unknown>[],
    }));

    // Read side: the domain field is present and the column name is not, which `.strict()` on the
    // canonical schemas would have caught anyway — but only if the repository named the alias, and a
    // repository that returned both would satisfy a loose schema.
    expect(seen.documentVersions[0]).toEqual(record.documentVersion());
    expect(seen.documentVersions[0].number).toBe(1);
    expect(seen.documentVersions[0]).not.toHaveProperty('version');

    expect(seen.contractDrafts[0]).toEqual(record.contractDraft());
    expect(seen.contractDrafts[0].documentVersionId).toBe('dv-1');
    expect(seen.contractDrafts[0]).not.toHaveProperty('currentDocumentVersionId');

    expect(seen.clauseVersions[0]).toEqual(record.clauseVersion());
    expect(seen.clauseVersions[0].guidance).toBe('Escalate to general counsel above ₦50m exposure');
    expect(seen.clauseVersions[0]).not.toHaveProperty('guidanceReference');

    expect(seen.negotiationRounds[0]).toEqual(record.negotiationRound());
    expect(seen.negotiationRounds[0].number).toBe(1);
    expect(seen.negotiationRounds[0]).not.toHaveProperty('roundNumber');

    // Write side: the value reached the column it was meant for, not a neighbour with a similar name.
    // `agreement_document_versions.version` is the one that matters — three other tables in this batch
    // use `version` for a revision, and one of them for a row-edit counter.
    const columns = await raw(database, async (tx) => ({
      document: await tx<{ version: number; draft_id: string }[]>`
        SELECT version, draft_id FROM agreement_document_versions WHERE id = 'dv-1'`,
      draft: await tx<{ current_document_version_id: string; version: number }[]>`
        SELECT current_document_version_id, version FROM agreement_drafts WHERE id = 'dr-1'`,
      clause: await tx<{ guidance_reference: string }[]>`
        SELECT guidance_reference FROM clause_versions_v2 WHERE id = 'cv-1'`,
      round: await tx<{ round_number: number }[]>`
        SELECT round_number FROM negotiation_rounds WHERE id = 'nr-1'`,
    }));
    expect(columns.document[0].version).toBe(1);
    expect(columns.document[0].draft_id).toBe('dr-1');
    expect(columns.draft[0].current_document_version_id).toBe('dv-1');
    expect(columns.draft[0].version).toBe(1);
    expect(columns.clause[0].guidance_reference).toBe(
      'Escalate to general counsel above ₦50m exposure',
    );
    expect(columns.round[0].round_number).toBe(1);
  }, 300_000);

  it('carries an optional reference as absent rather than as null', async () => {
    const database = await seeded();

    // A first document version has no predecessor and a custom clause has no citation. Both columns are
    // nullable, and `compact` drops the key rather than reading it back as `null` — which the `.strict()`
    // schema would refuse, because the field is optional and not nullable.
    await as(database, async (store) => {
      await store.append(
        'documentVersions',
        record.documentVersion({
          id: 'dv-2',
          number: 2,
          contentHash: REVISED_HASH,
          contentReference: 'draft/2',
          supersedesId: 'dv-1',
        }),
      );
      await store.append(
        'clauseInstances',
        record.clauseInstance({ id: 'ci-2', clauseVersionId: undefined, source: 'CUSTOM' }),
      );
    });

    const seen = await as(database, async (store) => ({
      documents: (await store.list('documentVersions')) as Record<string, unknown>[],
      instances: (await store.list('clauseInstances')) as Record<string, unknown>[],
    }));
    const first = seen.documents.find((row) => row.id === 'dv-1');
    const second = seen.documents.find((row) => row.id === 'dv-2');
    expect(first).not.toHaveProperty('supersedesId');
    expect(second?.supersedesId).toBe('dv-1');
    expect(seen.instances.find((row) => row.id === 'ci-2')).not.toHaveProperty('clauseVersionId');
    expect(seen.instances.find((row) => row.id === 'ci-1')?.clauseVersionId).toBe('cv-1');
  }, 300_000);
});

describe('integration: the digest chain is a foreign key, not a comparison someone remembers', () => {
  const seeded = sharedDatabase(executeAgreement);

  it('refuses an approval request whose digest is not the cited document version’s', async () => {
    const database = await seeded();

    // `DigitalExecutionEngine.create` refuses unless the approval's hash equals the document's. That
    // comparison is now structural: the request references `(tenant_id, document_version_id,
    // document_hash)` against the document version's `(tenant_id, id, content_hash)`.
    const failure = await as(database, (store) =>
      store
        .append(
          'approvalRequests',
          record.approvalRequest({ id: 'ar-2', documentHash: REVISED_HASH }),
        )
        .catch((caught: unknown) => caught),
    );
    expect(failure).toBeInstanceOf(PostgresStoreError);

    // And directly, so the refusal is the database's rather than the store's.
    const direct = await raw(database, (tx) =>
      tx`
        INSERT INTO agreement_approval_requests
          (id, tenant_id, workspace_id, contract_id, document_version_id, document_hash, policy_id,
           requester_id, status, completed_steps, created_at)
        VALUES ('ar-3', ${TENANT}, ${WORKSPACE}, 'ag-1', 'dv-1', ${REVISED_HASH}, 'ap-1',
                ${ACTOR}, 'PENDING', 0, ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('agreement_approval_requests_document_fk');
  }, 300_000);

  it('refuses a signature package that signs a different document than it names', async () => {
    const database = await seeded();
    const direct = await raw(database, (tx) =>
      tx`
        INSERT INTO signature_packages_v2
          (id, tenant_id, workspace_id, contract_id, approval_request_id, document_version_id,
           document_hash, signers, status, provider_key, created_at)
        VALUES ('sp-2', ${TENANT}, ${WORKSPACE}, 'ag-1', 'ar-1', 'dv-1', ${REVISED_HASH},
                '[{"userId":"s","authorityReference":"a","witnessRequired":false}]'::jsonb,
                'SENT', 'sandbox', ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('signature_packages_v2_document_fk');
  }, 300_000);

  it('refuses an execution certificate that attests a digest the package does not carry', async () => {
    const database = await seeded();

    // A second document version and a second package, both legitimate, so the attempt below is isolated
    // to the digest. Reusing `sp-1` would collide with the pre-existing `UNIQUE (package_id)` — one
    // certificate per package — and a duplicate-key error is not evidence about the digest chain.
    await as(database, async (store) => {
      await store.append(
        'documentVersions',
        record.documentVersion({
          id: 'dv-2',
          number: 2,
          contentReference: 'draft/2',
          contentHash: REVISED_HASH,
        }),
      );
      await store.append(
        'signaturePackages',
        record.signaturePackage({ id: 'sp-2', documentVersionId: 'dv-2', documentHash: REVISED_HASH }),
      );
    });

    // The end of the chain, and the reason it matters: a certificate that could cite a document it was
    // not computed from is a contract whose execution cannot be proved. `sp-2` signs `REVISED_HASH`, so
    // a certificate claiming `DOC_HASH` for it has no key to point at.
    const direct = await raw(database, (tx) =>
      tx`
        INSERT INTO agreement_execution_certificates
          (id, tenant_id, workspace_id, package_id, contract_id, document_hash, canonical_hash,
           status, issued_at)
        VALUES ('ec-2', ${TENANT}, ${WORKSPACE}, 'sp-2', 'ag-1', ${DOC_HASH},
                ${CANONICAL_HASH}, 'VALID', ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('agreement_execution_certificates_package_fk');

    // And the matching digest is accepted, so the refusal above is about the mismatch rather than about
    // the constraint refusing everything.
    await as(database, (store) =>
      store.append(
        'agreementExecutionCertificates',
        record.executionCertificate({ id: 'ec-3', packageId: 'sp-2', documentHash: REVISED_HASH }),
      ),
    );
  }, 300_000);

  it('refuses a hash that is not a digest, in every column that holds one', async () => {
    const database = await seeded();

    for (const contentHash of ['a3f1c9', DOC_HASH.toUpperCase(), `${DOC_HASH}a`]) {
      const failure = await as(database, (store) =>
        store
          .append('templateVersions', record.templateVersion({ id: 'tv-9', contentHash }))
          ,
      ).catch((caught: unknown) => caught);
      expect(failure, contentHash.slice(0, 10)).toBeInstanceOf(PostgresStoreError);
    }

    // Through a direct statement, because the canonical schema refuses these before the column sees
    // them — and a constraint that is never reached is not evidence of anything.
    const direct = await raw(database, (tx) =>
      tx`
        INSERT INTO clause_versions_v2
          (id, tenant_id, workspace_id, clause_key, version, body_hash, risk, guidance_reference,
           status, created_at)
        VALUES ('cv-9', ${TENANT}, ${WORKSPACE}, 'indemnity', 1, 'not-a-digest', 'LOW', 'g',
                'DRAFT', ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('clause_versions_v2_body_hash_digest_ck');
  }, 300_000);
});

describe('integration: Batch F concurrency, immutability and terminal states', () => {
  // Ordered deliberately: every refusal runs first, while the seeded rows are still in the state
  // `executeAgreement` left them, and the two tests that transition a row run last. Sharing one
  // database across the block is what makes the order matter, and it is stated rather than implied —
  // the alternative was six more connection pools than the server can spare.
  const seeded = sharedDatabase(executeAgreement);

  it('refuses a revision change, and a write that does not advance the row counter', async () => {
    const database = await seeded();

    const changed = await raw(database, (tx) =>
      tx`UPDATE contract_template_versions SET version = 2, row_version = row_version + 1
         WHERE id = 'tv-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(changed)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(changed)).toContain('version');

    const stale = await raw(database, (tx) =>
      tx`UPDATE contract_template_versions SET status = 'SUPERSEDED' WHERE id = 'tv-1'`,
    ).catch((caught: unknown) => caught);
    // Names `row_version`, not `version`, which is the whole point of Batch E's generalisation.
    expect(String(stale)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
    expect(String(stale)).toContain('row_version');
  }, 300_000);

  it('refuses a change to the digest an approval is an approval of', async () => {
    const database = await seeded();
    // The load-bearing immutable fact of this batch. `invalidateOnChange` compares this column against
    // the document's current hash, so a rewritable digest is an invalidation that can be made to find
    // no change.
    const failure = await raw(database, (tx) =>
      tx`UPDATE agreement_approval_requests
         SET document_hash = ${REVISED_HASH}, row_version = row_version + 1
         WHERE id = 'ar-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('document_hash');
  }, 300_000);

  it('refuses a DELETE on a governed aggregate and on an append-only one', async () => {
    const database = await seeded();
    for (const table of ['agreements_v2', 'contract_comments'] as const) {
      const failure = await raw(database, (tx) =>
        tx.unsafe(`DELETE FROM ${table}`),
      ).catch((caught: unknown) => caught);
      // An agreement that can be deleted is a contract that can be made never to have existed.
      expect(String(failure), table).toMatch(/NOT_DELETABLE|append-only/);
    }
  }, 300_000);

  it('refuses an update to every append-only aggregate, in the store and in the database', async () => {
    const database = await seeded();

    for (const collection of BATCH_F_APPEND_ONLY_COLLECTIONS) {
      const relation = BATCH_F_RELATIONS[collection];
      // The workspace has to be the caller's, because `replaceScoped` re-derives the tenant before it
      // reaches the relation: a record outside the caller's scope is refused for that reason, and the
      // append-only refusal would never be exercised.
      const failure = await as(database, (store) =>
        store
          .replace(collection, { id: 'irrelevant', workspaceId: WORKSPACE })
          .catch((caught: unknown) => caught),
      );
      expect(failure, collection).toBeInstanceOf(PostgresStoreError);
      expect((failure as PostgresStoreError).code, collection).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

      const direct = await raw(database, (tx) =>
        tx.unsafe(`UPDATE ${relation.table} SET row_version = row_version + 1`),
      ).catch((caught: unknown) => caught);
      expect(String(direct), relation.table).toContain('append-only');
    }
  }, 300_000);

  it('advances the row counter without moving a revision, and moves the draft’s own version', async () => {
    const database = await seeded();

    await as(database, async (store) => {
      await store.replace('templateVersions', record.templateVersion({ status: 'SUPERSEDED' }));
      // The draft's `version` is the one domain revision in this batch that legitimately advances:
      // `setVariables` writes `d.version + 1`.
      await store.replace(
        'contractDrafts',
        record.contractDraft({ status: 'LOCKED', lockedBy: ACTOR, version: 2 }),
      );
    });

    const rows = await raw(database, async (tx) => ({
      template: await tx<{ version: number; row_version: number; status: string }[]>`
        SELECT version, row_version, status FROM contract_template_versions WHERE id = 'tv-1'`,
      draft: await tx<{ version: number; row_version: number }[]>`
        SELECT version, row_version FROM agreement_drafts WHERE id = 'dr-1'`,
    }));
    // The revision the template *is* did not change; the row counter did.
    expect(rows.template[0].version).toBe(1);
    expect(rows.template[0].row_version).toBe(2);
    expect(rows.template[0].status).toBe('SUPERSEDED');
    expect(rows.draft[0].version).toBe(2);
    expect(rows.draft[0].row_version).toBe(2);
  }, 300_000);

  it('refuses an update to a superseded template, a closed package and a closed round', async () => {
    const database = await seeded();

    // The three tables whose terminal states are provable from the engines. The other seven governed
    // tables have none, because `retire`, `approve`, `invalidateOnChange` and `revoke` accept a row in
    // any state — recorded in POST_WAVE_5_FOLLOWUPS.md rather than approximated with a guess.
    //
    // `tv-1` was superseded by the test before this one, and is deliberately not superseded again:
    // that second write would itself be the post-terminal write under test, and it would throw
    // unguarded rather than being asserted on.
    await as(database, async (store) => {
      await store.replace('signaturePackages', record.signaturePackage({ status: 'COMPLETED' }));
      await store.replace('negotiationRounds', record.negotiationRound({ status: 'WITHDRAWN' }));
    });

    for (const [table, id] of [
      ['contract_template_versions', 'tv-1'],
      ['signature_packages_v2', 'sp-1'],
      ['negotiation_rounds', 'nr-1'],
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx.unsafe(`UPDATE ${table} SET row_version = row_version + 1 WHERE id = '${id}'`),
      ).catch((caught: unknown) => caught);
      expect(String(failure), table).toContain('AGGREGATE_STATE_IS_TERMINAL');
    }
  }, 300_000);
});

describe('integration: Batch F invariants the schema alone cannot carry', () => {
  const seeded = sharedDatabase(executeAgreement);

  it('refuses a clause instance whose source and citation disagree', async () => {
    const database = await seeded();

    for (const [source, clauseVersionId] of [
      ['LIBRARY', null],
      ['CUSTOM', 'cv-1'],
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx`
          INSERT INTO clause_instances_v2
            (id, tenant_id, workspace_id, draft_id, clause_version_id, body_hash, source, created_at)
          VALUES ('ci-9', ${TENANT}, ${WORKSPACE}, 'dr-1', ${clauseVersionId}, ${CLAUSE_HASH},
                  ${source}, ${stamp})
        `,
      ).catch((caught: unknown) => caught);
      // A LIBRARY clause with no citation claims a published baseline it cannot name; a CUSTOM clause
      // with one claims a baseline it deliberately departed from.
      expect(String(failure), source).toContain('clause_instances_v2_citation_ck');
    }
  }, 300_000);

  it('refuses a locked draft with no locker, and permits a submitted one that keeps its locker', async () => {
    const database = await seeded();

    const failure = await raw(database, (tx) =>
      tx`UPDATE agreement_drafts SET status = 'LOCKED', row_version = row_version + 1
         WHERE id = 'dr-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('agreement_drafts_locked_by_ck');

    // One-way on purpose: `lock` never clears `lockedBy`, so a submitted draft still records who locked
    // it, and requiring the reverse would refuse that legitimate row.
    await as(database, (store) =>
      store.replace(
        'contractDrafts',
        record.contractDraft({ status: 'SUBMITTED', lockedBy: ACTOR, version: 2 }),
      ),
    );
    const [row] = await raw(database, (tx) =>
      tx<{ status: string; locked_by: string }[]>`
        SELECT status, locked_by FROM agreement_drafts WHERE id = 'dr-1'`,
    );
    expect(row.status).toBe('SUBMITTED');
    expect(row.locked_by).toBe(ACTOR);
  }, 300_000);

  it('refuses a policy with no steps and a package with no signers', async () => {
    const database = await seeded();

    const policy = await raw(database, (tx) =>
      tx`
        INSERT INTO approval_policies_v2
          (id, tenant_id, workspace_id, version, steps, status, created_at)
        VALUES ('ap-9', ${TENANT}, ${WORKSPACE}, 1, '[]'::jsonb, 'PUBLISHED', ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    // `completedSteps === steps.length` from the start, so an empty policy approves on routing.
    expect(String(policy)).toContain('approval_policies_v2_steps_ck');

    const pack = await raw(database, (tx) =>
      tx`
        INSERT INTO signature_packages_v2
          (id, tenant_id, workspace_id, contract_id, approval_request_id, document_version_id,
           document_hash, signers, status, provider_key, created_at)
        VALUES ('sp-9', ${TENANT}, ${WORKSPACE}, 'ag-1', 'ar-1', 'dv-1', ${DOC_HASH},
                '[]'::jsonb, 'SENT', 'sandbox', ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    // `signers.every(...)` is true of no signers, so an empty package is COMPLETED on arrival and
    // `issue` would mint an execution certificate for a document nobody signed.
    expect(String(pack)).toContain('signature_packages_v2_signers_ck');
  }, 300_000);

  it('refuses a document version that supersedes itself, and an unknown status', async () => {
    const database = await seeded();

    const lineage = await raw(database, (tx) =>
      tx`
        INSERT INTO agreement_document_versions
          (id, tenant_id, workspace_id, contract_id, draft_id, version, content_reference,
           content_hash, status, created_by, created_at, supersedes_id)
        VALUES ('dv-9', ${TENANT}, ${WORKSPACE}, 'ag-1', 'dr-1', 9, 'draft/9', ${REVISED_HASH},
                'DRAFT', ${ACTOR}, ${stamp}, 'dv-9')
      `,
    ).catch((caught: unknown) => caught);
    expect(String(lineage)).toContain('agreement_document_versions_lineage_ck');

    const status = await raw(database, (tx) =>
      tx`
        INSERT INTO agreements_v2
          (id, tenant_id, workspace_id, contract_number, title, contract_type, owner_user_id,
           status, created_at, version)
        VALUES ('ag-9', ${TENANT}, ${WORKSPACE}, 'AP-9', 'T', 'DATA', ${ACTOR}, 'CANCELLED',
                ${stamp}, 1)
      `,
    ).catch((caught: unknown) => caught);
    expect(String(status)).toContain('agreements_v2_status_ck');
  }, 300_000);

  it('refuses a revision below one and a negative step count', async () => {
    const database = await seeded();

    const revision = await raw(database, (tx) =>
      tx`
        INSERT INTO negotiation_rounds
          (id, tenant_id, workspace_id, contract_id, round_number, submitted_by,
           document_version_id, status, mandatory_open_items, created_at)
        VALUES ('nr-9', ${TENANT}, ${WORKSPACE}, 'ag-1', 0, ${ACTOR}, 'dv-1', 'SUBMITTED',
                '[]'::jsonb, ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    // Rounds are counted from existing rows, so there is no round zero.
    expect(String(revision)).toContain('negotiation_rounds_round_number_positive_ck');

    const step = await raw(database, (tx) =>
      tx`
        INSERT INTO agreement_approval_decisions
          (id, tenant_id, workspace_id, request_id, step, approver_id, decision, conditions,
           created_at)
        VALUES ('ad-9', ${TENANT}, ${WORKSPACE}, 'ar-1', -1, ${APPROVER}, 'APPROVE', '[]'::jsonb,
                ${stamp})
      `,
    ).catch((caught: unknown) => caught);
    // A step index legitimately starts at zero, which is why it is bounded differently from a revision.
    expect(String(step)).toContain('agreement_approval_decisions_step_ck');
  }, 300_000);

  it('scopes provider callback replay to the workspace', async () => {
    const database = await seeded();
    await executeAgreement(database, TENANT, OTHER_WORKSPACE, '-b');

    // Both seeds used the same provider event identifier in different workspaces of one tenant, and both
    // are already stored — which is the property under test. Before the engine's replay check was
    // scoped, the second read as a replay of the first, and the replay path returns the package
    // unchanged: a real signature event silently dropped.
    const [mine] = await raw(
      database,
      (tx) => tx<{ id: string; event_id: string }[]>`
        SELECT id, event_id FROM signature_callbacks`,
    );
    const [theirs] = await raw(
      database,
      (tx) => tx<{ id: string; event_id: string }[]>`
        SELECT id, event_id FROM signature_callbacks`,
      TENANT,
      OTHER_WORKSPACE,
    );
    expect(mine).toEqual({ id: 'sc-1', event_id: 'evt_9f2' });
    expect(theirs).toEqual({ id: 'sc-1-b', event_id: 'evt_9f2' });

    // The same event twice in one workspace is a replay, and the constraint says so — which is what
    // makes the scoping a tightening rather than a loosening.
    const duplicate = await as(database, (store) =>
      store
        .append('signatureCallbacks', record.signatureCallback({ id: 'sc-dup' }))
        .catch((caught: unknown) => caught),
    );
    expect(duplicate).toBeInstanceOf(PostgresStoreError);
    expect((duplicate as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);
});

describe('integration: Batch F tenancy', () => {
  // Both tenants, seeded once. Each test only reads or attempts a refused write, so sharing is safe —
  // and seeding twice would collide on the identifiers.
  const seeded = sharedDatabase(async (database) => {
    await executeAgreement(database);
    await executeAgreement(database, OTHER_TENANT, OTHER_WORKSPACE, '-x');
  });

  it('refuses a child whose parent belongs to another tenant', async () => {
    const database = await seeded();

    // Foreign key checks run as the table owner and are not subject to row-level security, so only the
    // composite key stops this.
    const failure = await raw(
      database,
      (tx) =>
        tx`
          INSERT INTO contract_comments
            (id, tenant_id, workspace_id, contract_id, body, visibility, author_id, created_at)
          VALUES ('cc-x', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'ag-1', 'cross-tenant', 'INTERNAL',
                  ${ACTOR}, ${stamp})
        `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('contract_comments_contract_fk');
  }, 300_000);

  it('shows a tenant only its own agreements', async () => {
    const database = await seeded();

    const mine = await as(database, (store) => store.list('agreements'));
    const theirs = await as(
      database,
      (store) => store.list('agreements'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(mine.map((row) => (row as { id: string }).id)).toEqual(['ag-1']);
    expect(theirs.map((row) => (row as { id: string }).id)).toEqual(['ag-1-x']);
  }, 300_000);
});
