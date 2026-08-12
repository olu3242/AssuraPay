import {
  BATCH_E_AGGREGATES,
  BATCH_E_SCHEMA_VERSION,
  batchEContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch E — the six performance-blueprint aggregates of canonical
 * Engines 16-20.
 *
 * ## What this replaces
 *
 * Nothing, for the fifth time and the same reason: these six collections were absent from the store's
 * routing table, so `PostgresTrustStore` refused every one of them with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. A blueprint, a scope item, a deliverable, a milestone, a
 * sequence edge and a definition-of-done package could not be written to PostgreSQL at all.
 *
 * This is the first batch of the sixty-seven `docs/persistence/DURABILITY_GAP_ANALYSIS.md` registers,
 * and it repairs three canonical chain links — `performanceBlueprints`, `blueprintMilestones`,
 * `dodPackages`. Before it, the durable half of the chain referenced a half that did not exist.
 *
 * ## The concurrency column is `row_version`
 *
 * Not `version`, which two of these aggregates already own as a **domain** field: the revision a
 * blueprint or a package *is*. `202608110004` explains the collision in full; the consequence here is
 * that every `update` advances `row_version` and never touches `version`, which sits in the
 * governed-transition trigger's immutable list.
 *
 * ## Reading dates and decimals
 *
 * Two column types this batch meets that the settlement batches did not:
 *
 *   - `DATE` columns are read as `::text`, not rebuilt from a driver `Date`, which would mean choosing
 *     a zone to read a calendar date in. The Batch A lesson, applied where it recurs.
 *   - `numeric` columns arrive as strings, like `bigint`. `quantity` and `value_allocation_percent` are
 *     genuinely fractional — 2.5 tonnes, 12.5% — so they are read as finite numbers rather than forced
 *     to integers, and a value that does not survive the conversion is a corrupt row rather than a
 *     rounded one.
 *
 * ## Which invariants live where
 *
 * The repository validates through the canonical schema and lets `202608110004` and `202608030004` be
 * the authority. Two invariants live in neither, deliberately: the blueprint's total value allocation
 * and acyclicity of the sequence graph beyond a self-edge. Both are properties of a set with no
 * completion signal, and approximating them would refuse plans that are legitimately partial.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver’s escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchERelation = {
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
  const contract = batchEContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch E aggregate`,
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
  if (version > BATCH_E_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_E_SCHEMA_VERSION}`,
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

/**
 * A monetary column as a JavaScript number.
 *
 * `bigint` arrives as a string, so this is a conversion. A value beyond `Number.MAX_SAFE_INTEGER` is a
 * row this build cannot represent exactly, and both that and a non-finite value are refused rather than
 * rounded — a silently rounded budget is a plan for the wrong sum of money.
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

/**
 * A `DATE` column, as the calendar date it is.
 *
 * Cast to text in the statement rather than rebuilt from a driver `Date`: a `Date` is an instant, and
 * turning one back into a calendar date means choosing a zone to read it in. The row already holds the
 * answer.
 */
function calendarDate(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a calendar date');
  return value as string;
}

/**
 * A `numeric` column as a JavaScript number.
 *
 * Arrives as a string, like `bigint`, so this is a conversion. Unlike money it may legitimately be
 * fractional — 2.5 tonnes, 12.5 per cent — so it is not forced to an integer; a value that is not
 * finite is a corrupt row rather than something to round.
 */
function decimal(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
  return parsed;
}

/** A `jsonb` column, already parsed by the driver. Its shape is the schema’s business. */
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
): BatchERelation {
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
// Engine 16 — Performance Blueprint
// ---------------------------------------------------------------------------------------

const performanceBlueprints = relation('performanceBlueprints', 'performance_blueprints', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, contract_version_id,
             agreement_intelligence_version_id, version, status, created_by, created_at,
             content_hash, schema_version
      FROM performance_blueprints ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('performanceBlueprints', row);
      return validateFromRow('performanceBlueprints', {
        id: text('performanceBlueprints', row, 'id'),
        workspaceId: text('performanceBlueprints', row, 'workspace_id'),
        contractId: text('performanceBlueprints', row, 'contract_id'),
        contractVersionId: text('performanceBlueprints', row, 'contract_version_id'),
        agreementIntelligenceVersionId: text(
          'performanceBlueprints',
          row,
          'agreement_intelligence_version_id',
        ),
        version: decimal('performanceBlueprints', row, 'version'),
        status: text('performanceBlueprints', row, 'status'),
        createdBy: text('performanceBlueprints', row, 'created_by'),
        createdAt: instant('performanceBlueprints', row, 'created_at'),
        contentHash: text('performanceBlueprints', row, 'content_hash'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('performanceBlueprints', value);
    await sql`
      INSERT INTO performance_blueprints
        (id, tenant_id, workspace_id, contract_id, contract_version_id,
         agreement_intelligence_version_id, version, status, created_by, created_at,
         content_hash, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.contractVersionId as string},
        ${record.agreementIntelligenceVersionId as string}, ${record.version as number},
        ${record.status as string}, ${record.createdBy as string}, ${record.createdAt as string},
        ${record.contentHash as string}, 1, ${BATCH_E_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('performanceBlueprints', value);
    // Activation and supersession. `version` is the revision this row *is* and never moves, so the
    // concurrency counter is `row_version` — enforced by the governed-transition trigger, which has
    // `version` in its immutable list and is told to check `row_version` instead.
    const rows = await sql<Row[]>`
      UPDATE performance_blueprints
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('performanceBlueprints', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 17 — Scope Definition
// ---------------------------------------------------------------------------------------

const scopeItems = relation('scopeItems', 'scope_items', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, kind, description, assumptions, constraints,
             owner_id, status, created_at, schema_version
      FROM scope_items ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('scopeItems', row);
      return validateFromRow('scopeItems', {
        id: text('scopeItems', row, 'id'),
        workspaceId: text('scopeItems', row, 'workspace_id'),
        blueprintId: text('scopeItems', row, 'blueprint_id'),
        kind: text('scopeItems', row, 'kind'),
        description: text('scopeItems', row, 'description'),
        assumptions: json(row, 'assumptions'),
        constraints: json(row, 'constraints'),
        ownerId: text('scopeItems', row, 'owner_id'),
        status: text('scopeItems', row, 'status'),
        createdAt: instant('scopeItems', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('scopeItems', value);
    await sql`
      INSERT INTO scope_items
        (id, tenant_id, workspace_id, blueprint_id, kind, description, assumptions, constraints,
         owner_id, status, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.kind as string},
        ${record.description as string}, ${sql.json(record.assumptions)},
        ${sql.json(record.constraints)}, ${record.ownerId as string},
        ${record.status as string}, ${record.createdAt as string}, 1, ${BATCH_E_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('scopeItems', value);
    const rows = await sql<Row[]>`
      UPDATE scope_items
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('scopeItems', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 18 — Deliverables
// ---------------------------------------------------------------------------------------

const deliverables = relation('deliverables', 'deliverables', {
  async list(sql) {
    // `due_date` cast to text: a DATE rebuilt from a driver `Date` would need a zone to read it in.
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, scope_item_id, title, quantity, unit,
             quality_standard, owner_id, due_date::text AS due_date, acceptance_criteria,
             evidence_requirements, status, created_at, schema_version
      FROM deliverables ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('deliverables', row);
      return validateFromRow('deliverables', {
        id: text('deliverables', row, 'id'),
        workspaceId: text('deliverables', row, 'workspace_id'),
        blueprintId: text('deliverables', row, 'blueprint_id'),
        scopeItemId: text('deliverables', row, 'scope_item_id'),
        title: text('deliverables', row, 'title'),
        quantity: decimal('deliverables', row, 'quantity'),
        unit: text('deliverables', row, 'unit'),
        qualityStandard: text('deliverables', row, 'quality_standard'),
        ownerId: text('deliverables', row, 'owner_id'),
        dueDate: calendarDate('deliverables', row, 'due_date'),
        acceptanceCriteria: json(row, 'acceptance_criteria'),
        evidenceRequirements: json(row, 'evidence_requirements'),
        status: text('deliverables', row, 'status'),
        createdAt: instant('deliverables', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('deliverables', value);
    await sql`
      INSERT INTO deliverables
        (id, tenant_id, workspace_id, blueprint_id, scope_item_id, title, quantity, unit,
         quality_standard, owner_id, due_date, acceptance_criteria, evidence_requirements,
         status, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.scopeItemId as string},
        ${record.title as string}, ${record.quantity as number}, ${record.unit as string},
        ${record.qualityStandard as string}, ${record.ownerId as string},
        ${record.dueDate as string}, ${sql.json(record.acceptanceCriteria)},
        ${sql.json(record.evidenceRequirements)}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_E_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('deliverables', value);
    const rows = await sql<Row[]>`
      UPDATE deliverables
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('deliverables', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 19 — Milestone Planning
// ---------------------------------------------------------------------------------------

// No `update`. Nothing in the repository transitions a milestone: `BlueprintMilestone.status` declares
// a CANCELLED value and no engine ever writes it.
const blueprintMilestones = relation('blueprintMilestones', 'blueprint_milestones', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, title, deliverable_ids,
             start_date::text AS start_date, due_date::text AS due_date, budget_amount_minor,
             currency, value_allocation_percent, status, created_at, schema_version
      FROM blueprint_milestones ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('blueprintMilestones', row);
      return validateFromRow('blueprintMilestones', {
        id: text('blueprintMilestones', row, 'id'),
        workspaceId: text('blueprintMilestones', row, 'workspace_id'),
        blueprintId: text('blueprintMilestones', row, 'blueprint_id'),
        title: text('blueprintMilestones', row, 'title'),
        deliverableIds: json(row, 'deliverable_ids'),
        startDate: calendarDate('blueprintMilestones', row, 'start_date'),
        dueDate: calendarDate('blueprintMilestones', row, 'due_date'),
        budgetAmountMinor: amount('blueprintMilestones', row, 'budget_amount_minor'),
        currency: text('blueprintMilestones', row, 'currency'),
        valueAllocationPercent: decimal('blueprintMilestones', row, 'value_allocation_percent'),
        status: text('blueprintMilestones', row, 'status'),
        createdAt: instant('blueprintMilestones', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('blueprintMilestones', value);
    await sql`
      INSERT INTO blueprint_milestones
        (id, tenant_id, workspace_id, blueprint_id, title, deliverable_ids, start_date, due_date,
         budget_amount_minor, currency, value_allocation_percent, status, created_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.title as string},
        ${sql.json(record.deliverableIds)}, ${record.startDate as string},
        ${record.dueDate as string}, ${record.budgetAmountMinor as number},
        ${record.currency as string}, ${record.valueAllocationPercent as number},
        ${record.status as string}, ${record.createdAt as string}, 1, ${BATCH_E_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
});

// No `update`. A sequence edge has no status: the graph changes by gaining or losing edges, and losing
// one is not something any engine does.
const milestoneSequenceEdges = relation('milestoneSequenceEdges', 'milestone_sequence_edges', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, predecessor_id, successor_id, created_at,
             schema_version
      FROM milestone_sequence_edges ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('milestoneSequenceEdges', row);
      return validateFromRow('milestoneSequenceEdges', {
        id: text('milestoneSequenceEdges', row, 'id'),
        workspaceId: text('milestoneSequenceEdges', row, 'workspace_id'),
        blueprintId: text('milestoneSequenceEdges', row, 'blueprint_id'),
        predecessorId: text('milestoneSequenceEdges', row, 'predecessor_id'),
        successorId: text('milestoneSequenceEdges', row, 'successor_id'),
        createdAt: instant('milestoneSequenceEdges', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('milestoneSequenceEdges', value);
    await sql`
      INSERT INTO milestone_sequence_edges
        (id, tenant_id, workspace_id, blueprint_id, predecessor_id, successor_id, created_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.predecessorId as string},
        ${record.successorId as string}, ${record.createdAt as string}, 1,
        ${BATCH_E_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 20 — Definition of Done
// ---------------------------------------------------------------------------------------

const dodPackages = relation('dodPackages', 'dod_packages', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, version, deliverable_gate_ids, criteria,
             evidence_requirements, quality_gate, compliance_gate, risk_gate, payment_gate,
             status, created_by, created_at, content_hash, schema_version
      FROM dod_packages ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('dodPackages', row);
      return validateFromRow('dodPackages', {
        id: text('dodPackages', row, 'id'),
        workspaceId: text('dodPackages', row, 'workspace_id'),
        milestoneId: text('dodPackages', row, 'milestone_id'),
        version: decimal('dodPackages', row, 'version'),
        deliverableGateIds: json(row, 'deliverable_gate_ids'),
        criteria: json(row, 'criteria'),
        evidenceRequirements: json(row, 'evidence_requirements'),
        qualityGate: boolean('dodPackages', row, 'quality_gate'),
        complianceGate: boolean('dodPackages', row, 'compliance_gate'),
        riskGate: boolean('dodPackages', row, 'risk_gate'),
        paymentGate: boolean('dodPackages', row, 'payment_gate'),
        status: text('dodPackages', row, 'status'),
        createdBy: text('dodPackages', row, 'created_by'),
        createdAt: instant('dodPackages', row, 'created_at'),
        contentHash: text('dodPackages', row, 'content_hash'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('dodPackages', value);
    await sql`
      INSERT INTO dod_packages
        (id, tenant_id, workspace_id, milestone_id, version, deliverable_gate_ids, criteria,
         evidence_requirements, quality_gate, compliance_gate, risk_gate, payment_gate, status,
         created_by, created_at, content_hash, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.version as number},
        ${sql.json(record.deliverableGateIds)}, ${sql.json(record.criteria)},
        ${sql.json(record.evidenceRequirements)}, ${record.qualityGate as boolean},
        ${record.complianceGate as boolean}, ${record.riskGate as boolean},
        ${record.paymentGate as boolean}, ${record.status as string},
        ${record.createdBy as string}, ${record.createdAt as string},
        ${record.contentHash as string}, 1, ${BATCH_E_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('dodPackages', value);
    // Publication and supersession. As with a blueprint, `version` is the revision this row is and the
    // concurrency counter is `row_version`.
    const rows = await sql<Row[]>`
      UPDATE dod_packages
      SET status = ${record.status as string}, row_version = row_version + 1, updated_at = now()
      WHERE id = ${requireId('dodPackages', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

/**
 * Every Batch E collection, checked against the contract registry at module load.
 *
 * The cross-check is the point: a repository whose table disagrees with its schema's declared table
 * would write correct-looking rows to the wrong owner, and the failure would surface as absence.
 */
export const BATCH_E_RELATIONS: Readonly<Record<string, BatchERelation>> = Object.freeze(
  Object.fromEntries(
    [
      performanceBlueprints,
      scopeItems,
      deliverables,
      blueprintMilestones,
      milestoneSequenceEdges,
      dodPackages,
    ].map((entry) => {
      const contract = batchEContract(entry.collection);
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

/** Whether Batch E owns a collection. */
export function isBatchECollection(collection: string): boolean {
  return Object.hasOwn(BATCH_E_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the
 * collection is Batch E's, and a silent undefined would become a lost write.
 */
export function batchERelation(collection: string): BatchERelation {
  const found = BATCH_E_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch E aggregate`,
    );
  return found;
}

export const BATCH_E_RELATION_COUNT = Object.keys(BATCH_E_RELATIONS).length;

if (BATCH_E_RELATION_COUNT !== BATCH_E_AGGREGATES.length)
  throw new Error(
    `${BATCH_E_RELATION_COUNT} relational repositories for ${BATCH_E_AGGREGATES.length} ` +
      'Batch E aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
