import {
  BATCH_F_AGGREGATES,
  BATCH_F_APPEND_ONLY_COLLECTIONS,
  BATCH_F_SCHEMA_VERSION,
  batchFContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch F — the fifteen agreement-creation aggregates of canonical
 * Engines 11-15.
 *
 * ## What this replaces
 *
 * Nothing, for the sixth time: all fifteen collections were absent from the store's routing table, so
 * `PostgresTrustStore` refused every one with `PERSISTENCE_COLLECTION_NOT_MAPPED`. Two of them —
 * `contractComments` and `signatureCallbacks` — had no *table* either, so a comment on a contract and a
 * consumed provider callback could not be stored anywhere at all.
 *
 * This closes the canonical chain. `agreements` is the eleventh and last link to gain a relational home.
 *
 * ## Four columns are not the snake_case of their field
 *
 * The schema has said so since `202608030002`, and this file is the only place in the codebase where the
 * two vocabularies are allowed to meet:
 *
 * | collection | field | column |
 * |---|---|---|
 * | `documentVersions` | `number` | `version` |
 * | `contractDrafts` | `documentVersionId` | `current_document_version_id` |
 * | `clauseVersions` | `guidance` | `guidance_reference` |
 * | `negotiationRounds` | `number` | `round_number` |
 *
 * Each is aliased in its `SELECT` and named explicitly in its `INSERT`, and the canonical schemas are
 * `.strict()`, so a mapping that forgot one produces an immediate validation failure rather than a
 * column of nulls. `documentVersions` is the sharpest of the four: the column it does *not* mean —
 * `version` — is a name three other tables in this batch use for a revision, and one this programme
 * uses for a row counter everywhere else.
 *
 * ## The concurrency column is `row_version`, including where `version` would have worked
 *
 * `contractDrafts.version` genuinely advances on every edit, so it could have carried concurrency for
 * that one table. It does not: a per-table exception is a rule a reader has to remember, and the value
 * arrives from the caller, so a caller that forgot to advance it would turn a stale-write refusal into a
 * silent overwrite. Every `update` here advances `row_version`, which the caller cannot see.
 *
 * `contract_drafts` is therefore the one governed table in the batch whose domain `version` is *not* in
 * the trigger's immutable list — the engine writes `d.version + 1` and the row must accept it.
 *
 * ## What the updates write
 *
 * Only the columns the engines actually change, which is not "status" everywhere:
 *
 *   - `agreement_drafts` — `variables`, `locked_by`, `current_document_version_id`, `status`, `version`;
 *   - `agreement_approval_requests` — `status` and `completed_steps`, which `decide` advances together;
 *   - `signature_packages_v2` — `status` and `signers`, which `callback` rewrites together;
 *   - `agreements_v2` and `approval_policies_v2` — `status`, which no engine writes today. They have an
 *     `update` because the database permits one: they are governed rather than append-only, and a store
 *     that refused what the database allows would be a second, quieter boundary disagreeing with the
 *     first.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchFRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when this aggregate's rows may never be updated. Either because it has no status column, or
   * because a blanket append-only trigger predating this batch still holds and no engine transitions it.
   * The database is the authority in both cases; this flag only makes the refusal legible.
   */
  readonly appendOnly: boolean;
  /**
   * Reads the collection.
   *
   * `lock` asks for the rows to be held for the rest of the surrounding transaction. Only the
   * aggregates an engine reads and then rewrites honour it; for the rest it is accepted and ignored,
   * because a lock outside a transaction is a no-op the caller should not have to reason about.
   */
  list(sql: SqlClient, options?: { readonly lock?: boolean }): Promise<Row[]>;
  insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
  /** Rows affected. Zero means the record does not exist, or lies outside the caller's scope. */
  update(sql: SqlClient, record: Row): Promise<number>;
};

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

function contractFor(collection: string) {
  const contract = batchFContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch F aggregate`,
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
  return result.data;
}

/**
 * The same schema, applied on the way out.
 *
 * A failure here is a data-integrity incident rather than a caller error. For this batch the sharpest
 * case is a digest: an execution certificate whose `canonicalHash` is not a digest is a contract whose
 * execution cannot be independently recomputed, which is the entire evidentiary claim of the aggregate.
 */
function validateFromRow(collection: string, value: unknown): Row {
  const result = contractFor(collection).schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data;
}

function requireSupportedSchemaVersion(collection: string, row: Row): void {
  const declared = row.schema_version;
  const version = typeof declared === 'number' ? declared : Number(declared);
  if (!Number.isInteger(version) || version < 1)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: schema_version is not a positive integer`,
    );
  if (version > BATCH_F_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_F_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry contract titles, negotiation positions,
  // privileged legal guidance and internal comments.
  throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', `${collection}.${column} ${why}`);
}

function text(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
}

function optionalTextColumn(collection: string, row: Row, column: string): string | undefined {
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

/**
 * An `INTEGER` column as a JavaScript number.
 *
 * Every integer in this batch is a revision number or a step count — small by construction, since each
 * is derived by counting rows. Refused rather than rounded all the same: a revision that does not
 * survive the conversion is a document lineage that cannot be ordered.
 */
function wholeNumber(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) corrupt(collection, column, 'is not a whole number');
  return parsed;
}

/** A `jsonb` column, already parsed by the driver. Its shape is the schema's business. */
function json(row: Row, column: string): unknown {
  return row[column];
}

function boolean(collection: string, row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') corrupt(collection, column, 'is not a boolean');
  return value as boolean;
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
    list(sql: SqlClient, options?: { readonly lock?: boolean }): Promise<Row[]>;
    insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
    update?(sql: SqlClient, record: Row): Promise<number>;
  },
): BatchFRelation {
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
          `${collection} is append-only; the ${table}_append_only trigger refuses the statement`,
        );
      }),
  };
}

// ---------------------------------------------------------------------------------------
// Engine 11 — Contract Authoring
// ---------------------------------------------------------------------------------------

const agreements = relation('agreements', 'agreements_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_number, title, contract_type, owner_user_id, status,
             created_at, version, schema_version
      FROM agreements_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agreements', row);
      return validateFromRow('agreements', {
        id: text('agreements', row, 'id'),
        workspaceId: text('agreements', row, 'workspace_id'),
        contractNumber: text('agreements', row, 'contract_number'),
        title: text('agreements', row, 'title'),
        contractType: text('agreements', row, 'contract_type'),
        ownerUserId: text('agreements', row, 'owner_user_id'),
        status: text('agreements', row, 'status'),
        createdAt: instant('agreements', row, 'created_at'),
        version: wholeNumber('agreements', row, 'version'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agreements', value);
    await sql`
      INSERT INTO agreements_v2
        (id, tenant_id, workspace_id, contract_number, title, contract_type, owner_user_id, status,
         created_at, version, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractNumber as string}, ${record.title as string},
        ${record.contractType as string}, ${record.ownerUserId as string},
        ${record.status as string}, ${record.createdAt as string}, ${record.version as number}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // No engine transitions an agreement today; the six states beyond DRAFT are the recorded gap in
  // `BATCH_F_UNREACHED_STATES`. The statement exists because `agreements_v2` is governed rather than
  // append-only, and a store refusing what the database permits would be a second boundary quietly
  // disagreeing with the first. `version` stays put: it is the revision the row is.
  async update(sql, value) {
    const record = validateForWrite('agreements', value);
    const rows = await sql<Row[]>`
      UPDATE agreements_v2
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('agreements', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const templateVersions = relation('templateVersions', 'contract_template_versions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, template_key, version, variable_schema, content_hash, status,
             created_by, created_at, schema_version
      FROM contract_template_versions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('templateVersions', row);
      return validateFromRow('templateVersions', {
        id: text('templateVersions', row, 'id'),
        workspaceId: text('templateVersions', row, 'workspace_id'),
        templateKey: text('templateVersions', row, 'template_key'),
        version: wholeNumber('templateVersions', row, 'version'),
        variableSchema: json(row, 'variable_schema'),
        contentHash: text('templateVersions', row, 'content_hash'),
        status: text('templateVersions', row, 'status'),
        createdBy: text('templateVersions', row, 'created_by'),
        createdAt: instant('templateVersions', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('templateVersions', value);
    await sql`
      INSERT INTO contract_template_versions
        (id, tenant_id, workspace_id, template_key, version, variable_schema, content_hash, status,
         created_by, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.templateKey as string}, ${record.version as number},
        ${sql.json(record.variableSchema)}, ${record.contentHash as string},
        ${record.status as string}, ${record.createdBy as string}, ${record.createdAt as string}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Publication, and the supersession of whichever version was published before it.
  async update(sql, value) {
    const record = validateForWrite('templateVersions', value);
    const rows = await sql<Row[]>`
      UPDATE contract_template_versions
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('templateVersions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. The `agreement_document_versions_append_only` trigger has held since `202608030002` and
// no engine transitions a document version: `revise` appends a new one and repoints the draft.
const documentVersions = relation('documentVersions', 'agreement_document_versions', {
  async list(sql) {
    // `version AS number`: the field is `number`, and `version` is what three other tables in this
    // batch call their revision.
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, draft_id, version, content_reference, content_hash,
             status, created_by, created_at, supersedes_id, ai_proposed, schema_version
      FROM agreement_document_versions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('documentVersions', row);
      return validateFromRow(
        'documentVersions',
        compact({
          id: text('documentVersions', row, 'id'),
          workspaceId: text('documentVersions', row, 'workspace_id'),
          contractId: text('documentVersions', row, 'contract_id'),
          draftId: text('documentVersions', row, 'draft_id'),
          number: wholeNumber('documentVersions', row, 'version'),
          contentReference: text('documentVersions', row, 'content_reference'),
          contentHash: text('documentVersions', row, 'content_hash'),
          status: text('documentVersions', row, 'status'),
          createdBy: text('documentVersions', row, 'created_by'),
          createdAt: instant('documentVersions', row, 'created_at'),
          supersedesId: optionalTextColumn('documentVersions', row, 'supersedes_id'),
          aiProposed: boolean('documentVersions', row, 'ai_proposed'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('documentVersions', value);
    await sql`
      INSERT INTO agreement_document_versions
        (id, tenant_id, workspace_id, contract_id, draft_id, version, content_reference,
         content_hash, status, created_by, created_at, supersedes_id, ai_proposed, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.draftId as string}, ${record.number as number},
        ${record.contentReference as string}, ${record.contentHash as string},
        ${record.status as string}, ${record.createdBy as string}, ${record.createdAt as string},
        ${(record.supersedesId as string | undefined) ?? null}, ${record.aiProposed as boolean}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

const contractDrafts = relation('contractDrafts', 'agreement_drafts', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, template_version_id, current_document_version_id,
             status, variables, locked_by, created_by, created_at, version, schema_version
      FROM agreement_drafts ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('contractDrafts', row);
      return validateFromRow(
        'contractDrafts',
        compact({
          id: text('contractDrafts', row, 'id'),
          workspaceId: text('contractDrafts', row, 'workspace_id'),
          contractId: text('contractDrafts', row, 'contract_id'),
          templateVersionId: text('contractDrafts', row, 'template_version_id'),
          documentVersionId: text('contractDrafts', row, 'current_document_version_id'),
          status: text('contractDrafts', row, 'status'),
          variables: json(row, 'variables'),
          lockedBy: optionalTextColumn('contractDrafts', row, 'locked_by'),
          createdBy: text('contractDrafts', row, 'created_by'),
          createdAt: instant('contractDrafts', row, 'created_at'),
          version: wholeNumber('contractDrafts', row, 'version'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('contractDrafts', value);
    await sql`
      INSERT INTO agreement_drafts
        (id, tenant_id, workspace_id, contract_id, template_version_id,
         current_document_version_id, status, variables, locked_by, created_by, created_at,
         version, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.templateVersionId as string},
        ${record.documentVersionId as string}, ${record.status as string},
        ${sql.json(record.variables)}, ${(record.lockedBy as string | undefined) ?? null},
        ${record.createdBy as string}, ${record.createdAt as string}, ${record.version as number},
        1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // The busiest update in the batch. `setVariables` writes variables, `lock` writes the locker,
  // `revise` repoints the current document version, `submit` writes the status — and every one of them
  // advances the domain `version`, which is why this is the one governed table where `version` is
  // mutable.
  async update(sql, value) {
    const record = validateForWrite('contractDrafts', value);
    const rows = await sql<Row[]>`
      UPDATE agreement_drafts
      SET status = ${record.status as string},
          variables = ${sql.json(record.variables)},
          locked_by = ${(record.lockedBy as string | undefined) ?? null},
          current_document_version_id = ${record.documentVersionId as string},
          version = ${record.version as number},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('contractDrafts', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A comment has no status, so there is nothing to transition; `contract_comments` is one of
// the two tables `202608110005` creates.
const contractComments = relation('contractComments', 'contract_comments', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, body, visibility, author_id, created_at, schema_version
      FROM contract_comments ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('contractComments', row);
      return validateFromRow('contractComments', {
        id: text('contractComments', row, 'id'),
        workspaceId: text('contractComments', row, 'workspace_id'),
        contractId: text('contractComments', row, 'contract_id'),
        body: text('contractComments', row, 'body'),
        visibility: text('contractComments', row, 'visibility'),
        authorId: text('contractComments', row, 'author_id'),
        createdAt: instant('contractComments', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('contractComments', value);
    await sql`
      INSERT INTO contract_comments
        (id, tenant_id, workspace_id, contract_id, body, visibility, author_id, created_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.body as string}, ${record.visibility as string},
        ${record.authorId as string}, ${record.createdAt as string}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 12 — Clause Intelligence
// ---------------------------------------------------------------------------------------

const clauseVersions = relation('clauseVersions', 'clause_versions_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, clause_key, version, body_hash, risk, guidance_reference, status,
             created_at, schema_version
      FROM clause_versions_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('clauseVersions', row);
      return validateFromRow('clauseVersions', {
        id: text('clauseVersions', row, 'id'),
        workspaceId: text('clauseVersions', row, 'workspace_id'),
        clauseKey: text('clauseVersions', row, 'clause_key'),
        version: wholeNumber('clauseVersions', row, 'version'),
        bodyHash: text('clauseVersions', row, 'body_hash'),
        risk: text('clauseVersions', row, 'risk'),
        guidance: text('clauseVersions', row, 'guidance_reference'),
        status: text('clauseVersions', row, 'status'),
        createdAt: instant('clauseVersions', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('clauseVersions', value);
    await sql`
      INSERT INTO clause_versions_v2
        (id, tenant_id, workspace_id, clause_key, version, body_hash, risk, guidance_reference,
         status, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.clauseKey as string}, ${record.version as number},
        ${record.bodyHash as string}, ${record.risk as string}, ${record.guidance as string},
        ${record.status as string}, ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // Publication and retirement.
  async update(sql, value) {
    const record = validateForWrite('clauseVersions', value);
    const rows = await sql<Row[]>`
      UPDATE clause_versions_v2
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('clauseVersions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A clause instance has no status: an instance is replaced by inserting another, and the
// deviation against it is its own aggregate.
const clauseInstances = relation('clauseInstances', 'clause_instances_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, draft_id, clause_version_id, body_hash, source, created_at,
             schema_version
      FROM clause_instances_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('clauseInstances', row);
      return validateFromRow(
        'clauseInstances',
        compact({
          id: text('clauseInstances', row, 'id'),
          workspaceId: text('clauseInstances', row, 'workspace_id'),
          draftId: text('clauseInstances', row, 'draft_id'),
          clauseVersionId: optionalTextColumn('clauseInstances', row, 'clause_version_id'),
          bodyHash: text('clauseInstances', row, 'body_hash'),
          source: text('clauseInstances', row, 'source'),
          createdAt: instant('clauseInstances', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('clauseInstances', value);
    await sql`
      INSERT INTO clause_instances_v2
        (id, tenant_id, workspace_id, draft_id, clause_version_id, body_hash, source, created_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.draftId as string}, ${(record.clauseVersionId as string | undefined) ?? null},
        ${record.bodyHash as string}, ${record.source as string}, ${record.createdAt as string}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

const clauseDeviations = relation('clauseDeviations', 'clause_deviations_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, instance_id, baseline_version_id, risk, summary, status, created_at,
             schema_version
      FROM clause_deviations_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('clauseDeviations', row);
      return validateFromRow('clauseDeviations', {
        id: text('clauseDeviations', row, 'id'),
        workspaceId: text('clauseDeviations', row, 'workspace_id'),
        instanceId: text('clauseDeviations', row, 'instance_id'),
        baselineVersionId: text('clauseDeviations', row, 'baseline_version_id'),
        risk: text('clauseDeviations', row, 'risk'),
        summary: text('clauseDeviations', row, 'summary'),
        status: text('clauseDeviations', row, 'status'),
        createdAt: instant('clauseDeviations', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('clauseDeviations', value);
    await sql`
      INSERT INTO clause_deviations_v2
        (id, tenant_id, workspace_id, instance_id, baseline_version_id, risk, summary, status,
         created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.instanceId as string}, ${record.baselineVersionId as string},
        ${record.risk as string}, ${record.summary as string}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Review. `risk` is immutable: it is copied from the baseline clause version, so a deviation cannot
  // be talked down to a lower grade than the clause it departs from.
  async update(sql, value) {
    const record = validateForWrite('clauseDeviations', value);
    const rows = await sql<Row[]>`
      UPDATE clause_deviations_v2
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('clauseDeviations', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 13 — Negotiation
// ---------------------------------------------------------------------------------------

const negotiationRounds = relation('negotiationRounds', 'negotiation_rounds', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, round_number, submitted_by, document_version_id,
             status, mandatory_open_items, created_at, schema_version
      FROM negotiation_rounds ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('negotiationRounds', row);
      return validateFromRow('negotiationRounds', {
        id: text('negotiationRounds', row, 'id'),
        workspaceId: text('negotiationRounds', row, 'workspace_id'),
        contractId: text('negotiationRounds', row, 'contract_id'),
        number: wholeNumber('negotiationRounds', row, 'round_number'),
        submittedBy: text('negotiationRounds', row, 'submitted_by'),
        documentVersionId: text('negotiationRounds', row, 'document_version_id'),
        status: text('negotiationRounds', row, 'status'),
        mandatoryOpenItems: json(row, 'mandatory_open_items'),
        createdAt: instant('negotiationRounds', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('negotiationRounds', value);
    await sql`
      INSERT INTO negotiation_rounds
        (id, tenant_id, workspace_id, contract_id, round_number, submitted_by,
         document_version_id, status, mandatory_open_items, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.number as number},
        ${record.submittedBy as string}, ${record.documentVersionId as string},
        ${record.status as string}, ${sql.json(record.mandatoryOpenItems)},
        ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Withdrawal and acceptance. `mandatory_open_items` is immutable: `accept` refuses a round with any
  // item outstanding, and a rule enforced by reading a list is worthless if the list can be emptied on
  // the way to enforcing it.
  async update(sql, value) {
    const record = validateForWrite('negotiationRounds', value);
    const rows = await sql<Row[]>`
      UPDATE negotiation_rounds
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('negotiationRounds', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 14 — Approval Workflow
// ---------------------------------------------------------------------------------------

const approvalPolicies = relation('approvalPolicies', 'approval_policies_v2', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, version, steps, status, created_at, schema_version
      FROM approval_policies_v2 ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('approvalPolicies', row);
      return validateFromRow('approvalPolicies', {
        id: text('approvalPolicies', row, 'id'),
        workspaceId: text('approvalPolicies', row, 'workspace_id'),
        version: wholeNumber('approvalPolicies', row, 'version'),
        steps: json(row, 'steps'),
        status: text('approvalPolicies', row, 'status'),
        createdAt: instant('approvalPolicies', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('approvalPolicies', value);
    await sql`
      INSERT INTO approval_policies_v2
        (id, tenant_id, workspace_id, version, steps, status, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.version as number}, ${sql.json(record.steps)}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `policy` writes PUBLISHED directly and nothing transitions a policy afterwards. Present for the
  // same reason as `agreements_v2`'s: the table is governed, not append-only. `steps` is immutable —
  // `decide` indexes into it to decide who may approve at which assurance level, so a policy whose
  // steps could be rewritten under a pending request is an authorization rule that can be edited
  // mid-decision.
  async update(sql, value) {
    const record = validateForWrite('approvalPolicies', value);
    const rows = await sql<Row[]>`
      UPDATE approval_policies_v2
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('approvalPolicies', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const approvalRequests = relation('approvalRequests', 'agreement_approval_requests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, document_version_id, document_hash, policy_id,
             requester_id, status, completed_steps, created_at, schema_version
      FROM agreement_approval_requests ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('approvalRequests', row);
      return validateFromRow('approvalRequests', {
        id: text('approvalRequests', row, 'id'),
        workspaceId: text('approvalRequests', row, 'workspace_id'),
        contractId: text('approvalRequests', row, 'contract_id'),
        documentVersionId: text('approvalRequests', row, 'document_version_id'),
        documentHash: text('approvalRequests', row, 'document_hash'),
        policyId: text('approvalRequests', row, 'policy_id'),
        requesterId: text('approvalRequests', row, 'requester_id'),
        status: text('approvalRequests', row, 'status'),
        completedSteps: wholeNumber('approvalRequests', row, 'completed_steps'),
        createdAt: instant('approvalRequests', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('approvalRequests', value);
    await sql`
      INSERT INTO agreement_approval_requests
        (id, tenant_id, workspace_id, contract_id, document_version_id, document_hash, policy_id,
         requester_id, status, completed_steps, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.documentVersionId as string},
        ${record.documentHash as string}, ${record.policyId as string},
        ${record.requesterId as string}, ${record.status as string},
        ${record.completedSteps as number}, ${record.createdAt as string}, 1,
        ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `decide` advances the step counter and the status together, and `invalidateOnChange` moves the
  // status alone. Both columns move in one statement because they are one decision.
  //
  // `document_hash` is immutable, and that is the load-bearing one: it is the digest the approval
  // *is* an approval of. If it could be rewritten, `invalidateOnChange` — which compares it against the
  // document's current hash — could be made to find no change.
  async update(sql, value) {
    const record = validateForWrite('approvalRequests', value);
    const rows = await sql<Row[]>`
      UPDATE agreement_approval_requests
      SET status = ${record.status as string},
          completed_steps = ${record.completedSteps as number},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('approvalRequests', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. The `agreement_approval_decisions_append_only` trigger has held since `202608030002`,
// and a decision is a record of what an approver said at a moment: it is superseded by the next
// decision, never edited.
const approvalDecisions = relation('approvalDecisions', 'agreement_approval_decisions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, request_id, step, approver_id, decision, conditions, created_at,
             schema_version
      FROM agreement_approval_decisions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('approvalDecisions', row);
      return validateFromRow('approvalDecisions', {
        id: text('approvalDecisions', row, 'id'),
        workspaceId: text('approvalDecisions', row, 'workspace_id'),
        requestId: text('approvalDecisions', row, 'request_id'),
        step: wholeNumber('approvalDecisions', row, 'step'),
        approverId: text('approvalDecisions', row, 'approver_id'),
        decision: text('approvalDecisions', row, 'decision'),
        conditions: json(row, 'conditions'),
        createdAt: instant('approvalDecisions', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('approvalDecisions', value);
    await sql`
      INSERT INTO agreement_approval_decisions
        (id, tenant_id, workspace_id, request_id, step, approver_id, decision, conditions,
         created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.requestId as string}, ${record.step as number}, ${record.approverId as string},
        ${record.decision as string}, ${sql.json(record.conditions)},
        ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 15 — Digital Execution
// ---------------------------------------------------------------------------------------

const signaturePackages = relation('signaturePackages', 'signature_packages_v2', {
  // Honours `lock`, and has to. `callback()` reads the package, merges one signer's timestamp into the
  // array it read, and writes the array back. Two provider callbacks for different signatories that
  // interleave between the read and the write both compute their array from the same starting point, and
  // the second write erases the first signature — a lost update that no constraint can catch, because
  // both arrays are individually valid. `FOR UPDATE` holds the row until the surrounding transaction
  // commits, so the second callback re-reads a signer list that already contains the first signature.
  //
  // The lock is taken over the workspace's packages rather than one row because `list` is the only read
  // shape the store has; callbacks are low-volume webhook deliveries, so serialising them within a
  // workspace costs less than the reconciliation of a silently dropped signature.
  async list(sql, options) {
    // Written twice rather than interpolated. `FOR UPDATE` is not a value, and the driver's fragment
    // support types a nested template as a query rather than a clause, so a conditional fragment here
    // reads as a parameter and fails to compile.
    const rows = options?.lock
      ? await sql<Row[]>`
          SELECT id, workspace_id, contract_id, approval_request_id, document_version_id,
                 document_hash, signers, status, provider_key, created_at, schema_version
          FROM signature_packages_v2 ORDER BY created_at ASC, id ASC
          FOR UPDATE
        `
      : await sql<Row[]>`
          SELECT id, workspace_id, contract_id, approval_request_id, document_version_id,
                 document_hash, signers, status, provider_key, created_at, schema_version
          FROM signature_packages_v2 ORDER BY created_at ASC, id ASC
        `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('signaturePackages', row);
      return validateFromRow('signaturePackages', {
        id: text('signaturePackages', row, 'id'),
        workspaceId: text('signaturePackages', row, 'workspace_id'),
        contractId: text('signaturePackages', row, 'contract_id'),
        approvalRequestId: text('signaturePackages', row, 'approval_request_id'),
        documentVersionId: text('signaturePackages', row, 'document_version_id'),
        documentHash: text('signaturePackages', row, 'document_hash'),
        signers: json(row, 'signers'),
        status: text('signaturePackages', row, 'status'),
        providerKey: text('signaturePackages', row, 'provider_key'),
        createdAt: instant('signaturePackages', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('signaturePackages', value);
    await sql`
      INSERT INTO signature_packages_v2
        (id, tenant_id, workspace_id, contract_id, approval_request_id, document_version_id,
         document_hash, signers, status, provider_key, created_at, row_version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.approvalRequestId as string},
        ${record.documentVersionId as string}, ${record.documentHash as string},
        ${sql.json(record.signers)}, ${record.status as string}, ${record.providerKey as string},
        ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `callback` rewrites the signer list and the status together: a signature timestamp arriving and the
  // package becoming partially signed are the same event, and writing them separately would leave a
  // window in which the package is complete and does not say so.
  async update(sql, value) {
    const record = validateForWrite('signaturePackages', value);
    const rows = await sql<Row[]>`
      UPDATE signature_packages_v2
      SET status = ${record.status as string},
          signers = ${sql.json(record.signers)},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('signaturePackages', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A consumed callback has no status: the row exists to say the provider's event was already
// applied, and rewriting it would erase the replay protection. `signature_callbacks` is the second table
// `202608110005` creates.
const signatureCallbacks = relation('signatureCallbacks', 'signature_callbacks', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, event_id, created_at, schema_version
      FROM signature_callbacks ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('signatureCallbacks', row);
      return validateFromRow('signatureCallbacks', {
        id: text('signatureCallbacks', row, 'id'),
        workspaceId: text('signatureCallbacks', row, 'workspace_id'),
        eventId: text('signatureCallbacks', row, 'event_id'),
        createdAt: instant('signatureCallbacks', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('signatureCallbacks', value);
    await sql`
      INSERT INTO signature_callbacks
        (id, tenant_id, workspace_id, event_id, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.eventId as string}, ${record.createdAt as string}, 1, ${BATCH_F_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
});

const agreementExecutionCertificates = relation(
  'agreementExecutionCertificates',
  'agreement_execution_certificates',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, package_id, contract_id, document_hash, canonical_hash, status,
               issued_at, schema_version
        FROM agreement_execution_certificates ORDER BY issued_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('agreementExecutionCertificates', row);
        return validateFromRow('agreementExecutionCertificates', {
          id: text('agreementExecutionCertificates', row, 'id'),
          workspaceId: text('agreementExecutionCertificates', row, 'workspace_id'),
          packageId: text('agreementExecutionCertificates', row, 'package_id'),
          contractId: text('agreementExecutionCertificates', row, 'contract_id'),
          documentHash: text('agreementExecutionCertificates', row, 'document_hash'),
          canonicalHash: text('agreementExecutionCertificates', row, 'canonical_hash'),
          status: text('agreementExecutionCertificates', row, 'status'),
          issuedAt: instant('agreementExecutionCertificates', row, 'issued_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('agreementExecutionCertificates', value);
      await sql`
        INSERT INTO agreement_execution_certificates
          (id, tenant_id, workspace_id, package_id, contract_id, document_hash, canonical_hash,
           status, issued_at, row_version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.packageId as string}, ${record.contractId as string},
          ${record.documentHash as string}, ${record.canonicalHash as string},
          ${record.status as string}, ${record.issuedAt as string}, 1,
          ${BATCH_F_SCHEMA_VERSION}, ${record.issuedAt as string}
        )
      `;
    },
    // Revocation. `canonical_hash` is immutable: it is what makes the execution independently
    // recomputable, and a revoked certificate must still say what it certified.
    async update(sql, value) {
      const record = validateForWrite('agreementExecutionCertificates', value);
      const rows = await sql<Row[]>`
        UPDATE agreement_execution_certificates
        SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
        WHERE id = ${requireId('agreementExecutionCertificates', record)}
        RETURNING id
      `;
      return rows.length;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

/**
 * Every Batch F collection, checked against the contract registry at module load.
 *
 * The cross-check is the point, and it earns its keep in this batch more than any before it: four of
 * these fifteen have a column whose name is not the snake_case of its field, and two write to tables
 * that did not exist until `202608110005`. A repository whose table disagreed with its schema's declared
 * table would write correct-looking rows to the wrong owner, and the failure would surface as absence.
 */
export const BATCH_F_RELATIONS: Readonly<Record<string, BatchFRelation>> = Object.freeze(
  Object.fromEntries(
    [
      agreements,
      templateVersions,
      documentVersions,
      contractDrafts,
      contractComments,
      clauseVersions,
      clauseInstances,
      clauseDeviations,
      negotiationRounds,
      approvalPolicies,
      approvalRequests,
      approvalDecisions,
      signaturePackages,
      signatureCallbacks,
      agreementExecutionCertificates,
    ].map((entry) => {
      const contract = batchFContract(entry.collection);
      if (!contract)
        throw new Error(
          `${entry.collection} has a relational repository but no canonical schema; ` +
            'every persisted aggregate must have both.',
        );
      if (contract.table !== entry.table)
        throw new Error(
          `${entry.collection} maps to ${entry.table} here and ${contract.table} in the ` +
            'contract registry; the two must name the same owner.',
        );
      return [entry.collection, entry] as const;
    }),
  ),
);

/** Whether Batch F owns a collection. */
export function isBatchFCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_F_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the
 * collection is Batch F's, and a silent undefined would become a lost write.
 */
export function batchFRelation(collection: string): BatchFRelation {
  const found = BATCH_F_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch F aggregate`,
    );
  return found;
}

export const BATCH_F_RELATION_COUNT = Object.keys(BATCH_F_RELATIONS).length;

if (BATCH_F_RELATION_COUNT !== BATCH_F_AGGREGATES.length)
  throw new Error(
    `${BATCH_F_RELATION_COUNT} relational repositories for ${BATCH_F_AGGREGATES.length} ` +
      'Batch F aggregates; an aggregate with a schema and no repository cannot be stored.',
  );

/**
 * The store's append-only set and the contract registry's must be the same set.
 *
 * Checked at module load rather than in a test, because the two are declared in different packages and
 * a drift between them is silent in the direction that matters: a relation that gained an `update`
 * without the registry being told would let the store attempt a write the database refuses, and the
 * caller would see a trigger exception instead of a domain refusal.
 */
{
  const fromRelations = Object.values(BATCH_F_RELATIONS)
    .filter((entry) => entry.appendOnly)
    .map((entry) => entry.collection)
    .sort();
  const fromContracts = [...BATCH_F_APPEND_ONLY_COLLECTIONS].sort();
  if (fromRelations.join(',') !== fromContracts.join(','))
    throw new Error(
      `Batch F append-only sets disagree: repositories say [${fromRelations.join(', ')}] and ` +
        `the contract registry says [${fromContracts.join(', ')}].`,
    );
}
