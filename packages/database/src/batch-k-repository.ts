import {
  BATCH_K_AGGREGATES,
  BATCH_K_SCHEMA_VERSION,
  batchKContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch K — the six enterprise-intelligence aggregates of canonical
 * Engines 51-55.
 *
 * ## What this replaces
 *
 * Nothing, for the tenth time and the same reason: these collections were absent from the store's routing
 * table, so `PostgresTrustStore` refused every one of them with `PERSISTENCE_COLLECTION_NOT_MAPPED`. All six
 * tables existed — `202608030008` created them with their own constraints and no reader or writer — so
 * `202608110014` converges rather than creates.
 *
 * ## Four append-only, two governed, and both governed ones were blocked
 *
 * An assurance index, a KPI value and a dashboard snapshot are each a value at a moment: recomputing produces
 * a new row and no engine passes any of them to `replace`. The other two transition, and a blanket
 * append-only trigger had refused both — `retire()` on a KPI definition and, more consequentially, `review()`
 * on a forecast, which is the human-in-the-loop step the package's AI-governance contract is built on.
 *
 * Each `update` writes only what its engine moves: a definition's status, and a forecast's review status.
 *
 * ## Reading these rows
 *
 * `factors`, `mandatory_gates`, `failed_gates` and `widgets` arrive as parsed `jsonb`, and their shape is the
 * schema's business. The numeric columns are `NUMERIC` rather than integer — a score is `Math.round`ed by the
 * engine but a KPI's `target_value` and `actual_value` are in whatever unit the definition names, and a
 * factor is a percentage that need not be whole — so they are read as numbers, not integers. Nothing here is
 * money: these aggregates score and forecast, and the amounts they report on live in Batches B and H.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the driver's
 * escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchKRelation = {
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
  const contract = batchKContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch K aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error. For this batch the sharpest cases
 * are an index whose score disagrees with its own failed gates — a green banner over work that did not pass —
 * and a dashboard snapshot holding a widget its role may not see, which is a figure the viewer was never
 * entitled to arriving through a read model rather than through the engine that filtered it.
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
  if (version > BATCH_K_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_K_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry KPI targets, dashboard figures and model
  // predictions, and a widget value can be a payable amount.
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

/**
 * A `NUMERIC` column.
 *
 * The driver returns `numeric` as a string to avoid the precision loss a float conversion would cause, so
 * every one of these needs parsing. Read as a number rather than an integer: a factor is a percentage that
 * need not be whole, and a KPI target is in whatever unit the definition names.
 */
function numeric(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
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
): BatchKRelation {
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
// Engine 51 — Execution Assurance Index
// ---------------------------------------------------------------------------------------

// No `update`. An index is a value at a moment; recomputing is a new row, and `latest()` reads the last one.
const executionAssuranceIndices = relation(
  'executionAssuranceIndices',
  'execution_assurance_indices',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, scope_id, factors, mandatory_gates, score, overridden, failed_gates,
               computed_at, schema_version
        FROM execution_assurance_indices ORDER BY computed_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('executionAssuranceIndices', row);
        return validateFromRow('executionAssuranceIndices', {
          id: text('executionAssuranceIndices', row, 'id'),
          workspaceId: text('executionAssuranceIndices', row, 'workspace_id'),
          scopeId: text('executionAssuranceIndices', row, 'scope_id'),
          factors: json(row, 'factors'),
          mandatoryGates: json(row, 'mandatory_gates'),
          score: numeric('executionAssuranceIndices', row, 'score'),
          overridden: boolean('executionAssuranceIndices', row, 'overridden'),
          failedGates: json(row, 'failed_gates'),
          computedAt: instant('executionAssuranceIndices', row, 'computed_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('executionAssuranceIndices', value);
      await sql`
        INSERT INTO execution_assurance_indices
          (id, tenant_id, workspace_id, scope_id, factors, mandatory_gates, score, overridden,
           failed_gates, computed_at, row_version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.scopeId as string}, ${sql.json(record.factors as never)},
          ${sql.json(record.mandatoryGates as never)}, ${record.score as number},
          ${record.overridden as boolean}, ${sql.json(record.failedGates as never)},
          ${record.computedAt as string}, 1, ${BATCH_K_SCHEMA_VERSION}, ${record.computedAt as string}
        )
      `;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Engine 52 — Settlement Assurance Index
// ---------------------------------------------------------------------------------------

const settlementAssuranceIndices = relation(
  'settlementAssuranceIndices',
  'settlement_assurance_indices',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, scope_id, factors, active_hold, score, overridden, computed_at,
               schema_version
        FROM settlement_assurance_indices ORDER BY computed_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('settlementAssuranceIndices', row);
        return validateFromRow('settlementAssuranceIndices', {
          id: text('settlementAssuranceIndices', row, 'id'),
          workspaceId: text('settlementAssuranceIndices', row, 'workspace_id'),
          scopeId: text('settlementAssuranceIndices', row, 'scope_id'),
          factors: json(row, 'factors'),
          activeHold: boolean('settlementAssuranceIndices', row, 'active_hold'),
          score: numeric('settlementAssuranceIndices', row, 'score'),
          overridden: boolean('settlementAssuranceIndices', row, 'overridden'),
          computedAt: instant('settlementAssuranceIndices', row, 'computed_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('settlementAssuranceIndices', value);
      await sql`
        INSERT INTO settlement_assurance_indices
          (id, tenant_id, workspace_id, scope_id, factors, active_hold, score, overridden, computed_at,
           row_version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.scopeId as string}, ${sql.json(record.factors as never)},
          ${record.activeHold as boolean}, ${record.score as number}, ${record.overridden as boolean},
          ${record.computedAt as string}, 1, ${BATCH_K_SCHEMA_VERSION}, ${record.computedAt as string}
        )
      `;
    },
  },
);

// ---------------------------------------------------------------------------------------
// Engine 53 — Enterprise KPI
// ---------------------------------------------------------------------------------------

const kpiDefinitions = relation('kpiDefinitions', 'kpi_definitions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, kind, name, target_value, direction, unit, status, created_at,
             schema_version
      FROM kpi_definitions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('kpiDefinitions', row);
      return validateFromRow('kpiDefinitions', {
        id: text('kpiDefinitions', row, 'id'),
        workspaceId: text('kpiDefinitions', row, 'workspace_id'),
        kind: text('kpiDefinitions', row, 'kind'),
        name: text('kpiDefinitions', row, 'name'),
        targetValue: numeric('kpiDefinitions', row, 'target_value'),
        direction: text('kpiDefinitions', row, 'direction'),
        unit: text('kpiDefinitions', row, 'unit'),
        status: text('kpiDefinitions', row, 'status'),
        createdAt: instant('kpiDefinitions', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('kpiDefinitions', value);
    await sql`
      INSERT INTO kpi_definitions
        (id, tenant_id, workspace_id, kind, name, target_value, direction, unit, status, created_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.kind as string}, ${record.name as string}, ${record.targetValue as number},
        ${record.direction as string}, ${record.unit as string}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_K_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Status only, which is all `retire()` moves. The target, the direction and the unit are what every value
  // already recorded against this definition was judged against — `recordValue` reads them to compute
  // `onTrack` — so a mutable target silently rewrites the meaning of history.
  async update(sql, value) {
    const record = validateForWrite('kpiDefinitions', value);
    const rows = await sql<Row[]>`
      UPDATE kpi_definitions
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('kpiDefinitions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. A recorded value is a measurement; `recordValue` appends and nothing edits.
const kpiValues = relation('kpiValues', 'kpi_values', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, kpi_definition_id, scope_id, actual_value, on_track, recorded_at,
             schema_version
      FROM kpi_values ORDER BY recorded_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('kpiValues', row);
      return validateFromRow('kpiValues', {
        id: text('kpiValues', row, 'id'),
        workspaceId: text('kpiValues', row, 'workspace_id'),
        kpiDefinitionId: text('kpiValues', row, 'kpi_definition_id'),
        scopeId: text('kpiValues', row, 'scope_id'),
        actualValue: numeric('kpiValues', row, 'actual_value'),
        onTrack: boolean('kpiValues', row, 'on_track'),
        recordedAt: instant('kpiValues', row, 'recorded_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('kpiValues', value);
    await sql`
      INSERT INTO kpi_values
        (id, tenant_id, workspace_id, kpi_definition_id, scope_id, actual_value, on_track, recorded_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.kpiDefinitionId as string}, ${record.scopeId as string},
        ${record.actualValue as number}, ${record.onTrack as boolean}, ${record.recordedAt as string},
        1, ${BATCH_K_SCHEMA_VERSION}, ${record.recordedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 54 — Executive Dashboard
// ---------------------------------------------------------------------------------------

// No `update`. A snapshot is what a role saw at a moment; recomposing is a new snapshot, and editing one
// would change the record of what was shown.
const dashboardSnapshots = relation('dashboardSnapshots', 'dashboard_snapshots', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, role, widgets, generated_for, generated_at, schema_version
      FROM dashboard_snapshots ORDER BY generated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('dashboardSnapshots', row);
      return validateFromRow('dashboardSnapshots', {
        id: text('dashboardSnapshots', row, 'id'),
        workspaceId: text('dashboardSnapshots', row, 'workspace_id'),
        role: text('dashboardSnapshots', row, 'role'),
        widgets: json(row, 'widgets'),
        generatedFor: text('dashboardSnapshots', row, 'generated_for'),
        generatedAt: instant('dashboardSnapshots', row, 'generated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('dashboardSnapshots', value);
    await sql`
      INSERT INTO dashboard_snapshots
        (id, tenant_id, workspace_id, role, widgets, generated_for, generated_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.role as string}, ${sql.json(record.widgets as never)},
        ${record.generatedFor as string}, ${record.generatedAt as string}, 1,
        ${BATCH_K_SCHEMA_VERSION}, ${record.generatedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 55 — Predictive Execution Intelligence
// ---------------------------------------------------------------------------------------

const executionForecasts = relation('executionForecasts', 'execution_forecasts', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, scope_id, forecast_type, model_id, model_version, predicted_value,
             confidence, rationale, review_status, generated_at, schema_version
      FROM execution_forecasts ORDER BY generated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('executionForecasts', row);
      return validateFromRow('executionForecasts', {
        id: text('executionForecasts', row, 'id'),
        workspaceId: text('executionForecasts', row, 'workspace_id'),
        scopeId: text('executionForecasts', row, 'scope_id'),
        forecastType: text('executionForecasts', row, 'forecast_type'),
        modelId: text('executionForecasts', row, 'model_id'),
        modelVersion: text('executionForecasts', row, 'model_version'),
        predictedValue: numeric('executionForecasts', row, 'predicted_value'),
        confidence: numeric('executionForecasts', row, 'confidence'),
        rationale: text('executionForecasts', row, 'rationale'),
        reviewStatus: text('executionForecasts', row, 'review_status'),
        generatedAt: instant('executionForecasts', row, 'generated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('executionForecasts', value);
    await sql`
      INSERT INTO execution_forecasts
        (id, tenant_id, workspace_id, scope_id, forecast_type, model_id, model_version, predicted_value,
         confidence, rationale, review_status, generated_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.scopeId as string}, ${record.forecastType as string}, ${record.modelId as string},
        ${record.modelVersion as string}, ${record.predictedValue as number},
        ${record.confidence as number}, ${record.rationale as string},
        ${record.reviewStatus as string}, ${record.generatedAt as string}, 1,
        ${BATCH_K_SCHEMA_VERSION}, ${record.generatedAt as string}
      )
    `;
  },
  // The review status, and nothing else — which is the whole of `review()`. Everything else is the forecast a
  // reviewer read in order to decide: the model, its version, the prediction, the confidence and the
  // rationale. A mutable rationale would mean the record of what was accepted is not what was accepted.
  //
  // This is the statement that could not run before `202608110014`. A blanket append-only trigger refused it,
  // so on the durable store the human-in-the-loop step this aggregate exists for was unperformable and every
  // forecast stayed NOT_REVIEWED forever.
  async update(sql, value) {
    const record = validateForWrite('executionForecasts', value);
    const rows = await sql<Row[]>`
      UPDATE execution_forecasts
      SET review_status = ${record.reviewStatus as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('executionForecasts', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

export const BATCH_K_RELATIONS: Readonly<Record<string, BatchKRelation>> = Object.freeze(
  Object.fromEntries(
    [
      executionAssuranceIndices,
      settlementAssuranceIndices,
      kpiDefinitions,
      kpiValues,
      dashboardSnapshots,
      executionForecasts,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchKCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_K_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection is
 * Batch K's, and a silent undefined would become a lost write.
 */
export function batchKRelation(collection: string): BatchKRelation {
  const found = BATCH_K_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch K aggregate`,
    );
  return found;
}

export const BATCH_K_RELATION_COUNT = Object.keys(BATCH_K_RELATIONS).length;

if (BATCH_K_RELATION_COUNT !== BATCH_K_AGGREGATES.length)
  throw new Error(
    `${BATCH_K_RELATION_COUNT} relational repositories for ${BATCH_K_AGGREGATES.length} ` +
      'Batch K aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
