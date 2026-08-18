import {
  BATCH_H_AGGREGATES,
  BATCH_H_SCHEMA_VERSION,
  batchHContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch H — the eleven governance-core aggregates of canonical Engines 06-10.
 *
 * ## What this replaces
 *
 * Nothing, for the eighth time and the same reason: these eleven collections were absent from the store's
 * routing table, so `PostgresTrustStore` refused every one of them with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. A governed execution, its history, its milestones and their
 * dependencies, a definition of done, its evaluation, a certification request, its decisions, the
 * certificate, the payment trigger and the authorization proposal could not be written to PostgreSQL at
 * all.
 *
 * ## Seven of eleven have no `update`, and four of those seven could previously be updated anyway
 *
 * `202608110011` explains the finding in full; the consequence here is which methods exist. Seven
 * aggregates are append-only in the engines, so this file gives them no `update` — and until that
 * migration, four of them had nothing in the database enforcing it either. The important one is
 * `paymentAuthorizationProposals`: `createEscrowReleaseIntent` reads a proposal's status and nothing else
 * before instructing a certified Financial Provider, and a mutable proposal was an unconditional release
 * path one statement wide.
 *
 * ## The concurrency column differs per aggregate, which is unusual and deliberate
 *
 *   - `governedExecutions`, `governedMilestones` and `certificationRequests` carry a domain `version` that
 *     their engines advance on every transition — `previous.version + 1` — so the `update` writes that
 *     value straight through and the governed trigger's default concurrency column is exactly right.
 *     Adding a `row_version` beside it would create a second counter nothing maintains.
 *   - `dodVersions` carries a domain `version` that is a *revision* — `prior.length + 1`, immutable — so
 *     `row_version` carries concurrency and the `update` advances it, the arrangement Batch E introduced.
 *
 * ## Reading these rows
 *
 *   - `jsonb` columns arrive parsed: `criteria`, `results`, `reviewer_ids`, `evidence_references`,
 *     `blockers`. Their shape is the schema's business.
 *   - `amount_minor` is `bigint`, so it arrives as a string and is converted, refusing anything outside the
 *     exactly representable range rather than rounding it. A silently rounded release amount is a wrong
 *     answer about money presented as a right one.
 *   - `criteria` is read back through a schema that declares it `readonly`, matching the domain type: a
 *     published definition is the standard a release turns on, and a caller holding a mutable reference to
 *     it could change the standard after the fact.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchHRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The database says the same through the
   * `<table>_append_only` trigger and, for these seven, by withholding UPDATE from the runtime role;
   * those are the authority and this flag only makes the refusal legible.
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
  const contract = batchHContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch H aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error, and for this batch the sharpest
 * case is a payment authorization proposal: a row whose status and blockers disagree is a release
 * instruction whose own record contradicts it.
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
  if (version > BATCH_H_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_H_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry review rationales, actor identities and the
  // amounts a release instruction turns on.
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

function optionalInstant(collection: string, row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return instant(collection, row, column);
}

/**
 * A monetary column as a JavaScript number.
 *
 * `bigint` arrives as a string, so this is a conversion. A value beyond the exactly representable integer
 * range is refused rather than rounded.
 */
function amount(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
  if (!Number.isSafeInteger(parsed))
    corrupt(collection, column, 'exceeds the exactly representable integer range');
  return parsed;
}

function integer(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) corrupt(collection, column, 'is not an integer');
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
    list(sql: SqlClient): Promise<Row[]>;
    insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
    update?(sql: SqlClient, record: Row): Promise<number>;
  },
): BatchHRelation {
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
// Engine 06 — Governed Execution
// ---------------------------------------------------------------------------------------

const governedExecutions = relation('governedExecutions', 'governed_executions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, title, owner_user_id, state, started_at, completed_at,
             created_at, updated_at, version, schema_version
      FROM governed_executions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('governedExecutions', row);
      return validateFromRow(
        'governedExecutions',
        compact({
          id: text('governedExecutions', row, 'id'),
          workspaceId: text('governedExecutions', row, 'workspace_id'),
          contractId: text('governedExecutions', row, 'contract_id'),
          title: text('governedExecutions', row, 'title'),
          ownerUserId: text('governedExecutions', row, 'owner_user_id'),
          state: text('governedExecutions', row, 'state'),
          startedAt: optionalInstant('governedExecutions', row, 'started_at'),
          completedAt: optionalInstant('governedExecutions', row, 'completed_at'),
          createdAt: instant('governedExecutions', row, 'created_at'),
          updatedAt: instant('governedExecutions', row, 'updated_at'),
          version: integer('governedExecutions', row, 'version'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('governedExecutions', value);
    await sql`
      INSERT INTO governed_executions
        (id, tenant_id, workspace_id, contract_id, title, owner_user_id, state, started_at, completed_at,
         created_at, updated_at, version, schema_version)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.title as string}, ${record.ownerUserId as string},
        ${record.state as string}, ${(record.startedAt as string | undefined) ?? null},
        ${(record.completedAt as string | undefined) ?? null}, ${record.createdAt as string},
        ${record.updatedAt as string}, ${record.version as number}, ${BATCH_H_SCHEMA_VERSION}
      )
    `;
  },
  // The domain `version` is the concurrency counter here — `transition()` writes `version + 1` — so it is
  // written straight through and the governed trigger checks it advanced. The contract, title and owner
  // are immutable in the database: a completed execution must not be reassignable to a different agreement,
  // taking its history with it.
  async update(sql, value) {
    const record = validateForWrite('governedExecutions', value);
    const rows = await sql<Row[]>`
      UPDATE governed_executions
      SET state = ${record.state as string},
          started_at = ${(record.startedAt as string | undefined) ?? null},
          completed_at = ${(record.completedAt as string | undefined) ?? null},
          updated_at = ${record.updatedAt as string},
          version = ${record.version as number}
      WHERE id = ${requireId('governedExecutions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. History is the record of what happened, and `history()` reads it in sequence order as the
// audit trail of an execution's life.
const executionHistory = relation('executionHistory', 'execution_history', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, from_state, to_state, actor_id, reason, sequence,
             occurred_at, schema_version
      FROM execution_history ORDER BY occurred_at ASC, sequence ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('executionHistory', row);
      return validateFromRow(
        'executionHistory',
        compact({
          id: text('executionHistory', row, 'id'),
          workspaceId: text('executionHistory', row, 'workspace_id'),
          executionId: text('executionHistory', row, 'execution_id'),
          fromState: optionalText('executionHistory', row, 'from_state'),
          toState: text('executionHistory', row, 'to_state'),
          actorId: text('executionHistory', row, 'actor_id'),
          reason: text('executionHistory', row, 'reason'),
          sequence: integer('executionHistory', row, 'sequence'),
          occurredAt: instant('executionHistory', row, 'occurred_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('executionHistory', value);
    await sql`
      INSERT INTO execution_history
        (id, tenant_id, workspace_id, execution_id, from_state, to_state, actor_id, reason, sequence,
         occurred_at, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${(record.fromState as string | undefined) ?? null},
        ${record.toState as string}, ${record.actorId as string}, ${record.reason as string},
        ${record.sequence as number}, ${record.occurredAt as string}, ${BATCH_H_SCHEMA_VERSION},
        ${record.occurredAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 07 — Milestone
// ---------------------------------------------------------------------------------------

const governedMilestones = relation('governedMilestones', 'governed_milestones', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, parent_milestone_id, title, owner_user_id, state,
             duration_days, created_at, updated_at, version, schema_version
      FROM governed_milestones ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('governedMilestones', row);
      return validateFromRow(
        'governedMilestones',
        compact({
          id: text('governedMilestones', row, 'id'),
          workspaceId: text('governedMilestones', row, 'workspace_id'),
          executionId: text('governedMilestones', row, 'execution_id'),
          parentMilestoneId: optionalText('governedMilestones', row, 'parent_milestone_id'),
          title: text('governedMilestones', row, 'title'),
          ownerUserId: text('governedMilestones', row, 'owner_user_id'),
          state: text('governedMilestones', row, 'state'),
          durationDays: integer('governedMilestones', row, 'duration_days'),
          createdAt: instant('governedMilestones', row, 'created_at'),
          updatedAt: instant('governedMilestones', row, 'updated_at'),
          version: integer('governedMilestones', row, 'version'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('governedMilestones', value);
    await sql`
      INSERT INTO governed_milestones
        (id, tenant_id, workspace_id, execution_id, parent_milestone_id, title, owner_user_id, state,
         duration_days, created_at, updated_at, version, schema_version)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${(record.parentMilestoneId as string | undefined) ?? null},
        ${record.title as string}, ${record.ownerUserId as string}, ${record.state as string},
        ${record.durationDays as number}, ${record.createdAt as string}, ${record.updatedAt as string},
        ${record.version as number}, ${BATCH_H_SCHEMA_VERSION}
      )
    `;
  },
  // State and the counter. `duration_days` is immutable in the database because `project()` computes the
  // execution's schedule from it, so a duration that could change after planning would move a completion
  // date other milestones depend on.
  async update(sql, value) {
    const record = validateForWrite('governedMilestones', value);
    const rows = await sql<Row[]>`
      UPDATE governed_milestones
      SET state = ${record.state as string},
          updated_at = ${record.updatedAt as string},
          version = ${record.version as number}
      WHERE id = ${requireId('governedMilestones', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. An edge exists or it does not; changing one would silently rewrite the schedule every
// dependent milestone was planned against.
const milestoneDependencies = relation('milestoneDependencies', 'milestone_dependencies', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, predecessor_id, successor_id, dependency_type, created_at,
             schema_version
      FROM milestone_dependencies ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('milestoneDependencies', row);
      return validateFromRow('milestoneDependencies', {
        id: text('milestoneDependencies', row, 'id'),
        workspaceId: text('milestoneDependencies', row, 'workspace_id'),
        executionId: text('milestoneDependencies', row, 'execution_id'),
        predecessorId: text('milestoneDependencies', row, 'predecessor_id'),
        successorId: text('milestoneDependencies', row, 'successor_id'),
        dependencyType: text('milestoneDependencies', row, 'dependency_type'),
        createdAt: instant('milestoneDependencies', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('milestoneDependencies', value);
    await sql`
      INSERT INTO milestone_dependencies
        (id, tenant_id, workspace_id, execution_id, predecessor_id, successor_id, dependency_type,
         created_at, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${record.predecessorId as string},
        ${record.successorId as string}, ${record.dependencyType as string},
        ${record.createdAt as string}, ${BATCH_H_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 08 — Definition of Done
// ---------------------------------------------------------------------------------------

const dodVersions = relation('dodVersions', 'dod_versions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, version, status, criteria, created_by, created_at,
             published_at, content_hash, schema_version
      FROM dod_versions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('dodVersions', row);
      return validateFromRow(
        'dodVersions',
        compact({
          id: text('dodVersions', row, 'id'),
          workspaceId: text('dodVersions', row, 'workspace_id'),
          milestoneId: text('dodVersions', row, 'milestone_id'),
          version: integer('dodVersions', row, 'version'),
          status: text('dodVersions', row, 'status'),
          criteria: json(row, 'criteria'),
          createdBy: text('dodVersions', row, 'created_by'),
          createdAt: instant('dodVersions', row, 'created_at'),
          publishedAt: optionalInstant('dodVersions', row, 'published_at'),
          contentHash: text('dodVersions', row, 'content_hash'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('dodVersions', value);
    await sql`
      INSERT INTO dod_versions
        (id, tenant_id, workspace_id, milestone_id, version, status, criteria, created_by, created_at,
         published_at, content_hash, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.version as number}, ${record.status as string},
        ${sql.json(record.criteria as never)}, ${record.createdBy as string},
        ${record.createdAt as string}, ${(record.publishedAt as string | undefined) ?? null},
        ${record.contentHash as string}, 1, ${BATCH_H_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `publish()` and `supersede()` move the status, and publication stamps the moment. The domain `version`
  // is a revision rather than a counter, so `row_version` is what advances — and `criteria` and
  // `content_hash` are immutable in the database, because a published definition whose criteria could be
  // edited is a bar that can be lowered to match the result.
  async update(sql, value) {
    const record = validateForWrite('dodVersions', value);
    const rows = await sql<Row[]>`
      UPDATE dod_versions
      SET status = ${record.status as string},
          published_at = ${(record.publishedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('dodVersions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. `mandatory_passed` is what `PaymentTriggerEngine.evaluate` reads to decide whether
// DOD_NOT_SATISFIED blocks a release; a mutable evaluation is a satisfied definition of done one statement
// away. A corrected evaluation is a new evaluation.
const dodEvaluations = relation('dodEvaluations', 'dod_evaluations', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, definition_id, results, mandatory_passed,
             manual_review_required, evidence_references, evaluated_by, evaluated_at, schema_version
      FROM dod_evaluations ORDER BY evaluated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('dodEvaluations', row);
      return validateFromRow('dodEvaluations', {
        id: text('dodEvaluations', row, 'id'),
        workspaceId: text('dodEvaluations', row, 'workspace_id'),
        milestoneId: text('dodEvaluations', row, 'milestone_id'),
        definitionId: text('dodEvaluations', row, 'definition_id'),
        results: json(row, 'results'),
        mandatoryPassed: boolean('dodEvaluations', row, 'mandatory_passed'),
        manualReviewRequired: boolean('dodEvaluations', row, 'manual_review_required'),
        evidenceReferences: json(row, 'evidence_references'),
        evaluatedBy: text('dodEvaluations', row, 'evaluated_by'),
        evaluatedAt: instant('dodEvaluations', row, 'evaluated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('dodEvaluations', value);
    await sql`
      INSERT INTO dod_evaluations
        (id, tenant_id, workspace_id, milestone_id, definition_id, results, mandatory_passed,
         manual_review_required, evidence_references, evaluated_by, evaluated_at, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.definitionId as string},
        ${sql.json(record.results as never)}, ${record.mandatoryPassed as boolean},
        ${record.manualReviewRequired as boolean}, ${sql.json(record.evidenceReferences as never)},
        ${record.evaluatedBy as string}, ${record.evaluatedAt as string}, ${BATCH_H_SCHEMA_VERSION},
        ${record.evaluatedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 09 — Certification
// ---------------------------------------------------------------------------------------

const certificationRequests = relation('certificationRequests', 'certification_requests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, milestone_id, dod_evaluation_id, requested_by, status,
             reviewer_ids, created_at, updated_at, version, schema_version
      FROM certification_requests ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('certificationRequests', row);
      return validateFromRow('certificationRequests', {
        id: text('certificationRequests', row, 'id'),
        workspaceId: text('certificationRequests', row, 'workspace_id'),
        executionId: text('certificationRequests', row, 'execution_id'),
        milestoneId: text('certificationRequests', row, 'milestone_id'),
        dodEvaluationId: text('certificationRequests', row, 'dod_evaluation_id'),
        requestedBy: text('certificationRequests', row, 'requested_by'),
        status: text('certificationRequests', row, 'status'),
        reviewerIds: json(row, 'reviewer_ids'),
        createdAt: instant('certificationRequests', row, 'created_at'),
        updatedAt: instant('certificationRequests', row, 'updated_at'),
        version: integer('certificationRequests', row, 'version'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('certificationRequests', value);
    await sql`
      INSERT INTO certification_requests
        (id, tenant_id, workspace_id, execution_id, milestone_id, dod_evaluation_id, requested_by,
         status, reviewer_ids, created_at, updated_at, version, schema_version)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${record.milestoneId as string},
        ${record.dodEvaluationId as string}, ${record.requestedBy as string},
        ${record.status as string}, ${sql.json(record.reviewerIds as never)},
        ${record.createdAt as string}, ${record.updatedAt as string}, ${record.version as number},
        ${BATCH_H_SCHEMA_VERSION}
      )
    `;
  },
  // Status, reviewers and the counter. `dod_evaluation_id` and `requested_by` are immutable in the
  // database: the evaluation is the evidence the certification rests on, and the requester is half of the
  // independence rule that stops a person certifying their own work.
  async update(sql, value) {
    const record = validateForWrite('certificationRequests', value);
    const rows = await sql<Row[]>`
      UPDATE certification_requests
      SET status = ${record.status as string},
          reviewer_ids = ${sql.json(record.reviewerIds as never)},
          updated_at = ${record.updatedAt as string},
          version = ${record.version as number}
      WHERE id = ${requireId('certificationRequests', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A decision is a reviewer's position at a moment; `decide()` refuses a second decision from
// the same reviewer rather than replacing the first.
const certificationDecisions = relation('certificationDecisions', 'certification_decisions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, certification_request_id, reviewer_id, decision, rationale,
             evidence_references, decided_at, schema_version
      FROM certification_decisions ORDER BY decided_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('certificationDecisions', row);
      return validateFromRow('certificationDecisions', {
        id: text('certificationDecisions', row, 'id'),
        workspaceId: text('certificationDecisions', row, 'workspace_id'),
        certificationRequestId: text('certificationDecisions', row, 'certification_request_id'),
        reviewerId: text('certificationDecisions', row, 'reviewer_id'),
        decision: text('certificationDecisions', row, 'decision'),
        rationale: text('certificationDecisions', row, 'rationale'),
        evidenceReferences: json(row, 'evidence_references'),
        decidedAt: instant('certificationDecisions', row, 'decided_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('certificationDecisions', value);
    await sql`
      INSERT INTO certification_decisions
        (id, tenant_id, workspace_id, certification_request_id, reviewer_id, decision, rationale,
         evidence_references, decided_at, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.certificationRequestId as string}, ${record.reviewerId as string},
        ${record.decision as string}, ${record.rationale as string},
        ${sql.json(record.evidenceReferences as never)}, ${record.decidedAt as string},
        ${BATCH_H_SCHEMA_VERSION}, ${record.decidedAt as string}
      )
    `;
  },
});

// No `update`. The certificate is the evidence a milestone was certified; `status` declares REVOKED and no
// engine writes it, so the aggregate is append-only in both the store and the database — a table is
// append-only because of what the engines do, not what its type allows.
const digitalCertifications = relation('digitalCertifications', 'digital_certification_records', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, certification_request_id, milestone_id, certificate_number,
             canonical_hash, status, issued_by, issued_at, schema_version
      FROM digital_certification_records ORDER BY issued_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('digitalCertifications', row);
      return validateFromRow('digitalCertifications', {
        id: text('digitalCertifications', row, 'id'),
        workspaceId: text('digitalCertifications', row, 'workspace_id'),
        certificationRequestId: text('digitalCertifications', row, 'certification_request_id'),
        milestoneId: text('digitalCertifications', row, 'milestone_id'),
        certificateNumber: text('digitalCertifications', row, 'certificate_number'),
        canonicalHash: text('digitalCertifications', row, 'canonical_hash'),
        status: text('digitalCertifications', row, 'status'),
        issuedBy: text('digitalCertifications', row, 'issued_by'),
        issuedAt: instant('digitalCertifications', row, 'issued_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('digitalCertifications', value);
    await sql`
      INSERT INTO digital_certification_records
        (id, tenant_id, workspace_id, certification_request_id, milestone_id, certificate_number,
         canonical_hash, status, issued_by, issued_at, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.certificationRequestId as string}, ${record.milestoneId as string},
        ${record.certificateNumber as string}, ${record.canonicalHash as string},
        ${record.status as string}, ${record.issuedBy as string}, ${record.issuedAt as string},
        ${BATCH_H_SCHEMA_VERSION}, ${record.issuedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 10 — Payment Trigger
// ---------------------------------------------------------------------------------------

// No `update`. `amount_minor` is the sum a proposal inherits and `required_dod_definition_id` is the
// standard it turns on; a mutable trigger would let both change after proposals had been made against them.
const paymentTriggerDefinitions = relation('paymentTriggerDefinitions', 'payment_trigger_definitions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, name, required_dod_definition_id, certification_required,
             amount_minor, currency, escrow_provider_key, status, created_at, version, schema_version
      FROM payment_trigger_definitions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('paymentTriggerDefinitions', row);
      return validateFromRow(
        'paymentTriggerDefinitions',
        compact({
          id: text('paymentTriggerDefinitions', row, 'id'),
          workspaceId: text('paymentTriggerDefinitions', row, 'workspace_id'),
          milestoneId: text('paymentTriggerDefinitions', row, 'milestone_id'),
          name: text('paymentTriggerDefinitions', row, 'name'),
          requiredDodDefinitionId: text('paymentTriggerDefinitions', row, 'required_dod_definition_id'),
          certificationRequired: boolean('paymentTriggerDefinitions', row, 'certification_required'),
          amountMinor: amount('paymentTriggerDefinitions', row, 'amount_minor'),
          currency: text('paymentTriggerDefinitions', row, 'currency'),
          escrowProviderKey: optionalText('paymentTriggerDefinitions', row, 'escrow_provider_key'),
          status: text('paymentTriggerDefinitions', row, 'status'),
          createdAt: instant('paymentTriggerDefinitions', row, 'created_at'),
          version: integer('paymentTriggerDefinitions', row, 'version'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('paymentTriggerDefinitions', value);
    await sql`
      INSERT INTO payment_trigger_definitions
        (id, tenant_id, workspace_id, milestone_id, name, required_dod_definition_id,
         certification_required, amount_minor, currency, escrow_provider_key, status, created_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.name as string},
        ${record.requiredDodDefinitionId as string}, ${record.certificationRequired as boolean},
        ${record.amountMinor as number}, ${record.currency as string},
        ${(record.escrowProviderKey as string | undefined) ?? null}, ${record.status as string},
        ${record.createdAt as string}, ${record.version as number}, ${BATCH_H_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
});

/**
 * No `update`, and this is the most load-bearing absence in the batch.
 *
 * `createEscrowReleaseIntent` reads a proposal, requires `status === 'PROPOSED'`, and then instructs a
 * certified Financial Provider. No engine ever updates a proposal — `propose()` appends one and that is the
 * whole lifecycle — so before `202608110011` a BLOCKED proposal was one statement away from authorising a
 * release for uncertified work. The trigger and the withheld UPDATE privilege are the authority; this
 * missing method is the store agreeing with them.
 */
const paymentAuthorizationProposals = relation(
  'paymentAuthorizationProposals',
  'payment_authorization_proposals',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, trigger_id, milestone_id, certification_id, amount_minor, currency,
               status, blockers, proposed_by, proposed_at, idempotency_key, schema_version
        FROM payment_authorization_proposals ORDER BY proposed_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('paymentAuthorizationProposals', row);
        return validateFromRow(
          'paymentAuthorizationProposals',
          compact({
            id: text('paymentAuthorizationProposals', row, 'id'),
            workspaceId: text('paymentAuthorizationProposals', row, 'workspace_id'),
            triggerId: text('paymentAuthorizationProposals', row, 'trigger_id'),
            milestoneId: text('paymentAuthorizationProposals', row, 'milestone_id'),
            certificationId: optionalText('paymentAuthorizationProposals', row, 'certification_id'),
            amountMinor: amount('paymentAuthorizationProposals', row, 'amount_minor'),
            currency: text('paymentAuthorizationProposals', row, 'currency'),
            status: text('paymentAuthorizationProposals', row, 'status'),
            blockers: json(row, 'blockers'),
            proposedBy: text('paymentAuthorizationProposals', row, 'proposed_by'),
            proposedAt: instant('paymentAuthorizationProposals', row, 'proposed_at'),
            idempotencyKey: text('paymentAuthorizationProposals', row, 'idempotency_key'),
          }),
        );
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('paymentAuthorizationProposals', value);
      await sql`
        INSERT INTO payment_authorization_proposals
          (id, tenant_id, workspace_id, trigger_id, milestone_id, certification_id, amount_minor,
           currency, status, blockers, proposed_by, proposed_at, idempotency_key, schema_version,
           updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.triggerId as string}, ${record.milestoneId as string},
          ${(record.certificationId as string | undefined) ?? null}, ${record.amountMinor as number},
          ${record.currency as string}, ${record.status as string},
          ${sql.json(record.blockers as never)}, ${record.proposedBy as string},
          ${record.proposedAt as string}, ${record.idempotencyKey as string},
          ${BATCH_H_SCHEMA_VERSION}, ${record.proposedAt as string}
        )
      `;
    },
  },
);

export const BATCH_H_RELATIONS: Readonly<Record<string, BatchHRelation>> = Object.freeze(
  Object.fromEntries(
    [
      governedExecutions,
      executionHistory,
      governedMilestones,
      milestoneDependencies,
      dodVersions,
      dodEvaluations,
      certificationRequests,
      certificationDecisions,
      digitalCertifications,
      paymentTriggerDefinitions,
      paymentAuthorizationProposals,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchHCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_H_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection
 * is Batch H's, and a silent undefined would become a lost write.
 */
export function batchHRelation(collection: string): BatchHRelation {
  const found = BATCH_H_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch H aggregate`,
    );
  return found;
}

export const BATCH_H_RELATION_COUNT = Object.keys(BATCH_H_RELATIONS).length;

if (BATCH_H_RELATION_COUNT !== BATCH_H_AGGREGATES.length)
  throw new Error(
    `${BATCH_H_RELATION_COUNT} relational repositories for ${BATCH_H_AGGREGATES.length} ` +
      'Batch H aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
