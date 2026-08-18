import {
  BATCH_L_AGGREGATES,
  BATCH_L_SCHEMA_VERSION,
  batchLContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch L — the nine enterprise-analytics aggregates of canonical
 * Engines 56-60, and the last batch in the durability register.
 *
 * ## What this replaces
 *
 * Nothing, for the eleventh and final time: these collections were absent from the store's routing table, so
 * `PostgresTrustStore` refused every one of them. All nine tables existed — `202608030009` created them with
 * their own constraints and no reader or writer — so `202608110015` converges rather than creates.
 *
 * ## Five append-only, four governed, and every governed one was broken
 *
 * A scorecard, a portfolio snapshot, a renewal assessment, an evaluation record and a piece of model feedback
 * are each a measurement or a statement made at a moment. The other four transition, and this batch's
 * discovery is the sharpest of the programme: three were refused by a blanket append-only trigger — a
 * financial forecast could not be reviewed, a drifting model could not be deprecated, an AI recommendation
 * could not be accepted or dismissed — while `drift_alerts`, the evidence that a model had gone wrong, had no
 * mutation boundary at all.
 *
 * Each `update` writes only what its engine moves: a forecast's review status, a registration's status, an
 * alert's status and resolution time, a recommendation's status and decision time.
 *
 * ## Reading these rows
 *
 * Three column families need care, and each is a place a naive read returns something a schema would reject.
 *
 * `NUMERIC` arrives from the driver as a **string**, to avoid the precision loss a float conversion would
 * cause — every score, threshold, confidence and percentage here is one. `BIGINT` does the same, and
 * `unpaid_amount_minor` and `retained_amount_minor` are integer minor units per CLAUDE.md's fourth
 * constraint. And `period_start` / `period_end` are `DATE`, which the driver hands back as a `Date` at local
 * midnight — so they are formatted back to `YYYY-MM-DD` rather than passed through an ISO conversion that
 * would shift the day in any zone behind UTC.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the driver's
 * escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchLRelation = {
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
  const contract = batchLContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch L aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error. For this batch the sharpest case is
 * an evaluation record claiming a pass below its own threshold: `recordEvaluation` raises a drift alert only
 * when `passed` is false, so such a row does not merely misreport — it suppresses the alert that would have
 * prompted anyone to look at the model.
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
  if (version > BATCH_L_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_L_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry party scores, unpaid balances, model
  // predictions and feedback comments.
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
 * A `DATE` column, as `YYYY-MM-DD`.
 *
 * The driver returns `date` as a `Date` at **local** midnight, so `toISOString()` would move the day back
 * for any zone behind UTC — a scoring period ending on the 31st would read as the 30th, and the
 * `period_end > period_start` check would still pass while the period silently shifted. Formatted from the
 * local components instead, which is what the value actually is: a calendar date with no zone.
 */
function calendarDate(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date)) return corrupt(collection, column, 'is not a date');
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A `NUMERIC` or `BIGINT` column.
 *
 * Both arrive as strings from the driver, which is deliberate on its part: converting either to a float in
 * the driver would lose precision silently. So every one needs parsing here.
 */
function numeric(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
  return parsed;
}

/** An integer column — a count, or an amount in minor units. */
function integer(collection: string, row: Row, column: string): number {
  const parsed = numeric(collection, row, column);
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
): BatchLRelation {
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
// Engine 56 — Financial & Payment Intelligence
// ---------------------------------------------------------------------------------------

const financialForecasts = relation('financialForecasts', 'financial_forecasts', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, scope_id, forecast_type, model_id, model_version, predicted_value,
             confidence, rationale, review_status, generated_at, schema_version
      FROM financial_forecasts ORDER BY generated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('financialForecasts', row);
      return validateFromRow('financialForecasts', {
        id: text('financialForecasts', row, 'id'),
        workspaceId: text('financialForecasts', row, 'workspace_id'),
        scopeId: text('financialForecasts', row, 'scope_id'),
        forecastType: text('financialForecasts', row, 'forecast_type'),
        modelId: text('financialForecasts', row, 'model_id'),
        modelVersion: text('financialForecasts', row, 'model_version'),
        predictedValue: numeric('financialForecasts', row, 'predicted_value'),
        confidence: numeric('financialForecasts', row, 'confidence'),
        rationale: text('financialForecasts', row, 'rationale'),
        reviewStatus: text('financialForecasts', row, 'review_status'),
        generatedAt: instant('financialForecasts', row, 'generated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('financialForecasts', value);
    await sql`
      INSERT INTO financial_forecasts
        (id, tenant_id, workspace_id, scope_id, forecast_type, model_id, model_version, predicted_value,
         confidence, rationale, review_status, generated_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.scopeId as string}, ${record.forecastType as string}, ${record.modelId as string},
        ${record.modelVersion as string}, ${record.predictedValue as number},
        ${record.confidence as number}, ${record.rationale as string},
        ${record.reviewStatus as string}, ${record.generatedAt as string}, 1,
        ${BATCH_L_SCHEMA_VERSION}, ${record.generatedAt as string}
      )
    `;
  },
  // The review status, and nothing else — the whole of `review()`. Everything else is the forecast a reviewer
  // read in order to decide, and these forecast payment failure and leakage. This statement is one of the
  // three a blanket append-only trigger refused before `202608110015`.
  async update(sql, value) {
    const record = validateForWrite('financialForecasts', value);
    const rows = await sql<Row[]>`
      UPDATE financial_forecasts
      SET review_status = ${record.reviewStatus as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('financialForecasts', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 57 — Vendor & Customer Performance
// ---------------------------------------------------------------------------------------

// No `update`. A scorecard covers a closed period; re-scoring is a new row and `history()` reads the series.
const performanceScorecards = relation('performanceScorecards', 'performance_scorecards', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, party_id, party_role, period_start, period_end, metrics, overall_score,
             computed_at, schema_version
      FROM performance_scorecards ORDER BY computed_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('performanceScorecards', row);
      return validateFromRow('performanceScorecards', {
        id: text('performanceScorecards', row, 'id'),
        workspaceId: text('performanceScorecards', row, 'workspace_id'),
        partyId: text('performanceScorecards', row, 'party_id'),
        partyRole: text('performanceScorecards', row, 'party_role'),
        periodStart: calendarDate('performanceScorecards', row, 'period_start'),
        periodEnd: calendarDate('performanceScorecards', row, 'period_end'),
        metrics: json(row, 'metrics'),
        overallScore: numeric('performanceScorecards', row, 'overall_score'),
        computedAt: instant('performanceScorecards', row, 'computed_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('performanceScorecards', value);
    await sql`
      INSERT INTO performance_scorecards
        (id, tenant_id, workspace_id, party_id, party_role, period_start, period_end, metrics,
         overall_score, computed_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.partyId as string}, ${record.partyRole as string}, ${record.periodStart as string},
        ${record.periodEnd as string}, ${sql.json(record.metrics as never)},
        ${record.overallScore as number}, ${record.computedAt as string}, 1,
        ${BATCH_L_SCHEMA_VERSION}, ${record.computedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 58 — Portfolio Analytics
// ---------------------------------------------------------------------------------------

// No `update`. A snapshot is the portfolio at a moment; `trend()` reads the series and editing one would
// rewrite the history the trend is drawn from.
const portfolioSnapshots = relation('portfolioSnapshots', 'portfolio_snapshots', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, scope_id, at_risk_count, blocked_count, unpaid_amount_minor,
             disputed_count, retained_amount_minor, concentration_top_party_percent, currency,
             computed_at, schema_version
      FROM portfolio_snapshots ORDER BY computed_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('portfolioSnapshots', row);
      return validateFromRow('portfolioSnapshots', {
        id: text('portfolioSnapshots', row, 'id'),
        workspaceId: text('portfolioSnapshots', row, 'workspace_id'),
        scopeId: text('portfolioSnapshots', row, 'scope_id'),
        atRiskCount: integer('portfolioSnapshots', row, 'at_risk_count'),
        blockedCount: integer('portfolioSnapshots', row, 'blocked_count'),
        // BIGINT, arriving as a string. Integer minor units per CLAUDE.md's fourth constraint.
        unpaidAmountMinor: integer('portfolioSnapshots', row, 'unpaid_amount_minor'),
        disputedCount: integer('portfolioSnapshots', row, 'disputed_count'),
        retainedAmountMinor: integer('portfolioSnapshots', row, 'retained_amount_minor'),
        concentrationTopPartyPercent: numeric(
          'portfolioSnapshots',
          row,
          'concentration_top_party_percent',
        ),
        currency: text('portfolioSnapshots', row, 'currency'),
        computedAt: instant('portfolioSnapshots', row, 'computed_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('portfolioSnapshots', value);
    await sql`
      INSERT INTO portfolio_snapshots
        (id, tenant_id, workspace_id, scope_id, at_risk_count, blocked_count, unpaid_amount_minor,
         disputed_count, retained_amount_minor, concentration_top_party_percent, currency, computed_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.scopeId as string}, ${record.atRiskCount as number},
        ${record.blockedCount as number}, ${record.unpaidAmountMinor as number},
        ${record.disputedCount as number}, ${record.retainedAmountMinor as number},
        ${record.concentrationTopPartyPercent as number}, ${record.currency as string},
        ${record.computedAt as string}, 1, ${BATCH_L_SCHEMA_VERSION}, ${record.computedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 59 — Renewal & Relationship Intelligence
// ---------------------------------------------------------------------------------------

// No `update`. An assessment is one assessor's position at a moment; reassessing is a new row, and editing
// one would change what a named person concluded about a contract.
const renewalAssessments = relation('renewalAssessments', 'renewal_assessments', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, contract_id, renewal_readiness_score, performance_history_summary,
             recommended_action, rationale, assessed_by, assessed_at, schema_version
      FROM renewal_assessments ORDER BY assessed_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('renewalAssessments', row);
      return validateFromRow('renewalAssessments', {
        id: text('renewalAssessments', row, 'id'),
        workspaceId: text('renewalAssessments', row, 'workspace_id'),
        contractId: text('renewalAssessments', row, 'contract_id'),
        renewalReadinessScore: numeric('renewalAssessments', row, 'renewal_readiness_score'),
        performanceHistorySummary: text('renewalAssessments', row, 'performance_history_summary'),
        recommendedAction: text('renewalAssessments', row, 'recommended_action'),
        rationale: text('renewalAssessments', row, 'rationale'),
        assessedBy: text('renewalAssessments', row, 'assessed_by'),
        assessedAt: instant('renewalAssessments', row, 'assessed_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('renewalAssessments', value);
    await sql`
      INSERT INTO renewal_assessments
        (id, tenant_id, workspace_id, contract_id, renewal_readiness_score,
         performance_history_summary, recommended_action, rationale, assessed_by, assessed_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.contractId as string}, ${record.renewalReadinessScore as number},
        ${record.performanceHistorySummary as string}, ${record.recommendedAction as string},
        ${record.rationale as string}, ${record.assessedBy as string},
        ${record.assessedAt as string}, 1, ${BATCH_L_SCHEMA_VERSION}, ${record.assessedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 60 — AI Decision Support & Continuous Improvement
// ---------------------------------------------------------------------------------------

const modelRegistrations = relation('modelRegistrations', 'model_registrations', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, model_id, model_version, purpose, governed_by, status, registered_at,
             schema_version
      FROM model_registrations ORDER BY registered_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('modelRegistrations', row);
      return validateFromRow('modelRegistrations', {
        id: text('modelRegistrations', row, 'id'),
        workspaceId: text('modelRegistrations', row, 'workspace_id'),
        modelId: text('modelRegistrations', row, 'model_id'),
        modelVersion: text('modelRegistrations', row, 'model_version'),
        purpose: text('modelRegistrations', row, 'purpose'),
        governedBy: text('modelRegistrations', row, 'governed_by'),
        status: text('modelRegistrations', row, 'status'),
        registeredAt: instant('modelRegistrations', row, 'registered_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('modelRegistrations', value);
    await sql`
      INSERT INTO model_registrations
        (id, tenant_id, workspace_id, model_id, model_version, purpose, governed_by, status,
         registered_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.modelId as string}, ${record.modelVersion as string}, ${record.purpose as string},
        ${record.governedBy as string}, ${record.status as string}, ${record.registeredAt as string},
        1, ${BATCH_L_SCHEMA_VERSION}, ${record.registeredAt as string}
      )
    `;
  },
  // Status only, which is all `deprecateModel` moves. The model id and version are what every evaluation,
  // drift alert, feedback item and recommendation in this batch references, so a mutable `model_id` would
  // silently re-attribute all of them to a different model.
  //
  // This statement was refused before `202608110015`, which meant a model the platform had *itself* flagged
  // as drifting — `recordEvaluation` raises the alert automatically — could not be taken out of service.
  async update(sql, value) {
    const record = validateForWrite('modelRegistrations', value);
    const rows = await sql<Row[]>`
      UPDATE model_registrations
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('modelRegistrations', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. An evaluation is a measurement against a threshold at a moment, and `recordEvaluation` raises
// a drift alert from it — so an editable evaluation could retract the reason an alert exists.
const evaluationRecords = relation('evaluationRecords', 'evaluation_records', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, model_registration_id, metric, score, threshold, passed, evaluated_at,
             schema_version
      FROM evaluation_records ORDER BY evaluated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('evaluationRecords', row);
      return validateFromRow('evaluationRecords', {
        id: text('evaluationRecords', row, 'id'),
        workspaceId: text('evaluationRecords', row, 'workspace_id'),
        modelRegistrationId: text('evaluationRecords', row, 'model_registration_id'),
        metric: text('evaluationRecords', row, 'metric'),
        score: numeric('evaluationRecords', row, 'score'),
        threshold: numeric('evaluationRecords', row, 'threshold'),
        passed: boolean('evaluationRecords', row, 'passed'),
        evaluatedAt: instant('evaluationRecords', row, 'evaluated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('evaluationRecords', value);
    await sql`
      INSERT INTO evaluation_records
        (id, tenant_id, workspace_id, model_registration_id, metric, score, threshold, passed,
         evaluated_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.modelRegistrationId as string}, ${record.metric as string},
        ${record.score as number}, ${record.threshold as number}, ${record.passed as boolean},
        ${record.evaluatedAt as string}, 1, ${BATCH_L_SCHEMA_VERSION},
        ${record.evaluatedAt as string}
      )
    `;
  },
});

const driftAlerts = relation('driftAlerts', 'drift_alerts', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, model_registration_id, description, severity, status, raised_at,
             resolved_at, schema_version
      FROM drift_alerts ORDER BY raised_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('driftAlerts', row);
      return validateFromRow(
        'driftAlerts',
        compact({
          id: text('driftAlerts', row, 'id'),
          workspaceId: text('driftAlerts', row, 'workspace_id'),
          modelRegistrationId: text('driftAlerts', row, 'model_registration_id'),
          description: text('driftAlerts', row, 'description'),
          severity: text('driftAlerts', row, 'severity'),
          status: text('driftAlerts', row, 'status'),
          raisedAt: instant('driftAlerts', row, 'raised_at'),
          resolvedAt: optionalInstant('driftAlerts', row, 'resolved_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('driftAlerts', value);
    await sql`
      INSERT INTO drift_alerts
        (id, tenant_id, workspace_id, model_registration_id, description, severity, status, raised_at,
         resolved_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.modelRegistrationId as string}, ${record.description as string},
        ${record.severity as string}, ${record.status as string}, ${record.raisedAt as string},
        ${(record.resolvedAt as string | undefined) ?? null}, 1, ${BATCH_L_SCHEMA_VERSION},
        ${record.raisedAt as string}
      )
    `;
  },
  // Status and resolution time — `acknowledgeDrift` moves the first, `resolveDrift` both. The description,
  // the severity and the model are the alert.
  //
  // This table had **no** mutation boundary at all before `202608110015`, so the severity of a drift alert
  // could be lowered and the alert deleted outright. It is the evidence that a registered model has gone
  // wrong, and it was the one thing in the batch nothing protected.
  async update(sql, value) {
    const record = validateForWrite('driftAlerts', value);
    const rows = await sql<Row[]>`
      UPDATE drift_alerts
      SET status = ${record.status as string},
          resolved_at = ${(record.resolvedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('driftAlerts', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// No `update`. Feedback is one person's judgement on one output at a moment; a second opinion is a second row.
const modelFeedback = relation('modelFeedback', 'model_feedback', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, model_registration_id, output_reference, rating, comment, submitted_by,
             submitted_at, schema_version
      FROM model_feedback ORDER BY submitted_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('modelFeedback', row);
      return validateFromRow('modelFeedback', {
        id: text('modelFeedback', row, 'id'),
        workspaceId: text('modelFeedback', row, 'workspace_id'),
        modelRegistrationId: text('modelFeedback', row, 'model_registration_id'),
        outputReference: text('modelFeedback', row, 'output_reference'),
        rating: text('modelFeedback', row, 'rating'),
        comment: text('modelFeedback', row, 'comment'),
        submittedBy: text('modelFeedback', row, 'submitted_by'),
        submittedAt: instant('modelFeedback', row, 'submitted_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('modelFeedback', value);
    await sql`
      INSERT INTO model_feedback
        (id, tenant_id, workspace_id, model_registration_id, output_reference, rating, comment,
         submitted_by, submitted_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.modelRegistrationId as string}, ${record.outputReference as string},
        ${record.rating as string}, ${record.comment as string}, ${record.submittedBy as string},
        ${record.submittedAt as string}, 1, ${BATCH_L_SCHEMA_VERSION}, ${record.submittedAt as string}
      )
    `;
  },
});

const recommendations = relation('recommendations', 'recommendations', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, scope_id, model_registration_id, recommendation, confidence, status,
             created_at, decided_at, schema_version
      FROM recommendations ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('recommendations', row);
      return validateFromRow(
        'recommendations',
        compact({
          id: text('recommendations', row, 'id'),
          workspaceId: text('recommendations', row, 'workspace_id'),
          scopeId: text('recommendations', row, 'scope_id'),
          modelRegistrationId: text('recommendations', row, 'model_registration_id'),
          recommendation: text('recommendations', row, 'recommendation'),
          confidence: numeric('recommendations', row, 'confidence'),
          status: text('recommendations', row, 'status'),
          createdAt: instant('recommendations', row, 'created_at'),
          decidedAt: optionalInstant('recommendations', row, 'decided_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('recommendations', value);
    await sql`
      INSERT INTO recommendations
        (id, tenant_id, workspace_id, scope_id, model_registration_id, recommendation, confidence,
         status, created_at, decided_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.scopeId as string}, ${record.modelRegistrationId as string},
        ${record.recommendation as string}, ${record.confidence as number},
        ${record.status as string}, ${record.createdAt as string},
        ${(record.decidedAt as string | undefined) ?? null}, 1, ${BATCH_L_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // Status and decision time, which is the whole of `decideRecommendation`. The recommendation text, its
  // confidence and the model that produced it are what a human accepted or dismissed — and the engine's
  // stated contract is that a recommendation is never auto-executed, so this statement being refused meant
  // the human step could not be recorded at all.
  async update(sql, value) {
    const record = validateForWrite('recommendations', value);
    const rows = await sql<Row[]>`
      UPDATE recommendations
      SET status = ${record.status as string},
          decided_at = ${(record.decidedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('recommendations', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

export const BATCH_L_RELATIONS: Readonly<Record<string, BatchLRelation>> = Object.freeze(
  Object.fromEntries(
    [
      financialForecasts,
      performanceScorecards,
      portfolioSnapshots,
      renewalAssessments,
      modelRegistrations,
      evaluationRecords,
      driftAlerts,
      modelFeedback,
      recommendations,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchLCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_L_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection is
 * Batch L's, and a silent undefined would become a lost write.
 */
export function batchLRelation(collection: string): BatchLRelation {
  const found = BATCH_L_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch L aggregate`,
    );
  return found;
}

export const BATCH_L_RELATION_COUNT = Object.keys(BATCH_L_RELATIONS).length;

if (BATCH_L_RELATION_COUNT !== BATCH_L_AGGREGATES.length)
  throw new Error(
    `${BATCH_L_RELATION_COUNT} relational repositories for ${BATCH_L_AGGREGATES.length} ` +
      'Batch L aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
