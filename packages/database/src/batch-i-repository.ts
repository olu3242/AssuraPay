import {
  BATCH_I_AGGREGATES,
  BATCH_I_SCHEMA_VERSION,
  batchIContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch I — the six agreement-intelligence aggregates of canonical
 * Engines 16-20.
 *
 * ## What this replaces
 *
 * Nothing, for the ninth time and the same reason: these collections were absent from the store's routing
 * table, so `PostgresTrustStore` refused every one of them with `PERSISTENCE_COLLECTION_NOT_MAPPED`. One of
 * them, `analysisReviews`, had no *table* either — a reviewer's decision on a finding had nowhere to go at
 * all until `202608110012`.
 *
 * **Six aggregates, not five.** `contractVersionsV2` is written by `ContractVersionEngine` and was in
 * neither the register nor the coverage baseline, because that gate's name pattern excluded digits. It is
 * the parent of four of the other five, so finding it is what made this closure tractable.
 *
 * ## Two of the six are append-only, and the reasons differ
 *
 * A run is a measurement taken at a moment: `analyze()` appends one and `review()` records a decision
 * *beside* it rather than editing it, which is why `analysisReviews` exists as its own aggregate. A review
 * is one reviewer's position on one finding, and the database holds one per reviewer per finding — without
 * that, a reviewer could record two contradictory decisions and the evidence would not say which stood.
 *
 * The other four transition, and each `update` writes only what its engine moves: a version's status, an
 * assessment's status, a document's legal hold, and an intelligence version's status and items.
 *
 * ## Column names that differ from the domain
 *
 * `contract_versions_v2` stores `version_number` and `version_kind` for the domain's `number` and `kind`.
 * The engine is the authority on the name and the table on the column, so the mapping lives here rather
 * than being smoothed over in either direction.
 *
 * ## Reading these rows
 *
 * The child collections arrive as parsed `jsonb` — `findings`, `items`, `dimensions`, `explanations`,
 * `tags` — and their shape is the schema's business. `score` is a plain integer. Nothing here is money, so
 * there is no `bigint` conversion in this batch: the amounts these aggregates reason about live in
 * Batch H's payment triggers.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchIRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The `<table>_append_only` trigger and the
   * withheld UPDATE privilege are the authority; this flag only makes the refusal legible.
   */
  readonly appendOnly: boolean;
  list(sql: SqlClient): Promise<Row[]>;
  insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
  /** Rows affected. Zero means the record does not exist, or lies outside the caller's scope. */
  update(sql: SqlClient, record: Row): Promise<number>;
};

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

function contractFor(collection: string) {
  const contract = batchIContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch I aggregate`,
    );
  return contract;
}

/** The aggregate's canonical schema, applied before the statement rather than after it. */
function validateForWrite(collection: string, value: unknown): Row {
  const result = contractFor(collection).schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_SCHEMA_VIOLATION',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data as Row;
}

/**
 * The same schema, applied on the way out.
 *
 * A failure here is a data-integrity incident rather than a caller error. For this batch the sharpest case
 * is a published intelligence version containing an unreviewed item: those items become parties, milestones
 * and payment triggers downstream, so an unreviewed one is an unverified term entering the settlement path.
 */
function validateFromRow(collection: string, value: unknown): Row {
  const result = contractFor(collection).schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data as Row;
}

function requireSupportedSchemaVersion(collection: string, row: Row): void {
  const declared = row.schema_version;
  const version = typeof declared === 'number' ? declared : Number(declared);
  if (!Number.isInteger(version) || version < 1)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: schema_version is not a positive integer`,
    );
  if (version > BATCH_I_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_I_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry extracted contract terms, review rationales
  // and storage references, and a storage reference is a capability rather than a description.
  throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', `${collection}.${column} ${why}`);
}

function text(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
}

function optionalText(collection: string, row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return text(collection, row, column);
}

function instant(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return corrupt(collection, column, 'is not a timestamp');
}

function integer(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) corrupt(collection, column, 'is not an integer');
  return parsed;
}

function boolean(collection: string, row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') corrupt(collection, column, 'is not a boolean');
  return value as boolean;
}

/** A `jsonb` column, already parsed by the driver. Its shape is the schema's business. */
function json(row: Row, column: string): unknown {
  return row[column];
}

function compact(record: Row): Row {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

function requireId(collection: string, record: Row): string {
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0)
    throw new PostgresStoreError('PERSISTENCE_RECORD_ID_REQUIRED', `${collection} record has no id`);
  return id;
}

function relation(
  collection: string,
  table: string,
  operations: {
    list(sql: SqlClient): Promise<Row[]>;
    insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
    update?(sql: SqlClient, record: Row): Promise<number>;
  },
): BatchIRelation {
  return {
    collection,
    table,
    appendOnly: operations.update === undefined,
    list: operations.list,
    insert: operations.insert,
    update:
      operations.update ??
      (async () => {
        throw new PostgresStoreError(
          'PERSISTENCE_HISTORY_IMMUTABLE',
          `${collection} is append-only; no canonical engine transitions it and the ${table}_append_only trigger refuses the statement`,
        );
      }),
  };
}

// ---------------------------------------------------------------------------------------
// Engine 16 — Contract Version
// ---------------------------------------------------------------------------------------

const contractVersionsV2 = relation('contractVersionsV2', 'contract_versions_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, version_number, version_kind, document_reference,
             document_hash, execution_certificate_id, status, supersedes_id, created_at, schema_version
      FROM contract_versions_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('contractVersionsV2', row);
      return validateFromRow(
        'contractVersionsV2',
        compact({
          id: text('contractVersionsV2', row, 'id'),
          workspaceId: text('contractVersionsV2', row, 'workspace_id'),
          contractId: text('contractVersionsV2', row, 'contract_id'),
          // The table says `version_number` and the domain says `number`.
          number: integer('contractVersionsV2', row, 'version_number'),
          kind: text('contractVersionsV2', row, 'version_kind'),
          documentReference: text('contractVersionsV2', row, 'document_reference'),
          documentHash: text('contractVersionsV2', row, 'document_hash'),
          executionCertificateId: text('contractVersionsV2', row, 'execution_certificate_id'),
          status: text('contractVersionsV2', row, 'status'),
          supersedesId: optionalText('contractVersionsV2', row, 'supersedes_id'),
          createdAt: instant('contractVersionsV2', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('contractVersionsV2', value);
    await sql`
      INSERT INTO contract_versions_v2
        (id, tenant_id, workspace_id, contract_id, version_number, version_kind, document_reference,
         document_hash, execution_certificate_id, status, supersedes_id, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.number as number}, ${record.kind as string},
        ${record.documentReference as string}, ${record.documentHash as string},
        ${record.executionCertificateId as string}, ${record.status as string},
        ${(record.supersedesId as string | undefined) ?? null}, ${record.createdAt as string}, 1,
        ${BATCH_I_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Status only. `registerExecuted` marks the prior version SUPERSEDED and nothing else moves: the document
  // hash is what `verify()` compares a document against, so a mutable one would make verification a
  // comparison against whatever was most recently claimed.
  async update(sql, value) {
    const record = validateForWrite('contractVersionsV2', value);
    const rows = await sql<Row[]>`
      UPDATE contract_versions_v2
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('contractVersionsV2', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 17 — Contract Analysis
// ---------------------------------------------------------------------------------------

// No `update`. A run is a measurement taken at a moment; a re-analysis is a new run, and a decision about
// one of its findings is an `analysisReviews` row beside it.
const contractAnalysisRuns = relation('contractAnalysisRuns', 'contract_analysis_runs', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, contract_version_id, method, model_id, model_version,
             prompt_version, input_hash, output_hash, findings, status, requested_by, created_at,
             schema_version
      FROM contract_analysis_runs ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('contractAnalysisRuns', row);
      return validateFromRow(
        'contractAnalysisRuns',
        compact({
          id: text('contractAnalysisRuns', row, 'id'),
          workspaceId: text('contractAnalysisRuns', row, 'workspace_id'),
          contractId: text('contractAnalysisRuns', row, 'contract_id'),
          contractVersionId: text('contractAnalysisRuns', row, 'contract_version_id'),
          method: text('contractAnalysisRuns', row, 'method'),
          modelId: optionalText('contractAnalysisRuns', row, 'model_id'),
          modelVersion: optionalText('contractAnalysisRuns', row, 'model_version'),
          promptVersion: optionalText('contractAnalysisRuns', row, 'prompt_version'),
          inputHash: text('contractAnalysisRuns', row, 'input_hash'),
          outputHash: text('contractAnalysisRuns', row, 'output_hash'),
          findings: json(row, 'findings'),
          status: text('contractAnalysisRuns', row, 'status'),
          requestedBy: text('contractAnalysisRuns', row, 'requested_by'),
          createdAt: instant('contractAnalysisRuns', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('contractAnalysisRuns', value);
    await sql`
      INSERT INTO contract_analysis_runs
        (id, tenant_id, workspace_id, contract_id, contract_version_id, method, model_id, model_version,
         prompt_version, input_hash, output_hash, findings, status, requested_by, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.contractVersionId as string},
        ${record.method as string}, ${(record.modelId as string | undefined) ?? null},
        ${(record.modelVersion as string | undefined) ?? null},
        ${(record.promptVersion as string | undefined) ?? null}, ${record.inputHash as string},
        ${record.outputHash as string}, ${sql.json(record.findings as never)},
        ${record.status as string}, ${record.requestedBy as string}, ${record.createdAt as string}, 1,
        ${BATCH_I_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// No `update`. A review is one reviewer's position on one finding, held to one per reviewer per finding by
// the database — without which a reviewer could record two contradictory decisions and the evidence would
// not say which stood.
const analysisReviews = relation('analysisReviews', 'analysis_reviews', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, run_id, finding_id, decision, notes, reviewer_id, created_at,
             schema_version
      FROM analysis_reviews ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('analysisReviews', row);
      return validateFromRow('analysisReviews', {
        id: text('analysisReviews', row, 'id'),
        workspaceId: text('analysisReviews', row, 'workspace_id'),
        runId: text('analysisReviews', row, 'run_id'),
        findingId: text('analysisReviews', row, 'finding_id'),
        decision: text('analysisReviews', row, 'decision'),
        notes: text('analysisReviews', row, 'notes'),
        reviewerId: text('analysisReviews', row, 'reviewer_id'),
        createdAt: instant('analysisReviews', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('analysisReviews', value);
    await sql`
      INSERT INTO analysis_reviews
        (id, tenant_id, workspace_id, run_id, finding_id, decision, notes, reviewer_id, created_at,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.runId as string}, ${record.findingId as string}, ${record.decision as string},
        ${record.notes as string}, ${record.reviewerId as string}, ${record.createdAt as string},
        ${BATCH_I_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 18 — Contract Risk
// ---------------------------------------------------------------------------------------

const contractRiskAssessments = relation('contractRiskAssessments', 'contract_risk_assessments', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, contract_version_id, analysis_run_id, version, dimensions,
             score, level, explanations, status, created_at, schema_version
      FROM contract_risk_assessments ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('contractRiskAssessments', row);
      return validateFromRow('contractRiskAssessments', {
        id: text('contractRiskAssessments', row, 'id'),
        workspaceId: text('contractRiskAssessments', row, 'workspace_id'),
        contractId: text('contractRiskAssessments', row, 'contract_id'),
        contractVersionId: text('contractRiskAssessments', row, 'contract_version_id'),
        analysisRunId: text('contractRiskAssessments', row, 'analysis_run_id'),
        version: integer('contractRiskAssessments', row, 'version'),
        dimensions: json(row, 'dimensions'),
        score: integer('contractRiskAssessments', row, 'score'),
        level: text('contractRiskAssessments', row, 'level'),
        explanations: json(row, 'explanations'),
        status: text('contractRiskAssessments', row, 'status'),
        createdAt: instant('contractRiskAssessments', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('contractRiskAssessments', value);
    await sql`
      INSERT INTO contract_risk_assessments
        (id, tenant_id, workspace_id, contract_id, contract_version_id, analysis_run_id, version,
         dimensions, score, level, explanations, status, created_at, row_version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.contractVersionId as string},
        ${record.analysisRunId as string}, ${record.version as number},
        ${sql.json(record.dimensions as never)}, ${record.score as number},
        ${record.level as string}, ${sql.json(record.explanations as never)},
        ${record.status as string}, ${record.createdAt as string}, 1, ${BATCH_I_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // Status only, which is all `validate()` moves. The dimensions, the score and the level are the
  // assessment: an assessment whose score could be rewritten after validation is a risk rating that can be
  // lowered once it has been signed off.
  async update(sql, value) {
    const record = validateForWrite('contractRiskAssessments', value);
    const rows = await sql<Row[]>`
      UPDATE contract_risk_assessments
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('contractRiskAssessments', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 19 — Contract Repository
// ---------------------------------------------------------------------------------------

const repositoryDocuments = relation('repositoryDocuments', 'contract_repository_documents', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_version_id, storage_reference, content_hash, mime_type,
             classification, tags, ocr_text_reference, legal_hold, created_at, schema_version
      FROM contract_repository_documents ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('repositoryDocuments', row);
      return validateFromRow(
        'repositoryDocuments',
        compact({
          id: text('repositoryDocuments', row, 'id'),
          workspaceId: text('repositoryDocuments', row, 'workspace_id'),
          contractVersionId: text('repositoryDocuments', row, 'contract_version_id'),
          storageReference: text('repositoryDocuments', row, 'storage_reference'),
          contentHash: text('repositoryDocuments', row, 'content_hash'),
          mimeType: text('repositoryDocuments', row, 'mime_type'),
          classification: text('repositoryDocuments', row, 'classification'),
          tags: json(row, 'tags'),
          ocrTextReference: optionalText('repositoryDocuments', row, 'ocr_text_reference'),
          legalHold: boolean('repositoryDocuments', row, 'legal_hold'),
          createdAt: instant('repositoryDocuments', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('repositoryDocuments', value);
    await sql`
      INSERT INTO contract_repository_documents
        (id, tenant_id, workspace_id, contract_version_id, storage_reference, content_hash, mime_type,
         classification, tags, ocr_text_reference, legal_hold, created_at, row_version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractVersionId as string}, ${record.storageReference as string},
        ${record.contentHash as string}, ${record.mimeType as string},
        ${record.classification as string}, ${sql.json(record.tags as never)},
        ${(record.ocrTextReference as string | undefined) ?? null}, ${record.legalHold as boolean},
        ${record.createdAt as string}, 1, ${BATCH_I_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // The legal hold, which is the one thing `hold()` sets. The storage reference and the content hash are
  // what identify the document, and a mutable storage reference would let the bytes behind a hold be
  // swapped for others while the hold still read as applying to the original.
  async update(sql, value) {
    const record = validateForWrite('repositoryDocuments', value);
    const rows = await sql<Row[]>`
      UPDATE contract_repository_documents
      SET legal_hold = ${record.legalHold as boolean},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('repositoryDocuments', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 20 — Agreement Intelligence
// ---------------------------------------------------------------------------------------

const agreementIntelligenceVersions = relation(
  'agreementIntelligenceVersions',
  'agreement_intelligence_versions',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, contract_id, contract_version_id, version, items, status, created_by,
               created_at, content_hash, schema_version
        FROM agreement_intelligence_versions ORDER BY created_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('agreementIntelligenceVersions', row);
        return validateFromRow('agreementIntelligenceVersions', {
          id: text('agreementIntelligenceVersions', row, 'id'),
          workspaceId: text('agreementIntelligenceVersions', row, 'workspace_id'),
          contractId: text('agreementIntelligenceVersions', row, 'contract_id'),
          contractVersionId: text('agreementIntelligenceVersions', row, 'contract_version_id'),
          version: integer('agreementIntelligenceVersions', row, 'version'),
          items: json(row, 'items'),
          status: text('agreementIntelligenceVersions', row, 'status'),
          createdBy: text('agreementIntelligenceVersions', row, 'created_by'),
          createdAt: instant('agreementIntelligenceVersions', row, 'created_at'),
          contentHash: text('agreementIntelligenceVersions', row, 'content_hash'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('agreementIntelligenceVersions', value);
      await sql`
        INSERT INTO agreement_intelligence_versions
          (id, tenant_id, workspace_id, contract_id, contract_version_id, version, items, status,
           created_by, created_at, content_hash, row_version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.contractId as string}, ${record.contractVersionId as string},
          ${record.version as number}, ${sql.json(record.items as never)}, ${record.status as string},
          ${record.createdBy as string}, ${record.createdAt as string},
          ${record.contentHash as string}, 1, ${BATCH_I_SCHEMA_VERSION}, ${record.createdAt as string}
        )
      `;
    },
    // Status and items both, because `review()` changes an item's review status in place while the version
    // is a draft. `content_hash` is immutable in the database, and that is only sound because the engine
    // digests what was extracted rather than the review statuses too — before that fix the stored hash
    // described a state that no longer existed the moment anything was reviewed.
    async update(sql, value) {
      const record = validateForWrite('agreementIntelligenceVersions', value);
      const rows = await sql<Row[]>`
        UPDATE agreement_intelligence_versions
        SET status = ${record.status as string},
            items = ${sql.json(record.items as never)},
            row_version = row_version + 1,
            updated_at = now()
        WHERE id = ${requireId('agreementIntelligenceVersions', record)}
        RETURNING id
      `;
      return rows.length;
    },
  },
);

export const BATCH_I_RELATIONS: Readonly<Record<string, BatchIRelation>> = Object.freeze(
  Object.fromEntries(
    [
      contractVersionsV2,
      contractAnalysisRuns,
      analysisReviews,
      contractRiskAssessments,
      repositoryDocuments,
      agreementIntelligenceVersions,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchICollection(collection: string): boolean {
  return Object.hasOwn(BATCH_I_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection is
 * Batch I's, and a silent undefined would become a lost write.
 */
export function batchIRelation(collection: string): BatchIRelation {
  const found = BATCH_I_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch I aggregate`,
    );
  return found;
}

export const BATCH_I_RELATION_COUNT = Object.keys(BATCH_I_RELATIONS).length;

if (BATCH_I_RELATION_COUNT !== BATCH_I_AGGREGATES.length)
  throw new Error(
    `${BATCH_I_RELATION_COUNT} relational repositories for ${BATCH_I_AGGREGATES.length} ` +
      'Batch I aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
