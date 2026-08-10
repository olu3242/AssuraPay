import {
  BATCH_A_AGGREGATES,
  BATCH_A_SCHEMA_VERSION,
  batchAContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch A — the sixteen execution-and-evidence aggregates of
 * canonical Engines 31–40.
 *
 * ## What this replaces
 *
 * Nothing. `PostgresTrustStore` did not route these collections anywhere: they are absent
 * from `GOVERNED_DOCUMENTS`, so every `append`, `replace` and `list` for an execution
 * workspace, work item, defect or completion certificate was refused with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. Engines 31–40 could not persist at all on the durable
 * path — they worked only against `InMemoryTrustStore`.
 *
 * That correction matters for how this capability is sequenced.
 * `docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` describes the migration
 * as "backfill from `trust_records` → switch reads → stop generic writes". For Batch A there
 * is nothing to backfill and no read to switch: `trust_records` holds zero rows for these
 * sixteen collections on every database, because the only writer that could have put them
 * there refused them. Activating the tables *is* the write cutover and the read cutover, in
 * one change, with no window in which two models are authoritative. The generic-collection
 * retirement step the plan reserves for later has nothing to retire here.
 *
 * ## Shape
 *
 * One statement per table, written out, rather than one statement generated from a column
 * map. PostgreSQL does not bind identifiers, so a generated statement means interpolating a
 * table name — and `persistence/unsafe-sql` exists precisely to keep the driver's
 * unparameterized escape hatch confined to DDL. Every value below reaches the database as a
 * bound parameter. The cost is length; the benefit is that a reviewer reads the exact
 * statement each aggregate runs, which for a persistence boundary is worth more than brevity.
 *
 * Option D from the accepted decision, and Batch A turns out to need none of its escape
 * hatch: every field of all sixteen domain types has an explicit column, so there is no
 * `payload` blob and no extension envelope. The structured sub-objects that do exist —
 * evidence files, chains of custody, checklists, findings, conditions, standards, change
 * impact — are `jsonb` columns whose contents are validated by the aggregate's own schema,
 * not open metadata.
 *
 * ## Where tenancy comes from
 *
 * Not from the record. None of the sixteen domain types carries a `tenantId`; they carry
 * `workspaceId` only. Every table requires `tenant_id NOT NULL` and every policy predicates
 * on `tenant_id = trust_current_tenant()`, so the tenant is taken from the ambient trust
 * scope the store established for the request — the same scope the policies read. A write
 * with no scope is refused here rather than left to fail on the policy, because
 * "PERSISTENCE_SCOPE_INVALID" names the cause and a row-level-security rejection does not.
 *
 * ## What is not claimed
 *
 * `version` is maintained and the database requires it to advance, but it is not yet an
 * optimistic-concurrency check at the application boundary: `TrustPersistence.replace` takes
 * a record, and none of these records carries the version it was read at, so there is no
 * expected value to predicate the UPDATE on. Two concurrent transitions of the same
 * aggregate will both succeed and the later will win. Closing that needs a change to the
 * persistence contract, which is a separate capability, and claiming it here would be false.
 */

/** Rows as PostgreSQL returns them: column names, driver-native values. */
type Row = Record<string, unknown>;

/** The persisted form of one aggregate, and the statements that read and write it. */
export type BatchARelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine ever transitions this aggregate, so `update` is a
   * programming error rather than a state change. The database says the same thing through
   * the `<table>_append_only` trigger `202608030006` and `202608030007` created; both hold,
   * and the trigger is the authority — this flag only makes the refusal legible.
   */
  readonly appendOnly: boolean;
  list(sql: SqlClient): Promise<Row[]>;
  insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
  /** Rows affected. Zero means the record does not exist, or is outside the caller's scope. */
  update(sql: SqlClient, record: Row): Promise<number>;
};

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * The aggregate's canonical schema, applied on the way in.
 *
 * Before the statement, not after: a record that fails validation must not reach the
 * database at all, or a partially-written aggregate becomes the caller's problem to undo.
 */
function validateForWrite(collection: string, value: unknown): Row {
  const contract = batchAContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch A aggregate`,
    );
  const result = contract.schema.safeParse(value);
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
 * Reads are validated too, and the reason is not symmetry. A column can be edited by a
 * console session, a future migration can widen a check, and a `jsonb` column can hold
 * anything the type system never saw. Handing an unvalidated row to an engine that then
 * decides whether a milestone is complete is how a malformed row becomes a certified one.
 * A failure here is `PERSISTENCE_CORRUPT_RECORD` — a data-integrity incident, not a caller
 * error.
 */
function validateFromRow(collection: string, value: unknown): Row {
  const contract = batchAContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch A aggregate`,
    );
  const result = contract.schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data;
}

/**
 * Refuses a row written at a schema version this build does not understand.
 *
 * Checked before the row is interpreted, so an unrecognised version produces an explicit
 * refusal rather than a best-effort parse against whatever the columns happen to mean now.
 */
function requireSupportedSchemaVersion(collection: string, row: Row): void {
  const declared = row.schema_version;
  const version = typeof declared === 'number' ? declared : Number(declared);
  if (!Number.isInteger(version) || version < 1)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: schema_version is not a positive integer`,
    );
  if (version > BATCH_A_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_A_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // The column name and the reason, never the value: these rows carry evidence references,
  // actor identities and narrative text.
  throw new PostgresStoreError(
    'PERSISTENCE_CORRUPT_RECORD',
    `${collection}.${column} ${why}`,
  );
}

function text(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
}

function optionalTextColumn(
  collection: string,
  row: Row,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
}

/**
 * A `timestamptz` column as the ISO string the domain types declare.
 *
 * The driver hands back a `Date`; `toISOString()` reproduces exactly what the engines wrote,
 * because every domain timestamp in this batch is produced by `new Date().toISOString()` and
 * is therefore millisecond-precision to begin with.
 */
function instant(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return corrupt(collection, column, 'is not a timestamp');
}

function optionalInstant(
  collection: string,
  row: Row,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return instant(collection, row, column);
}

/**
 * A numeric column as a JavaScript number.
 *
 * `numeric` and `bigint` both arrive as strings, so this is a conversion rather than a cast.
 * A value that does not survive it is a corrupt row, not a rounding to accept quietly.
 */
function numeric(collection: string, row: Row, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  if (!Number.isFinite(parsed))
    corrupt(collection, column, 'is not a finite number');
  return parsed;
}

function optionalNumeric(
  collection: string,
  row: Row,
  column: string,
): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return numeric(collection, row, column);
}

function boolean(collection: string, row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean')
    corrupt(collection, column, 'is not a boolean');
  return value as boolean;
}

/** A `jsonb` column, already parsed by the driver. Its shape is the schema's business. */
function json(row: Row, column: string): unknown {
  return row[column];
}

/**
 * Drops keys whose value is `undefined`.
 *
 * An optional domain field must be *absent* rather than present-and-undefined. The engines
 * spread these records and the audit chain hashes them through `canonicalJson`, which drops
 * `undefined` — but `Object.keys` does not, and a reader comparing shapes would see a
 * difference that means nothing.
 */
function compact(record: Row): Row {
  for (const key of Object.keys(record))
    if (record[key] === undefined) delete record[key];
  return record;
}

function requireId(collection: string, record: Row): string {
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0)
    throw new PostgresStoreError(
      'PERSISTENCE_RECORD_ID_REQUIRED',
      `${collection} record has no id`,
    );
  return id;
}

function relation(
  collection: string,
  table: string,
  operations: {
    list(sql: SqlClient): Promise<Row[]>;
    insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
    /** Omitted for aggregates the canonical engines never transition. */
    update?(sql: SqlClient, record: Row): Promise<number>;
  },
): BatchARelation {
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
// Engine 31 — Execution Orchestration
// ---------------------------------------------------------------------------------------

const executionWorkspaces = relation(
  'executionWorkspaces',
  'execution_workspaces',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, milestone_id, status, created_at, schema_version
      FROM execution_workspaces ORDER BY created_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('executionWorkspaces', row);
        return validateFromRow('executionWorkspaces', {
          id: text('executionWorkspaces', row, 'id'),
          workspaceId: text('executionWorkspaces', row, 'workspace_id'),
          blueprintId: text('executionWorkspaces', row, 'blueprint_id'),
          milestoneId: text('executionWorkspaces', row, 'milestone_id'),
          status: text('executionWorkspaces', row, 'status'),
          createdAt: instant('executionWorkspaces', row, 'created_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('executionWorkspaces', value);
      await sql`
      INSERT INTO execution_workspaces
        (id, tenant_id, workspace_id, blueprint_id, milestone_id, status, created_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.milestoneId as string},
        ${record.status as string}, ${record.createdAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
    },
    async update(sql, value) {
      const record = validateForWrite('executionWorkspaces', value);
      const rows = await sql<Row[]>`
      UPDATE execution_workspaces
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('executionWorkspaces', record)}
      RETURNING id
    `;
      return rows.length;
    },
  },
);

const workItems = relation('workItems', 'work_items', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_workspace_id, deliverable_id, title, assignee_id,
             status, created_at, updated_at, schema_version
      FROM work_items ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('workItems', row);
      return validateFromRow('workItems', {
        id: text('workItems', row, 'id'),
        workspaceId: text('workItems', row, 'workspace_id'),
        executionWorkspaceId: text('workItems', row, 'execution_workspace_id'),
        deliverableId: text('workItems', row, 'deliverable_id'),
        title: text('workItems', row, 'title'),
        assigneeId: text('workItems', row, 'assignee_id'),
        status: text('workItems', row, 'status'),
        createdAt: instant('workItems', row, 'created_at'),
        updatedAt: instant('workItems', row, 'updated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('workItems', value);
    await sql`
      INSERT INTO work_items
        (id, tenant_id, workspace_id, execution_workspace_id, deliverable_id, title,
         assignee_id, status, created_at, updated_at, version, schema_version)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionWorkspaceId as string}, ${record.deliverableId as string},
        ${record.title as string}, ${record.assigneeId as string}, ${record.status as string},
        ${record.createdAt as string}, ${record.updatedAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('workItems', value);
    const rows = await sql<Row[]>`
      UPDATE work_items
      SET status = ${record.status as string}, updated_at = ${record.updatedAt as string},
          version = version + 1
      WHERE id = ${requireId('workItems', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 32 — Progress Measurement
// ---------------------------------------------------------------------------------------

const progressRecords = relation('progressRecords', 'progress_records', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, stage, percent_complete,
             earned_value_amount_minor, reported_by, created_at, schema_version
      FROM progress_records ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('progressRecords', row);
      return validateFromRow(
        'progressRecords',
        compact({
          id: text('progressRecords', row, 'id'),
          workspaceId: text('progressRecords', row, 'workspace_id'),
          workItemId: text('progressRecords', row, 'work_item_id'),
          stage: text('progressRecords', row, 'stage'),
          percentComplete: numeric('progressRecords', row, 'percent_complete'),
          earnedValueAmountMinor: optionalNumeric(
            'progressRecords',
            row,
            'earned_value_amount_minor',
          ),
          reportedBy: text('progressRecords', row, 'reported_by'),
          createdAt: instant('progressRecords', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('progressRecords', value);
    await sql`
      INSERT INTO progress_records
        (id, tenant_id, workspace_id, work_item_id, stage, percent_complete,
         earned_value_amount_minor, reported_by, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.stage as string},
        ${record.percentComplete as number},
        ${(record.earnedValueAmountMinor as number | undefined) ?? null},
        ${record.reportedBy as string}, ${record.createdAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 33 — Evidence Management
// ---------------------------------------------------------------------------------------

const evidenceRequirements = relation(
  'evidenceRequirements',
  'evidence_requirements',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, deliverable_id, kind, description, mandatory, created_at,
             schema_version
      FROM evidence_requirements ORDER BY created_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('evidenceRequirements', row);
        return validateFromRow('evidenceRequirements', {
          id: text('evidenceRequirements', row, 'id'),
          workspaceId: text('evidenceRequirements', row, 'workspace_id'),
          deliverableId: text('evidenceRequirements', row, 'deliverable_id'),
          kind: text('evidenceRequirements', row, 'kind'),
          description: text('evidenceRequirements', row, 'description'),
          mandatory: boolean('evidenceRequirements', row, 'mandatory'),
          createdAt: instant('evidenceRequirements', row, 'created_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('evidenceRequirements', value);
      await sql`
      INSERT INTO evidence_requirements
        (id, tenant_id, workspace_id, deliverable_id, kind, description, mandatory,
         created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.deliverableId as string}, ${record.kind as string},
        ${record.description as string}, ${record.mandatory as boolean},
        ${record.createdAt as string}, 1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
    },
  },
);

const evidencePackages = relation('evidencePackages', 'evidence_packages', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, deliverable_id, files, chain_of_custody,
             status, created_at, schema_version
      FROM evidence_packages ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('evidencePackages', row);
      return validateFromRow('evidencePackages', {
        id: text('evidencePackages', row, 'id'),
        workspaceId: text('evidencePackages', row, 'workspace_id'),
        workItemId: text('evidencePackages', row, 'work_item_id'),
        deliverableId: text('evidencePackages', row, 'deliverable_id'),
        files: json(row, 'files'),
        chainOfCustody: json(row, 'chain_of_custody'),
        status: text('evidencePackages', row, 'status'),
        createdAt: instant('evidencePackages', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('evidencePackages', value);
    await sql`
      INSERT INTO evidence_packages
        (id, tenant_id, workspace_id, work_item_id, deliverable_id, files, chain_of_custody,
         status, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.deliverableId as string},
        ${sql.json(record.files)}, ${sql.json(record.chainOfCustody)},
        ${record.status as string}, ${record.createdAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('evidencePackages', value);
    // Verification appends to the chain of custody and moves the status. The files themselves
    // are immutable, enforced by the trigger rather than by omitting them here — an UPDATE
    // that did not mention them would still let a direct statement rewrite them.
    const rows = await sql<Row[]>`
      UPDATE evidence_packages
      SET status = ${record.status as string},
          chain_of_custody = ${sql.json(record.chainOfCustody)},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('evidencePackages', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 34 — Validation & Acceptance Testing
// ---------------------------------------------------------------------------------------

const validationTests = relation('validationTests', 'validation_tests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, acceptance_criterion_id, method, result, notes,
             evidence_package_id, retest_of, tested_by, tested_at, schema_version
      FROM validation_tests ORDER BY tested_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('validationTests', row);
      return validateFromRow(
        'validationTests',
        compact({
          id: text('validationTests', row, 'id'),
          workspaceId: text('validationTests', row, 'workspace_id'),
          workItemId: text('validationTests', row, 'work_item_id'),
          acceptanceCriterionId: text(
            'validationTests',
            row,
            'acceptance_criterion_id',
          ),
          method: text('validationTests', row, 'method'),
          result: text('validationTests', row, 'result'),
          notes: text('validationTests', row, 'notes'),
          evidencePackageId: optionalTextColumn(
            'validationTests',
            row,
            'evidence_package_id',
          ),
          retestOf: optionalTextColumn('validationTests', row, 'retest_of'),
          testedBy: text('validationTests', row, 'tested_by'),
          testedAt: instant('validationTests', row, 'tested_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('validationTests', value);
    await sql`
      INSERT INTO validation_tests
        (id, tenant_id, workspace_id, work_item_id, acceptance_criterion_id, method, result,
         notes, evidence_package_id, retest_of, tested_by, tested_at, version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.acceptanceCriterionId as string},
        ${record.method as string}, ${record.result as string}, ${record.notes as string},
        ${(record.evidencePackageId as string | undefined) ?? null},
        ${(record.retestOf as string | undefined) ?? null},
        ${record.testedBy as string}, ${record.testedAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.testedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 35 — Quality Assurance
// ---------------------------------------------------------------------------------------

const qualityPlans = relation('qualityPlans', 'quality_plans', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_workspace_id, standards, inspection_frequency,
             status, created_at, schema_version
      FROM quality_plans ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('qualityPlans', row);
      return validateFromRow('qualityPlans', {
        id: text('qualityPlans', row, 'id'),
        workspaceId: text('qualityPlans', row, 'workspace_id'),
        executionWorkspaceId: text(
          'qualityPlans',
          row,
          'execution_workspace_id',
        ),
        standards: json(row, 'standards'),
        inspectionFrequency: text('qualityPlans', row, 'inspection_frequency'),
        status: text('qualityPlans', row, 'status'),
        createdAt: instant('qualityPlans', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('qualityPlans', value);
    await sql`
      INSERT INTO quality_plans
        (id, tenant_id, workspace_id, execution_workspace_id, standards, inspection_frequency,
         status, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionWorkspaceId as string}, ${sql.json(record.standards)},
        ${record.inspectionFrequency as string}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

const defects = relation('defects', 'defects', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, severity, description, root_cause, status,
             raised_by, created_at, resolved_at, schema_version
      FROM defects ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('defects', row);
      return validateFromRow(
        'defects',
        compact({
          id: text('defects', row, 'id'),
          workspaceId: text('defects', row, 'workspace_id'),
          workItemId: text('defects', row, 'work_item_id'),
          severity: text('defects', row, 'severity'),
          description: text('defects', row, 'description'),
          rootCause: optionalTextColumn('defects', row, 'root_cause'),
          status: text('defects', row, 'status'),
          raisedBy: text('defects', row, 'raised_by'),
          createdAt: instant('defects', row, 'created_at'),
          resolvedAt: optionalInstant('defects', row, 'resolved_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('defects', value);
    await sql`
      INSERT INTO defects
        (id, tenant_id, workspace_id, work_item_id, severity, description, root_cause, status,
         raised_by, created_at, resolved_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.severity as string},
        ${record.description as string}, ${(record.rootCause as string | undefined) ?? null},
        ${record.status as string}, ${record.raisedBy as string}, ${record.createdAt as string},
        ${(record.resolvedAt as string | undefined) ?? null},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('defects', value);
    const rows = await sql<Row[]>`
      UPDATE defects
      SET root_cause = ${(record.rootCause as string | undefined) ?? null},
          status = ${record.status as string},
          resolved_at = ${(record.resolvedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('defects', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const qualityGateResults = relation(
  'qualityGateResults',
  'quality_gate_results',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, passed, open_defect_count,
             critical_defect_count, evaluated_at, schema_version
      FROM quality_gate_results ORDER BY evaluated_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('qualityGateResults', row);
        return validateFromRow('qualityGateResults', {
          id: text('qualityGateResults', row, 'id'),
          workspaceId: text('qualityGateResults', row, 'workspace_id'),
          workItemId: text('qualityGateResults', row, 'work_item_id'),
          passed: boolean('qualityGateResults', row, 'passed'),
          openDefectCount: numeric(
            'qualityGateResults',
            row,
            'open_defect_count',
          ),
          criticalDefectCount: numeric(
            'qualityGateResults',
            row,
            'critical_defect_count',
          ),
          evaluatedAt: instant('qualityGateResults', row, 'evaluated_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('qualityGateResults', value);
      await sql`
      INSERT INTO quality_gate_results
        (id, tenant_id, workspace_id, work_item_id, passed, open_defect_count,
         critical_defect_count, evaluated_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.passed as boolean},
        ${record.openDefectCount as number}, ${record.criticalDefectCount as number},
        ${record.evaluatedAt as string}, 1, ${BATCH_A_SCHEMA_VERSION},
        ${record.evaluatedAt as string}
      )
    `;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Engine 36 — Inspection & Field Verification
// ---------------------------------------------------------------------------------------

const inspections = relation('inspections', 'inspections', {
  async list(sql) {
    // `scheduled_for::text` rather than the driver's `Date`. A `DATE` has no time and no zone,
    // and rebuilding a calendar date from a `Date` object means choosing a zone in which to
    // read it — which is how a scheduled inspection moves a day depending on where the host is.
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, scheduled_for::text AS scheduled_for, checklist,
             findings, status, passed, reinspection_of_id, created_at, schema_version
      FROM inspections ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('inspections', row);
      return validateFromRow(
        'inspections',
        compact({
          id: text('inspections', row, 'id'),
          workspaceId: text('inspections', row, 'workspace_id'),
          workItemId: text('inspections', row, 'work_item_id'),
          scheduledFor: text('inspections', row, 'scheduled_for'),
          checklist: json(row, 'checklist'),
          findings: json(row, 'findings'),
          status: text('inspections', row, 'status'),
          passed: boolean('inspections', row, 'passed'),
          reinspectionOfId: optionalTextColumn(
            'inspections',
            row,
            'reinspection_of_id',
          ),
          createdAt: instant('inspections', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('inspections', value);
    await sql`
      INSERT INTO inspections
        (id, tenant_id, workspace_id, work_item_id, scheduled_for, checklist, findings,
         status, passed, reinspection_of_id, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.scheduledFor as string},
        ${sql.json(record.checklist)}, ${sql.json(record.findings)},
        ${record.status as string}, ${record.passed as boolean},
        ${(record.reinspectionOfId as string | undefined) ?? null},
        ${record.createdAt as string}, 1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('inspections', value);
    const rows = await sql<Row[]>`
      UPDATE inspections
      SET findings = ${sql.json(record.findings)}, status = ${record.status as string},
          passed = ${record.passed as boolean}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('inspections', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 37 — Issue, Risk & Corrective Action
// ---------------------------------------------------------------------------------------

const issueRecords = relation('issueRecords', 'issue_records', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, kind, severity, description, status, raised_by,
             created_at, escalated_at, resolved_at, schema_version
      FROM issue_records ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('issueRecords', row);
      return validateFromRow(
        'issueRecords',
        compact({
          id: text('issueRecords', row, 'id'),
          workspaceId: text('issueRecords', row, 'workspace_id'),
          workItemId: text('issueRecords', row, 'work_item_id'),
          kind: text('issueRecords', row, 'kind'),
          severity: text('issueRecords', row, 'severity'),
          description: text('issueRecords', row, 'description'),
          status: text('issueRecords', row, 'status'),
          raisedBy: text('issueRecords', row, 'raised_by'),
          createdAt: instant('issueRecords', row, 'created_at'),
          escalatedAt: optionalInstant('issueRecords', row, 'escalated_at'),
          resolvedAt: optionalInstant('issueRecords', row, 'resolved_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('issueRecords', value);
    await sql`
      INSERT INTO issue_records
        (id, tenant_id, workspace_id, work_item_id, kind, severity, description, status,
         raised_by, created_at, escalated_at, resolved_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.kind as string}, ${record.severity as string},
        ${record.description as string}, ${record.status as string},
        ${record.raisedBy as string}, ${record.createdAt as string},
        ${(record.escalatedAt as string | undefined) ?? null},
        ${(record.resolvedAt as string | undefined) ?? null},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('issueRecords', value);
    const rows = await sql<Row[]>`
      UPDATE issue_records
      SET status = ${record.status as string},
          escalated_at = ${(record.escalatedAt as string | undefined) ?? null},
          resolved_at = ${(record.resolvedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('issueRecords', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const correctiveActionPlans = relation(
  'correctiveActionPlans',
  'corrective_action_plans',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, issue_id, action_plan, owner_id, due_date::text AS due_date,
             status, created_at, completed_at, verified_at, schema_version
      FROM corrective_action_plans ORDER BY created_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('correctiveActionPlans', row);
        return validateFromRow(
          'correctiveActionPlans',
          compact({
            id: text('correctiveActionPlans', row, 'id'),
            workspaceId: text('correctiveActionPlans', row, 'workspace_id'),
            issueId: text('correctiveActionPlans', row, 'issue_id'),
            actionPlan: text('correctiveActionPlans', row, 'action_plan'),
            ownerId: text('correctiveActionPlans', row, 'owner_id'),
            dueDate: text('correctiveActionPlans', row, 'due_date'),
            status: text('correctiveActionPlans', row, 'status'),
            createdAt: instant('correctiveActionPlans', row, 'created_at'),
            completedAt: optionalInstant(
              'correctiveActionPlans',
              row,
              'completed_at',
            ),
            verifiedAt: optionalInstant(
              'correctiveActionPlans',
              row,
              'verified_at',
            ),
          }),
        );
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('correctiveActionPlans', value);
      await sql`
      INSERT INTO corrective_action_plans
        (id, tenant_id, workspace_id, issue_id, action_plan, owner_id, due_date, status,
         created_at, completed_at, verified_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.issueId as string}, ${record.actionPlan as string},
        ${record.ownerId as string}, ${record.dueDate as string}, ${record.status as string},
        ${record.createdAt as string},
        ${(record.completedAt as string | undefined) ?? null},
        ${(record.verifiedAt as string | undefined) ?? null},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
    },
    async update(sql, value) {
      const record = validateForWrite('correctiveActionPlans', value);
      const rows = await sql<Row[]>`
      UPDATE corrective_action_plans
      SET status = ${record.status as string},
          completed_at = ${(record.completedAt as string | undefined) ?? null},
          verified_at = ${(record.verifiedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('correctiveActionPlans', record)}
      RETURNING id
    `;
      return rows.length;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Engine 38 — Change Control
// ---------------------------------------------------------------------------------------

const changeRequests = relation('changeRequests', 'change_requests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, milestone_id, change_type, description, impact,
             requested_by, status, created_at, schema_version
      FROM change_requests ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('changeRequests', row);
      return validateFromRow('changeRequests', {
        id: text('changeRequests', row, 'id'),
        workspaceId: text('changeRequests', row, 'workspace_id'),
        blueprintId: text('changeRequests', row, 'blueprint_id'),
        milestoneId: text('changeRequests', row, 'milestone_id'),
        changeType: text('changeRequests', row, 'change_type'),
        description: text('changeRequests', row, 'description'),
        impact: json(row, 'impact'),
        requestedBy: text('changeRequests', row, 'requested_by'),
        status: text('changeRequests', row, 'status'),
        createdAt: instant('changeRequests', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('changeRequests', value);
    await sql`
      INSERT INTO change_requests
        (id, tenant_id, workspace_id, blueprint_id, milestone_id, change_type, description,
         impact, requested_by, status, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.milestoneId as string},
        ${record.changeType as string}, ${record.description as string},
        ${sql.json(record.impact)}, ${record.requestedBy as string},
        ${record.status as string}, ${record.createdAt as string},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('changeRequests', value);
    const rows = await sql<Row[]>`
      UPDATE change_requests
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('changeRequests', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const changeApprovals = relation('changeApprovals', 'change_approvals', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, change_request_id, approver_id, decision, rationale,
             decided_at, schema_version
      FROM change_approvals ORDER BY decided_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('changeApprovals', row);
      return validateFromRow('changeApprovals', {
        id: text('changeApprovals', row, 'id'),
        workspaceId: text('changeApprovals', row, 'workspace_id'),
        changeRequestId: text('changeApprovals', row, 'change_request_id'),
        approverId: text('changeApprovals', row, 'approver_id'),
        decision: text('changeApprovals', row, 'decision'),
        rationale: text('changeApprovals', row, 'rationale'),
        decidedAt: instant('changeApprovals', row, 'decided_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('changeApprovals', value);
    await sql`
      INSERT INTO change_approvals
        (id, tenant_id, workspace_id, change_request_id, approver_id, decision, rationale,
         decided_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.changeRequestId as string}, ${record.approverId as string},
        ${record.decision as string}, ${record.rationale as string},
        ${record.decidedAt as string}, 1, ${BATCH_A_SCHEMA_VERSION}, ${record.decidedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 39 — Acceptance & Decision
// ---------------------------------------------------------------------------------------

const acceptanceDecisions = relation(
  'acceptanceDecisions',
  'acceptance_decisions',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, decision, rationale, conditions, status,
             decided_by, decided_at, supersedes_id, schema_version
      FROM acceptance_decisions ORDER BY decided_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('acceptanceDecisions', row);
        return validateFromRow(
          'acceptanceDecisions',
          compact({
            id: text('acceptanceDecisions', row, 'id'),
            workspaceId: text('acceptanceDecisions', row, 'workspace_id'),
            workItemId: text('acceptanceDecisions', row, 'work_item_id'),
            decision: text('acceptanceDecisions', row, 'decision'),
            rationale: text('acceptanceDecisions', row, 'rationale'),
            conditions: json(row, 'conditions'),
            status: text('acceptanceDecisions', row, 'status'),
            decidedBy: text('acceptanceDecisions', row, 'decided_by'),
            decidedAt: instant('acceptanceDecisions', row, 'decided_at'),
            supersedesId: optionalTextColumn(
              'acceptanceDecisions',
              row,
              'supersedes_id',
            ),
          }),
        );
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('acceptanceDecisions', value);
      await sql`
      INSERT INTO acceptance_decisions
        (id, tenant_id, workspace_id, work_item_id, decision, rationale, conditions, status,
         decided_by, decided_at, supersedes_id, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.decision as string},
        ${record.rationale as string}, ${sql.json(record.conditions)},
        ${record.status as string}, ${record.decidedBy as string},
        ${record.decidedAt as string},
        ${(record.supersedesId as string | undefined) ?? null},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.decidedAt as string}
      )
    `;
    },
    async update(sql, value) {
      const record = validateForWrite('acceptanceDecisions', value);
      // Supersession is the only transition, and `acceptance_decisions_one_active_per_work_item`
      // is why it has to be a transition rather than an insert: the index permits one ACTIVE
      // decision per work item, so the prior one must move to SUPERSEDED first.
      const rows = await sql<Row[]>`
      UPDATE acceptance_decisions
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('acceptanceDecisions', record)}
      RETURNING id
    `;
      return rows.length;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Engine 40 — Completion Certification
// ---------------------------------------------------------------------------------------

const completionCertificates = relation(
  'completionCertificates',
  'completion_certificates',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
      SELECT id, workspace_id, work_item_id, milestone_id, certificate_number,
             acceptance_decision_id, canonical_hash, status, issued_by, issued_at,
             revoked_at, schema_version
      FROM completion_certificates ORDER BY issued_at ASC, id ASC
    `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('completionCertificates', row);
        return validateFromRow(
          'completionCertificates',
          compact({
            id: text('completionCertificates', row, 'id'),
            workspaceId: text('completionCertificates', row, 'workspace_id'),
            workItemId: text('completionCertificates', row, 'work_item_id'),
            milestoneId: text('completionCertificates', row, 'milestone_id'),
            certificateNumber: text(
              'completionCertificates',
              row,
              'certificate_number',
            ),
            acceptanceDecisionId: text(
              'completionCertificates',
              row,
              'acceptance_decision_id',
            ),
            canonicalHash: text(
              'completionCertificates',
              row,
              'canonical_hash',
            ),
            status: text('completionCertificates', row, 'status'),
            issuedBy: text('completionCertificates', row, 'issued_by'),
            issuedAt: instant('completionCertificates', row, 'issued_at'),
            revokedAt: optionalInstant(
              'completionCertificates',
              row,
              'revoked_at',
            ),
          }),
        );
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('completionCertificates', value);
      await sql`
      INSERT INTO completion_certificates
        (id, tenant_id, workspace_id, work_item_id, milestone_id, certificate_number,
         acceptance_decision_id, canonical_hash, status, issued_by, issued_at, revoked_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.workItemId as string}, ${record.milestoneId as string},
        ${record.certificateNumber as string}, ${record.acceptanceDecisionId as string},
        ${record.canonicalHash as string}, ${record.status as string},
        ${record.issuedBy as string}, ${record.issuedAt as string},
        ${(record.revokedAt as string | undefined) ?? null},
        1, ${BATCH_A_SCHEMA_VERSION}, ${record.issuedAt as string}
      )
    `;
    },
    async update(sql, value) {
      const record = validateForWrite('completionCertificates', value);
      const rows = await sql<Row[]>`
      UPDATE completion_certificates
      SET status = ${record.status as string},
          revoked_at = ${(record.revokedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('completionCertificates', record)}
      RETURNING id
    `;
      return rows.length;
    },
  },
);

/**
 * The routing table, keyed by the collection name engines pass to `TrustPersistence`.
 *
 * Built from the contract registry rather than assembled independently, and the assembly
 * fails if the two disagree: a collection with a contract and no relation would be a
 * validated aggregate nothing can store, and a relation with no contract would be a write
 * with no schema.
 */
export const BATCH_A_RELATIONS: Readonly<Record<string, BatchARelation>> =
  Object.freeze(
    Object.fromEntries(
      [
        executionWorkspaces,
        workItems,
        progressRecords,
        evidenceRequirements,
        evidencePackages,
        validationTests,
        qualityPlans,
        defects,
        qualityGateResults,
        inspections,
        issueRecords,
        correctiveActionPlans,
        changeRequests,
        changeApprovals,
        acceptanceDecisions,
        completionCertificates,
      ].map((entry) => {
        const contract = batchAContract(entry.collection);
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

/** Whether Batch A owns a collection. */
export function isBatchACollection(collection: string): boolean {
  return Object.hasOwn(BATCH_A_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided
 * this collection is Batch A's, and a silent undefined would become a lost write.
 */
export function batchARelation(collection: string): BatchARelation {
  const relation = BATCH_A_RELATIONS[collection];
  if (!relation)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch A aggregate`,
    );
  return relation;
}

/**
 * Every Batch A aggregate has both a schema and a repository.
 *
 * Asserted at module load — the array literal above is checked against the contract registry
 * — and restated here so a caller can report the count as evidence rather than trusting it.
 */
export const BATCH_A_RELATION_COUNT = Object.keys(BATCH_A_RELATIONS).length;

if (BATCH_A_RELATION_COUNT !== BATCH_A_AGGREGATES.length)
  throw new Error(
    `${BATCH_A_RELATION_COUNT} relational repositories for ${BATCH_A_AGGREGATES.length} ` +
      'Batch A aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
