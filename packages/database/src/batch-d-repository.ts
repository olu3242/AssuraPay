import {
  BATCH_D_AGGREGATES,
  BATCH_D_SCHEMA_VERSION,
  batchDContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch D — the five dispute-and-remediation aggregates of canonical
 * Engine 49.
 *
 * ## What this replaces
 *
 * Nothing, for the fourth and last time: these five collections are absent from `GOVERNED_DOCUMENTS`,
 * so `PostgresTrustStore` refused them with `PERSISTENCE_COLLECTION_NOT_MAPPED`. A dispute, its
 * evidence, its positions, its decision and — most consequentially — its **hold** could not be
 * written to PostgreSQL at all. `trust_records` holds zero rows for them, there is nothing to
 * backfill, and routing each collection to its table is the write cutover and the read cutover in
 * one change.
 *
 * That absence is worth stating plainly rather than as a footnote: until now, a dispute hold — the
 * thing CLAUDE.md's second hard constraint requires to block a release — had **no durable home**. It
 * existed only in `InMemoryTrustStore`, which is to say it did not survive a restart.
 *
 * ## Where hold enforcement is *not*
 *
 * Deliberately absent from this file: any check that a release is unheld. A hold blocks a row in
 * another table, so the check belongs where both are visible under one transaction — the triggers
 * `202608110002` puts on `release_requests`, `payment_instructions` and `final_settlement_accounts`.
 * A repository-level check would run only for callers that came through the store, which is the
 * exact population that is *not* the threat.
 *
 * ## Which invariants live where
 *
 * The repository validates through the canonical schema and lets `202608110002`'s constraints be the
 * authority:
 *
 *   - a released hold recording when, and one active hold per dispute and request, are a `CHECK` and
 *     a partial unique index;
 *   - dispute-to-release-request linkage is a workspace-composite foreign key, and the extra column
 *     is what lets the hold triggers read as the caller and still be correct;
 *   - one decision per dispute is a unique constraint;
 *   - a released hold being final, and a closed dispute being final, are triggers;
 *   - hold enforcement itself is a trigger, at three points.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchDRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The database says the same through the
   * surviving `<table>_append_only` trigger; that trigger is the authority and this flag only makes
   * the refusal legible.
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
  const contract = batchDContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch D aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error. For this batch it is the
 * sharpest kind: a hold row that does not satisfy its own contract is a block on money whose state
 * cannot be determined.
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
  if (version > BATCH_D_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_D_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry dispute narratives, party positions
  // and actor identities.
  throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', `${collection}.${column} ${why}`);
}

function text(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
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
): BatchDRelation {
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
// Engine 49 — Dispute, Claim & Appeal Resolution
// ---------------------------------------------------------------------------------------

const disputes = relation('disputes', 'disputes', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, release_request_id, kind, description, status, raised_by,
             created_at, schema_version
      FROM disputes ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('disputes', row);
      return validateFromRow('disputes', {
        id: text('disputes', row, 'id'),
        workspaceId: text('disputes', row, 'workspace_id'),
        releaseRequestId: text('disputes', row, 'release_request_id'),
        kind: text('disputes', row, 'kind'),
        description: text('disputes', row, 'description'),
        status: text('disputes', row, 'status'),
        raisedBy: text('disputes', row, 'raised_by'),
        createdAt: instant('disputes', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('disputes', value);
    await sql`
      INSERT INTO disputes
        (id, tenant_id, workspace_id, release_request_id, kind, description, status, raised_by,
         created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.releaseRequestId as string}, ${record.kind as string},
        ${record.description as string}, ${record.status as string}, ${record.raisedBy as string},
        ${record.createdAt as string}, 1, ${BATCH_D_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('disputes', value);
    // Status is the only transition: mediation, decision, appeal, closure. The release request under
    // dispute, the kind and the description are immutable — enforced by the governed-transition
    // trigger rather than by omitting the columns, because an UPDATE that did not mention them would
    // still let a direct statement repoint a dispute at a different release request.
    const rows = await sql<Row[]>`
      UPDATE disputes
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('disputes', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A retraction is a new record: the material an appeal is decided on cannot be edited
// after the fact.
const disputeEvidence = relation('disputeEvidence', 'dispute_evidence', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, dispute_id, reference, description, submitted_by, submitted_at,
             schema_version
      FROM dispute_evidence ORDER BY submitted_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('disputeEvidence', row);
      return validateFromRow('disputeEvidence', {
        id: text('disputeEvidence', row, 'id'),
        workspaceId: text('disputeEvidence', row, 'workspace_id'),
        disputeId: text('disputeEvidence', row, 'dispute_id'),
        reference: text('disputeEvidence', row, 'reference'),
        description: text('disputeEvidence', row, 'description'),
        submittedBy: text('disputeEvidence', row, 'submitted_by'),
        submittedAt: instant('disputeEvidence', row, 'submitted_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('disputeEvidence', value);
    await sql`
      INSERT INTO dispute_evidence
        (id, tenant_id, workspace_id, dispute_id, reference, description, submitted_by,
         submitted_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.disputeId as string}, ${record.reference as string},
        ${record.description as string}, ${record.submittedBy as string},
        ${record.submittedAt as string}, 1, ${BATCH_D_SCHEMA_VERSION},
        ${record.submittedAt as string}
      )
    `;
  },
});

const disputePositions = relation('disputePositions', 'dispute_positions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, dispute_id, party_id, position, submitted_at, schema_version
      FROM dispute_positions ORDER BY submitted_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('disputePositions', row);
      return validateFromRow('disputePositions', {
        id: text('disputePositions', row, 'id'),
        workspaceId: text('disputePositions', row, 'workspace_id'),
        disputeId: text('disputePositions', row, 'dispute_id'),
        partyId: text('disputePositions', row, 'party_id'),
        position: text('disputePositions', row, 'position'),
        submittedAt: instant('disputePositions', row, 'submitted_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('disputePositions', value);
    await sql`
      INSERT INTO dispute_positions
        (id, tenant_id, workspace_id, dispute_id, party_id, position, submitted_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.disputeId as string}, ${record.partyId as string}, ${record.position as string},
        ${record.submittedAt as string}, 1, ${BATCH_D_SCHEMA_VERSION},
        ${record.submittedAt as string}
      )
    `;
  },
});

const disputeDecisions = relation('disputeDecisions', 'dispute_decisions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, dispute_id, decision, rationale, decided_by, decided_at,
             schema_version
      FROM dispute_decisions ORDER BY decided_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('disputeDecisions', row);
      return validateFromRow('disputeDecisions', {
        id: text('disputeDecisions', row, 'id'),
        workspaceId: text('disputeDecisions', row, 'workspace_id'),
        disputeId: text('disputeDecisions', row, 'dispute_id'),
        decision: text('disputeDecisions', row, 'decision'),
        rationale: text('disputeDecisions', row, 'rationale'),
        decidedBy: text('disputeDecisions', row, 'decided_by'),
        decidedAt: instant('disputeDecisions', row, 'decided_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('disputeDecisions', value);
    await sql`
      INSERT INTO dispute_decisions
        (id, tenant_id, workspace_id, dispute_id, decision, rationale, decided_by, decided_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.disputeId as string}, ${record.decision as string},
        ${record.rationale as string}, ${record.decidedBy as string},
        ${record.decidedAt as string}, 1, ${BATCH_D_SCHEMA_VERSION}, ${record.decidedAt as string}
      )
    `;
  },
});

const disputeHolds = relation('disputeHolds', 'dispute_holds', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, dispute_id, release_request_id, active, placed_at, released_at,
             schema_version
      FROM dispute_holds ORDER BY placed_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('disputeHolds', row);
      return validateFromRow(
        'disputeHolds',
        compact({
          id: text('disputeHolds', row, 'id'),
          workspaceId: text('disputeHolds', row, 'workspace_id'),
          disputeId: text('disputeHolds', row, 'dispute_id'),
          releaseRequestId: text('disputeHolds', row, 'release_request_id'),
          active: boolean('disputeHolds', row, 'active'),
          placedAt: instant('disputeHolds', row, 'placed_at'),
          releasedAt: optionalInstant('disputeHolds', row, 'released_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('disputeHolds', value);
    await sql`
      INSERT INTO dispute_holds
        (id, tenant_id, workspace_id, dispute_id, release_request_id, active, placed_at,
         released_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.disputeId as string}, ${record.releaseRequestId as string},
        ${record.active as boolean}, ${record.placedAt as string},
        ${(record.releasedAt as string | undefined) ?? null}, 1, ${BATCH_D_SCHEMA_VERSION},
        ${record.placedAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('disputeHolds', value);
    // Release, and only release. This UPDATE is the one the blanket append-only trigger would have
    // refused, which would have left every hold permanent and every held release request frozen. The
    // release request and the dispute behind the hold are immutable, and a released hold is terminal:
    // re-activating one would block a release with no new dispute behind it.
    const rows = await sql<Row[]>`
      UPDATE dispute_holds
      SET active = ${record.active as boolean},
          released_at = ${(record.releasedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('disputeHolds', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

/**
 * Every Batch D collection, checked against the contract registry at module load.
 *
 * The cross-check is the point: a repository whose table disagrees with its schema's declared table
 * would write correct-looking rows to the wrong owner, and the failure would surface as absence.
 */
export const BATCH_D_RELATIONS: Readonly<Record<string, BatchDRelation>> = Object.freeze(
  Object.fromEntries(
    [disputes, disputeEvidence, disputePositions, disputeDecisions, disputeHolds].map((entry) => {
      const contract = batchDContract(entry.collection);
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

/** Whether Batch D owns a collection. */
export function isBatchDCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_D_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the
 * collection is Batch D's, and a silent undefined would become a lost write — which for a hold means
 * a block on money that was never recorded.
 */
export function batchDRelation(collection: string): BatchDRelation {
  const found = BATCH_D_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch D aggregate`,
    );
  return found;
}

export const BATCH_D_RELATION_COUNT = Object.keys(BATCH_D_RELATIONS).length;

if (BATCH_D_RELATION_COUNT !== BATCH_D_AGGREGATES.length)
  throw new Error(
    `${BATCH_D_RELATION_COUNT} relational repositories for ${BATCH_D_AGGREGATES.length} ` +
      'Batch D aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
