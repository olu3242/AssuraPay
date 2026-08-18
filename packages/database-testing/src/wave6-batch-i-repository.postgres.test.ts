import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_I_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_I_AGGREGATES,
  BATCH_I_APPEND_ONLY_COLLECTIONS,
  BATCH_I_CONVERGED_NOT_ROUTED_TABLES,
  BATCH_I_TABLES,
  REPOSITORY_MIME_TYPES,
  riskLevelForScore,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch I persists to its own tables, and a machine reading of a contract becomes evidence.
 *
 * The six agreement-intelligence aggregates of canonical Engines 16-20 — six rather than the five the
 * durability register predicted, because `contractVersionsV2` was hidden from the coverage gate by a name
 * pattern that excluded digits.
 *
 * The test this suite exists for is `refuses publishing a reading no one reviewed`. `publish()` guards it,
 * but a guard in one method is not the rule — the rule is that no PUBLISHED row can exist containing an item
 * still awaiting review, and that claim can only be checked by issuing the statement. These items become
 * parties, milestones and payment triggers downstream, so an unreviewed one is an unverified term entering
 * the settlement path.
 *
 * Two more claims are only checkable here. `content_hash` is declared immutable, which is sound only because
 * the engine now digests what was *extracted* rather than the review statuses too — before that fix the
 * stored hash described a state that no longer existed the moment anything was reviewed. And a risk level
 * must follow from its score, because the level is the banner a reader acts on.
 *
 * Every refusal is exercised by direct statement as well as, or instead of, through the store: the store
 * writing only the columns its engine moves and the database refusing every other column are two different
 * guarantees, and only the second survives a caller that does not use the store.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-i';
const OTHER_TENANT = 'tenant-i-other';
const WORKSPACE = 'workspace-i';
const OTHER_WORKSPACE = 'workspace-i-other';
const ACTOR = 'user-counsel';
const REVIEWER = 'user-reviewer';

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

/** One database per describe block, seeded once — a database per test exhausts the connection allowance. */
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
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every table in this closure forces row-level security. */
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

/** The statement's own failure, or the value it returned. Never a rejected promise. */
function attempt<T>(work: Promise<T>): Promise<T | unknown> {
  return work.catch((caught: unknown) => caught);
}

const source = (o: Record<string, unknown> = {}) => ({
  documentVersionId: 'cv-1',
  section: 'Clause 14.2 (Retention)',
  page: 12,
  startOffset: 4_120,
  endOffset: 4_480,
  ...o,
});

const record = {
  version: (o: Record<string, unknown> = {}) => ({
    id: 'cv-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    number: 1,
    kind: 'EXECUTED',
    documentReference: 'vault://c-1/executed.pdf',
    documentHash: hash('a'),
    executionCertificateId: 'ec-1',
    status: 'ACTIVE',
    createdAt: stamp,
    ...o,
  }),
  finding: (o: Record<string, unknown> = {}) => ({
    id: 'f-1',
    type: 'RETENTION_TERM',
    severity: 'HIGH',
    title: 'Retention released 90 days after practical completion',
    sourceReferences: [source()],
    confidence: 0.82,
    reviewStatus: 'NOT_REVIEWED',
    ...o,
  }),
  run: (o: Record<string, unknown> = {}) => ({
    id: 'car-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    method: 'AI_ASSISTED',
    modelId: 'model-contract-reader',
    modelVersion: '2026.07',
    promptVersion: 'prompt-14',
    inputHash: hash('b'),
    outputHash: hash('c'),
    findings: [record.finding()],
    status: 'COMPLETED',
    requestedBy: ACTOR,
    createdAt: stamp,
    ...o,
  }),
  review: (o: Record<string, unknown> = {}) => ({
    id: 'ar-1',
    workspaceId: WORKSPACE,
    runId: 'car-1',
    findingId: 'f-1',
    decision: 'ACCEPTED',
    notes: 'Retention period confirmed against the signed payment schedule.',
    reviewerId: REVIEWER,
    createdAt: stamp,
    ...o,
  }),
  assessment: (o: Record<string, unknown> = {}) => ({
    id: 'cra-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    analysisRunId: 'car-1',
    version: 1,
    dimensions: { payment: 70, delivery: 50 },
    score: 60,
    level: 'HIGH',
    explanations: [{ dimension: 'payment', sourceReferences: [source()] }],
    status: 'DRAFT',
    createdAt: stamp,
    ...o,
  }),
  document: (o: Record<string, unknown> = {}) => ({
    id: 'crd-1',
    workspaceId: WORKSPACE,
    contractVersionId: 'cv-1',
    storageReference: 'vault://c-1/executed.pdf',
    contentHash: hash('d'),
    mimeType: 'application/pdf',
    classification: 'CONFIDENTIAL',
    tags: ['executed', 'master'],
    ocrTextReference: 'vault://c-1/executed.txt',
    legalHold: false,
    createdAt: stamp,
    ...o,
  }),
  item: (o: Record<string, unknown> = {}) => ({
    id: 'ii-1',
    type: 'PAYMENT_TRIGGER',
    value: { amountMinor: 5_000_000, currency: 'NGN' },
    sourceReferences: [source()],
    confidence: 0.9,
    reviewStatus: 'PENDING',
    ...o,
  }),
  intelligence: (o: Record<string, unknown> = {}) => ({
    id: 'aiv-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    version: 1,
    items: [record.item()],
    status: 'DRAFT',
    createdBy: ACTOR,
    createdAt: stamp,
    contentHash: hash('e'),
    ...o,
  }),
};

/** The whole intelligence closure, in dependency order — every parent is one of the six. */
async function foundIntelligence(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('contractVersionsV2', record.version({ id: k('cv-1'), workspaceId }));
    await store.append(
      'contractAnalysisRuns',
      record.run({
        id: k('car-1'),
        workspaceId,
        contractVersionId: k('cv-1'),
        findings: [record.finding({ sourceReferences: [source({ documentVersionId: k('cv-1') })] })],
      }),
    );
    await store.append(
      'analysisReviews',
      record.review({ id: k('ar-1'), workspaceId, runId: k('car-1') }),
    );
    await store.append(
      'contractRiskAssessments',
      record.assessment({
        id: k('cra-1'),
        workspaceId,
        contractVersionId: k('cv-1'),
        analysisRunId: k('car-1'),
        explanations: [
          { dimension: 'payment', sourceReferences: [source({ documentVersionId: k('cv-1') })] },
        ],
      }),
    );
    await store.append(
      'repositoryDocuments',
      record.document({ id: k('crd-1'), workspaceId, contractVersionId: k('cv-1') }),
    );
    await store.append(
      'agreementIntelligenceVersions',
      record.intelligence({
        id: k('aiv-1'),
        workspaceId,
        contractVersionId: k('cv-1'),
        items: [record.item({ sourceReferences: [source({ documentVersionId: k('cv-1') })] })],
      }),
    );
  });
}

describe('integration: Batch I is activated and agreement intelligence becomes durable', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('pairs all six contracts with a relational repository', () => {
    expect(Object.keys(BATCH_I_RELATIONS).sort()).toEqual(
      BATCH_I_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
    // Six, not the register's five. `contractVersionsV2` is the parent of four of the other five, so the
    // gate's blind spot had hidden the root of this closure rather than a leaf of it.
    expect(BATCH_I_AGGREGATES).toHaveLength(6);
  });

  it('requires all six tables at startup and routes to them', async () => {
    const database = await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_I_TABLES) {
      expect(required.has(table), table).toBe(true);
      expect(routed.has(table), table).toBe(true);
    }

    const present = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `,
    );
    const names = new Set(present.map((row) => row.table_name));
    for (const table of BATCH_I_TABLES) expect(names.has(table), table).toBe(true);
    // `analysis_reviews` existed nowhere before `202608110012`: a reviewer's decision on a finding had no
    // table at all, so the human-in-the-loop rule left no record to audit afterwards.
    expect(names.has('analysis_reviews')).toBe(true);
  }, 300_000);

  it('converges the two leaf tables without routing them', async () => {
    const database = await seeded();
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_I_CONVERGED_NOT_ROUTED_TABLES) {
      // Not routed, because no engine writes either. Converged anyway, because their `*_id` columns point
      // at aggregates this batch converts to TEXT — the arrangement Batch B named.
      expect(routed.has(table), table).toBe(false);
    }

    const state = await raw(database, (tx) =>
      tx<{ relname: string; relforcerowsecurity: boolean; uuid_columns: number }[]>`
        SELECT c.relname,
               c.relforcerowsecurity,
               (SELECT count(*) FROM information_schema.columns col
                 WHERE col.table_schema = current_schema()
                   AND col.table_name = c.relname
                   AND col.data_type = 'uuid')::int AS uuid_columns
        FROM pg_class c
        WHERE c.relname = ANY(${BATCH_I_CONVERGED_NOT_ROUTED_TABLES as string[]})
      `,
    );
    expect(state).toHaveLength(2);
    for (const row of state) {
      // Not routed does not mean not protected: a table with no engine is exactly the kind that gets
      // forgotten, and one still holding UUID keys would reinstate the identity split.
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(row.uuid_columns, row.relname).toBe(0);
    }
  }, 300_000);

  it('keys every table in the closure as TEXT and forces row-level security', async () => {
    const database = await seeded();
    const closure = [...BATCH_I_TABLES, ...BATCH_I_CONVERGED_NOT_ROUTED_TABLES];
    const uuid = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${closure})
          AND data_type = 'uuid'
      `,
    );
    // `created_by`, `requested_by` and `execution_certificate_id` are trust principals and references, and
    // a UUID column cannot hold one — so the conversion covers every UUID column, not only the keys.
    expect(uuid).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY(${closure})
      `,
    );
    expect(security).toHaveLength(closure.length);
    for (const row of security) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      // FORCE, not merely ENABLE: ENABLE does not constrain the table owner.
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  }, 300_000);

  it('stores and reads back all six aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      contractVersionsV2: await store.list('contractVersionsV2'),
      contractAnalysisRuns: await store.list('contractAnalysisRuns'),
      analysisReviews: await store.list('analysisReviews'),
      contractRiskAssessments: await store.list('contractRiskAssessments'),
      repositoryDocuments: await store.list('repositoryDocuments'),
      agreementIntelligenceVersions: await store.list('agreementIntelligenceVersions'),
    }));

    // `version_number` and `version_kind` in the table, `number` and `kind` in the domain: the round trip
    // is where that mapping is either right or a silently dropped field.
    expect(seen.contractVersionsV2[0]).toEqual(record.version());
    // The nested findings survive, including their citations and the optional offsets.
    expect(seen.contractAnalysisRuns[0]).toEqual(record.run());
    expect(seen.analysisReviews[0]).toEqual(record.review());
    expect(seen.contractRiskAssessments[0]).toEqual(record.assessment());
    // `ocrTextReference` is optional and present; `supersedesId` is optional and absent on the version above.
    expect(seen.repositoryDocuments[0]).toEqual(record.document());
    expect(seen.agreementIntelligenceVersions[0]).toEqual(record.intelligence());
  }, 300_000);
});

describe('integration: the human-in-the-loop rule for a machine reading of an agreement', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('refuses publishing a reading no one reviewed', async () => {
    const database = await seeded();
    // `publish()` refuses HUMAN_REVIEW_REQUIRED while any item is PENDING. That is a guard in one method;
    // this is the rule. The seeded version's single item is PENDING, and these items become the contract's
    // parties, milestones and payment triggers downstream — so publishing here would put a term nobody
    // checked onto the settlement path.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agreement_intelligence_versions
           SET status = 'PUBLISHED', row_version = row_version + 1
           WHERE id = 'aiv-1'`,
      ),
    );
    expect(String(failure)).toContain('published_is_reviewed');

    // Unchanged, which is the part that matters: the refusal is not a partial application.
    const [held] = await as(database, (store) =>
      store.list<{ id: string; status: string }>('agreementIntelligenceVersions'),
    );
    expect(held.status).toBe('DRAFT');
  }, 300_000);

  it('refuses publishing a reading in which everything was rejected', async () => {
    const database = await seeded();
    // Nothing PENDING, so the first half of the rule is satisfied — and nothing accepted either, which is
    // `publish()`'s ACCEPTED_INTELLIGENCE_REQUIRED. A published version containing no accepted term is a
    // reading that asserts nothing while reading as authoritative.
    const rejected = [record.item({ reviewStatus: 'REJECTED' })];
    const failure = await attempt(
      raw(
        database,
        // `tx.json`, not a `JSON.stringify` bound and cast: the driver sends a bound string as a jsonb
        // *string scalar*, which every predicate here refuses on `jsonb_typeof` before reaching the rule
        // under test — so the test would pass while proving something else.
        (tx) =>
          tx`UPDATE agreement_intelligence_versions
             SET status = 'PUBLISHED', items = ${tx.json(rejected as never)},
                 row_version = row_version + 1
             WHERE id = 'aiv-1'`,
      ),
    );
    expect(String(failure)).toContain('published_is_reviewed');
  }, 300_000);

  it('accepts a reading whose items were reviewed, through the store', async () => {
    const database = await seeded();
    // The permitted transition, and the one `review()` then `publish()` performs: the item's review status
    // moves inside the row, then the version publishes. `status` and `items` are the only two columns the
    // repository writes, and the governed trigger refuses every other.
    await as(database, (store) =>
      store.replace(
        'agreementIntelligenceVersions',
        record.intelligence({ status: 'PUBLISHED', items: [record.item({ reviewStatus: 'ACCEPTED' })] }),
      ),
    );
    const [published] = await as(database, (store) =>
      store.list<{ status: string; items: { reviewStatus: string }[] }>('agreementIntelligenceVersions'),
    );
    expect(published.status).toBe('PUBLISHED');
    expect(published.items[0].reviewStatus).toBe('ACCEPTED');
  }, 300_000);

  it('refuses rewriting the hash that says what was published', async () => {
    const database = await seeded();
    // `content_hash` is the citation `publish()` emits for what was published, so a mutable one makes the
    // citation describe whatever was most recently claimed.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agreement_intelligence_versions
           SET content_hash = ${hash('f')}, row_version = row_version + 1
           WHERE id = 'aiv-1'`,
      ),
    );
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('content_hash');
  }, 300_000);

  it('holds the content hash stable across a review, which is why it can be immutable', async () => {
    const database = await seeded();
    // The defect this depends on: `contentHash` used to digest each item *including* its review status,
    // while `review()` changes that status without recomputing the hash — so after any review the stored
    // hash described a state that no longer existed. The engine now digests only what was extracted, and
    // that is what lets the column be immutable rather than a value that silently goes stale.
    const before = await raw(database, (tx) =>
      tx<{ content_hash: string }[]>`
        SELECT content_hash FROM agreement_intelligence_versions WHERE id = 'aiv-1'
      `,
    );
    await as(database, (store) =>
      store.replace(
        'agreementIntelligenceVersions',
        record.intelligence({ items: [record.item({ reviewStatus: 'REJECTED' })] }),
      ),
    );
    const after = await raw(database, (tx) =>
      tx<{ content_hash: string; items: { reviewStatus: string }[] }[]>`
        SELECT content_hash, items FROM agreement_intelligence_versions WHERE id = 'aiv-1'
      `,
    );
    expect(after[0].items[0].reviewStatus).toBe('REJECTED');
    expect(after[0].content_hash).toBe(before[0].content_hash);
  }, 300_000);

  it('refuses an item that cites nothing, without the exemption findings get', async () => {
    const database = await seeded();
    // No INFO exemption here, deliberately: an extracted obligation with no source is a claim about the
    // agreement that cannot be checked against it, and it becomes a milestone or a payment trigger.
    const uncited = [record.item({ id: 'ii-2', sourceReferences: [] })];
    const failure = await attempt(
      raw(
        database,
        (tx) =>
          tx`UPDATE agreement_intelligence_versions
             SET items = ${tx.json(uncited as never)}, row_version = row_version + 1
             WHERE id = 'aiv-1'`,
      ),
    );
    expect(String(failure)).toContain('items_cite_sources');
  }, 300_000);
});

describe('integration: Batch I risk assessments say what their own numbers say', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('refuses a level that does not follow from its score', async () => {
    const database = await seeded();
    // The banner is what a reader acts on, and it is derived rather than chosen. A CRITICAL banner above a
    // score of four is a risk rating that does not describe its own number.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_risk_assessments
             (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
              dimensions, score, level, explanations, status, created_at, row_version, schema_version,
              updated_at)
           VALUES ('cra-lying', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', 2,
                   '{"payment":4}'::jsonb, 4, 'CRITICAL', '[]'::jsonb, 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('level_follows_score');

    // And in the other direction: a LOW banner over a score of ninety is the more dangerous of the two.
    const understated = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_risk_assessments
             (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
              dimensions, score, level, explanations, status, created_at, row_version, schema_version,
              updated_at)
           VALUES ('cra-quiet', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', 3,
                   '{"payment":90}'::jsonb, 90, 'LOW', '[]'::jsonb, 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(understated)).toContain('level_follows_score');
  }, 300_000);

  it('agrees with the engine’s thresholds at every boundary', async () => {
    const database = await seeded();
    // The constraint repeats `assess()`'s thresholds, so the two can drift. This walks the boundaries and
    // asserts the database accepts exactly what `riskLevelForScore` returns and refuses the level below it.
    for (const score of [0, 29, 30, 59, 60, 79, 80, 100]) {
      const level = riskLevelForScore(score);
      const id = `cra-boundary-${score}`;
      const accepted = await attempt(
        raw(database, (tx) =>
          tx`INSERT INTO contract_risk_assessments
               (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
                dimensions, score, level, explanations, status, created_at, row_version, schema_version,
                updated_at)
             VALUES (${id}, ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', ${score + 100},
                     ${`{"payment":${score}}`}::jsonb, ${score}, ${level}, '[]'::jsonb, 'DRAFT',
                     ${stamp}, 1, 1, ${stamp})`,
        ),
      );
      expect(String(accepted), `${score} → ${level}`).not.toContain('level_follows_score');
    }
  }, 300_000);

  it('refuses an assessment that measured nothing, or scored outside the scale', async () => {
    const database = await seeded();
    // `assess()` divides by `max(1, count)`, so an empty dimension set scores zero and shows a LOW banner
    // that reads as a finding rather than as an absence of one.
    const empty = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_risk_assessments
             (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
              dimensions, score, level, explanations, status, created_at, row_version, schema_version,
              updated_at)
           VALUES ('cra-empty', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', 4,
                   '{}'::jsonb, 0, 'LOW', '[]'::jsonb, 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(empty)).toContain('scores_something');

    const outOfScale = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_risk_assessments
             (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
              dimensions, score, level, explanations, status, created_at, row_version, schema_version,
              updated_at)
           VALUES ('cra-over', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', 5,
                   '{"payment":50}'::jsonb, 140, 'CRITICAL', '[]'::jsonb, 'DRAFT', ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    // `contract_risk_assessments_score_check`, declared by `202608030003` and deliberately not re-declared
    // by `202608110012`: it survives the identity conversion intact, and a second CHECK with the same
    // predicate under a different name is noise. Asserted here so that the rule is covered by a test even
    // though this batch did not add it.
    expect(String(outOfScale)).toContain('contract_risk_assessments_score_check');
  }, 300_000);

  it('refuses lowering a score once the assessment has been signed off', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.replace('contractRiskAssessments', record.assessment({ status: 'VALIDATED' })),
    );
    // The status is the only column the repository writes, and the database is what stops anything else.
    // An assessment whose score could be rewritten after validation is a risk rating that can be lowered
    // once it has been signed off.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE contract_risk_assessments
           SET score = 4, level = 'LOW', row_version = row_version + 1
           WHERE id = 'cra-1'`,
      ),
    );
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const [signed] = await as(database, (store) =>
      store.list<{ score: number; level: string; status: string }>('contractRiskAssessments'),
    );
    expect(signed).toMatchObject({ score: 60, level: 'HIGH', status: 'VALIDATED' });
  }, 300_000);

  it('refuses an explanation that cites nothing', async () => {
    const database = await seeded();
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE contract_risk_assessments
           SET explanations = '[{"dimension":"payment","sourceReferences":[]}]'::jsonb,
               row_version = row_version + 1
           WHERE id = 'cra-1'`,
      ),
    );
    // Two constraints could catch this; `explanations` is immutable, so that is the one that fires first.
    expect(String(failure)).toMatch(/AGGREGATE_FACT_IS_IMMUTABLE|explanations_cite_sources/);

    // On the way in, where the citation rule is the only thing standing in the way.
    const inserted = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_risk_assessments
             (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
              dimensions, score, level, explanations, status, created_at, row_version, schema_version,
              updated_at)
           VALUES ('cra-uncited', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'car-1', 6,
                   '{"payment":50}'::jsonb, 50, 'MODERATE',
                   '[{"dimension":"payment","sourceReferences":[]}]'::jsonb, 'DRAFT', ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(inserted)).toContain('explanations_cite_sources');
  }, 300_000);
});

describe('integration: Batch I analysis runs stay reproducible and attributable', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('refuses an AI-assisted run that cannot name what produced it', async () => {
    const database = await seeded();
    // For an AI-derived claim about a contract, being unable to say what produced it is the whole of its
    // evidential value gone: the finding can be neither reproduced nor attributed.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_analysis_runs
             (id, tenant_id, workspace_id, contract_id, contract_version_id, method, model_id,
              model_version, prompt_version, input_hash, output_hash, findings, status, requested_by,
              created_at, row_version, schema_version, updated_at)
           VALUES ('car-anon', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'AI_ASSISTED', NULL, NULL, NULL,
                   ${hash('b')}, ${hash('c')}, '[]'::jsonb, 'COMPLETED', ${ACTOR}, ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('model_is_attributed');
  }, 300_000);

  it('exempts INFO findings from the citation rule and nothing above it', async () => {
    const database = await seeded();
    const uncitedInfo = [record.finding({ id: 'f-info', severity: 'INFO', sourceReferences: [] })];
    // An informational note is an observation. A DETERMINISTIC run needs no model attribution either, so
    // this insert isolates the citation rule.
    const accepted = await attempt(
      raw(
        database,
        (tx) =>
          tx`INSERT INTO contract_analysis_runs
               (id, tenant_id, workspace_id, contract_id, contract_version_id, method, input_hash,
                output_hash, findings, status, requested_by, created_at, row_version, schema_version,
                updated_at)
             VALUES ('car-info', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'DETERMINISTIC', ${hash('b')},
                     ${hash('7')}, ${tx.json(uncitedInfo as never)}, 'COMPLETED', ${ACTOR}, ${stamp}, 1,
                     1, ${stamp})`,
      ),
    );
    expect(String(accepted)).not.toContain('findings_cite_sources');

    const uncitedHigh = [record.finding({ id: 'f-high', sourceReferences: [] })];
    const refused = await attempt(
      raw(
        database,
        (tx) =>
          tx`INSERT INTO contract_analysis_runs
               (id, tenant_id, workspace_id, contract_id, contract_version_id, method, input_hash,
                output_hash, findings, status, requested_by, created_at, row_version, schema_version,
                updated_at)
             VALUES ('car-high', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'DETERMINISTIC', ${hash('b')},
                     ${hash('8')}, ${tx.json(uncitedHigh as never)}, 'COMPLETED', ${ACTOR}, ${stamp}, 1,
                     1, ${stamp})`,
      ),
    );
    expect(String(refused)).toContain('findings_cite_sources');
  }, 300_000);

  it('refuses a findings value that is not an array at all', async () => {
    const database = await seeded();
    // The predicate opens with a CASE on `jsonb_typeof` rather than relying on `AND` to short-circuit:
    // `jsonb_array_length` raises on a scalar, and a constraint that raises gives a puzzle in place of a
    // diagnosis. This asserts the clean refusal, naming the rule.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_analysis_runs
             (id, tenant_id, workspace_id, contract_id, contract_version_id, method, input_hash,
              output_hash, findings, status, requested_by, created_at, row_version, schema_version,
              updated_at)
           VALUES ('car-scalar', ${TENANT}, ${WORKSPACE}, 'c-1', 'cv-1', 'MANUAL', ${hash('b')},
                   ${hash('9')}, '"none"'::jsonb, 'COMPLETED', ${ACTOR}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('findings_cite_sources');
    expect(String(failure)).not.toContain('cannot get array length');
  }, 300_000);

  it('refuses rewriting or deleting a run and a review', async () => {
    const database = await seeded();
    expect([...BATCH_I_APPEND_ONLY_COLLECTIONS]).toHaveLength(2);
    for (const table of ['contract_analysis_runs', 'analysis_reviews'] as const) {
      const updated = await attempt(
        raw(database, (tx) => tx.unsafe(`UPDATE ${table} SET workspace_id = workspace_id WHERE true`)),
      );
      expect(String(updated), table).toContain('append-only');
      const deleted = await attempt(raw(database, (tx) => tx.unsafe(`DELETE FROM ${table} WHERE true`)));
      // Withholding UPDATE from the runtime role is the other half; the trigger is what an operator who
      // granted it in a hurry still cannot get past.
      expect(String(deleted), table).toContain('append-only');
    }
  }, 300_000);

  it('refuses rewriting the two leaf tables no engine writes', async () => {
    const database = await seeded();
    for (const table of BATCH_I_CONVERGED_NOT_ROUTED_TABLES) {
      const deleted = await attempt(raw(database, (tx) => tx.unsafe(`DELETE FROM ${table} WHERE true`)));
      // Nothing writes them, so nothing may rewrite them either. The rows are absent, but a BEFORE trigger
      // fires per row — so this proves the boundary exists rather than that a statement matched nothing.
      expect(String(deleted), table).not.toContain('does not exist');
    }
    const triggers = await raw(database, (tx) =>
      tx<{ tgrelid: string }[]>`
        SELECT c.relname AS tgrelid FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND c.relname = ANY(${BATCH_I_CONVERGED_NOT_ROUTED_TABLES as string[]})
          AND t.tgname LIKE '%_append_only'
      `,
    );
    expect(triggers.map((row) => row.tgrelid).sort()).toEqual([
      ...BATCH_I_CONVERGED_NOT_ROUTED_TABLES,
    ]);
  }, 300_000);

  it('reports the store’s own refusal for an append-only collection', async () => {
    const database = await seeded();
    const refused = await as(database, (store) =>
      attempt(store.replace('contractAnalysisRuns', record.run({ status: 'SUPERSEDED' }))),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

    const review = await as(database, (store) =>
      attempt(store.replace('analysisReviews', record.review({ decision: 'REJECTED' }))),
    );
    expect((review as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
  }, 300_000);
});

describe('integration: Batch I contract versions and repository documents', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('refuses two live versions of one agreement', async () => {
    const database = await seeded();
    // `registerExecuted` marks the prior version SUPERSEDED, having read the set first — which two
    // concurrent registrations both clear. This partial index is what actually prevents the second, and an
    // agreement with two live versions is an agreement with two sets of terms.
    const failure = await attempt(
      as(database, (store) =>
        store.append(
          'contractVersionsV2',
          record.version({ id: 'cv-2', number: 2, documentHash: hash('1'), supersedesId: 'cv-1' }),
        ),
      ),
    );
    expect(String(failure)).toContain('one_active_per_contract');

    // Superseding the first, then registering the second, is the sequence the engine performs — and it is
    // accepted, so the index constrains concurrency rather than the workflow.
    await as(database, (store) =>
      store.replace('contractVersionsV2', record.version({ status: 'SUPERSEDED' })),
    );
    await as(database, (store) =>
      store.append(
        'contractVersionsV2',
        record.version({ id: 'cv-2', number: 2, documentHash: hash('1'), supersedesId: 'cv-1' }),
      ),
    );
    const versions = await as(database, (store) =>
      store.list<{ id: string; status: string }>('contractVersionsV2'),
    );
    expect(versions.map((row) => `${row.id}:${row.status}`).sort()).toEqual([
      'cv-1:SUPERSEDED',
      'cv-2:ACTIVE',
    ]);
  }, 300_000);

  it('refuses rewriting the hash a document is verified against', async () => {
    const database = await seeded();
    // `verify()` compares a document against `document_hash`, so a mutable one makes verification a
    // comparison against whatever was most recently claimed.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE contract_versions_v2
           SET document_hash = ${hash('2')}, row_version = row_version + 1 WHERE id = 'cv-1'`,
      ),
    );
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('document_hash');

    const revision = await attempt(
      raw(database, (tx) =>
        tx`UPDATE contract_versions_v2
           SET version_number = 9, row_version = row_version + 1 WHERE id = 'cv-1'`,
      ),
    );
    // `version_number` is the revision the row *is*, not a counter, so it cannot move either.
    expect(String(revision)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
  }, 300_000);

  it('refuses a transition that does not advance the row counter', async () => {
    const database = await seeded();
    // None of these six owns a domain `version` that doubles as a counter, so `row_version` is separate and
    // a transition that leaves it alone is a lost update waiting to happen.
    const failure = await attempt(
      raw(database, (tx) => tx`UPDATE contract_versions_v2 SET status = 'SUPERSEDED' WHERE id = 'cv-1'`),
    );
    expect(String(failure)).toContain('row_version');
  }, 300_000);

  it('refuses a version that supersedes itself', async () => {
    const database = await seeded();
    // A self-reference would set the new version's own status to SUPERSEDED and leave the chain pointing at
    // nothing.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_versions_v2
             (id, tenant_id, workspace_id, contract_id, version_number, version_kind, document_reference,
              document_hash, execution_certificate_id, status, supersedes_id, created_at, row_version,
              schema_version, updated_at)
           VALUES ('cv-self', ${TENANT}, ${WORKSPACE}, 'c-2', 1, 'EXECUTED', 'vault://c-2/v1.pdf',
                   ${hash('3')}, 'ec-2', 'SUPERSEDED', 'cv-self', ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('supersedes_another');
  }, 300_000);

  it('stores PDF and Word documents only', async () => {
    const database = await seeded();
    expect([...REPOSITORY_MIME_TYPES]).toHaveLength(2);
    // `MIME_NOT_ALLOWED` in the engine. A repository that will hold any bytes under any type is not a
    // controlled one, and the classification beside it is what governs who may read them.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_repository_documents
             (id, tenant_id, workspace_id, contract_version_id, storage_reference, content_hash, mime_type,
              classification, tags, ocr_text_reference, legal_hold, created_at, row_version, schema_version,
              updated_at)
           VALUES ('crd-exe', ${TENANT}, ${WORKSPACE}, 'cv-1', 'vault://c-1/payload.exe', ${hash('4')},
                   'application/x-msdownload', 'INTERNAL', '[]'::jsonb, NULL, false, ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('mime_is_allowed');
  }, 300_000);

  it('moves a legal hold and nothing else', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.replace('repositoryDocuments', record.document({ legalHold: true })),
    );
    const [held] = await as(database, (store) =>
      store.list<{ legalHold: boolean; storageReference: string }>('repositoryDocuments'),
    );
    expect(held.legalHold).toBe(true);

    // A mutable storage reference would let the bytes behind a hold be swapped for others while the hold
    // still read as applying to the original.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`UPDATE contract_repository_documents
           SET storage_reference = 'vault://elsewhere.pdf', row_version = row_version + 1
           WHERE id = 'crd-1'`,
      ),
    );
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('storage_reference');
  }, 300_000);
});

describe('integration: Batch I tenancy, and the keys 202608110012 owes back', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundIntelligence(database);
    await foundIntelligence(database, OTHER_TENANT, OTHER_WORKSPACE, '-o');
  });

  it('shows another tenant only its own readings', async () => {
    const database = await seeded();
    const mine = await as(database, (store) =>
      store.list<{ id: string }>('agreementIntelligenceVersions'),
    );
    expect(mine.map((row) => row.id)).toEqual(['aiv-1']);

    const theirs = await as(
      database,
      (store) => store.list<{ id: string }>('agreementIntelligenceVersions'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(theirs.map((row) => row.id)).toEqual(['aiv-1-o']);
  }, 300_000);

  it('lets two tenants number a contract version the same, which a global key had prevented', async () => {
    const database = await seeded();
    // `UNIQUE(contract_id, version_number)` was tenant-blind: whichever tenant first held
    // `('c-1', 1)` held it against every other one, permanently. Both seeds above register version 1 of a
    // contract called `c-1`, which is only possible because `202608110012` re-added the key scoped.
    const numbered = await raw(database, (tx) =>
      tx<{ tenant_id: string; contract_id: string; version_number: number }[]>`
        SELECT tenant_id, contract_id, version_number FROM contract_versions_v2
        WHERE version_number = 1 ORDER BY tenant_id
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    // Read as the other tenant, so row-level security shows one; the count across both is what the key
    // permits, and the seed succeeding at all is the proof.
    expect(numbered).toHaveLength(1);

    const mine = await as(database, (store) =>
      store.list<{ contractId: string; number: number }>('contractVersionsV2'),
    );
    expect(mine[0]).toMatchObject({ contractId: 'c-1', number: 1 });
  }, 300_000);

  it('refuses a second assessment claiming the same revision', async () => {
    const database = await seeded();
    // `assess()` derives the revision from a count of what exists, which two concurrent calls both read.
    // Step 3 of the migration dropped the tenant-blind `UNIQUE(contract_version_id, version)`; this is the
    // scoped key it owes back, and without it a contract version carries two "version 1"s with neither the
    // successor of the other.
    const failure = await attempt(
      as(database, (store) =>
        store.append('contractRiskAssessments', record.assessment({ id: 'cra-dup', version: 1 })),
      ),
    );
    expect(String(failure)).toContain('contract_risk_assessments_ws_version_unique');
  }, 300_000);

  it('refuses a second reading claiming the same revision', async () => {
    const database = await seeded();
    const failure = await attempt(
      as(database, (store) =>
        store.append('agreementIntelligenceVersions', record.intelligence({ id: 'aiv-dup', version: 1 })),
      ),
    );
    expect(String(failure)).toContain('agreement_intelligence_versions_ws_version_unique');
  }, 300_000);

  it('refuses two contradictory decisions from one reviewer on one finding', async () => {
    const database = await seeded();
    // `review()` does not check, so without this key a reviewer could record ACCEPTED and REJECTED on the
    // same finding and the evidence would not say which stood.
    const failure = await attempt(
      as(database, (store) =>
        store.append('analysisReviews', record.review({ id: 'ar-2', decision: 'REJECTED' })),
      ),
    );
    expect(String(failure)).toContain('analysis_reviews_one_per_reviewer_finding');

    // A different reviewer on the same finding is permitted: two people may disagree, and that is a record
    // of disagreement rather than a contradiction in one person's position.
    await as(database, (store) =>
      store.append(
        'analysisReviews',
        record.review({ id: 'ar-3', reviewerId: 'user-second-reviewer', decision: 'REJECTED' }),
      ),
    );
    const reviews = await as(database, (store) => store.list<{ id: string }>('analysisReviews'));
    expect(reviews.map((row) => row.id).sort()).toEqual(['ar-1', 'ar-3']);
  }, 300_000);

  it('refuses a child row referencing a parent in another tenant', async () => {
    const database = await seeded();
    // The composite `(tenant_id, workspace_id, id)` keys are what make this a foreign-key failure rather
    // than a row another tenant can reach: `cv-1-o` exists, in the other tenant.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO contract_repository_documents
             (id, tenant_id, workspace_id, contract_version_id, storage_reference, content_hash, mime_type,
              classification, tags, ocr_text_reference, legal_hold, created_at, row_version, schema_version,
              updated_at)
           VALUES ('crd-cross', ${TENANT}, ${WORKSPACE}, 'cv-1-o', 'vault://x.pdf', ${hash('5')},
                   'application/pdf', 'INTERNAL', '[]'::jsonb, NULL, false, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('contract_repository_documents_version_fk');
  }, 300_000);
});
