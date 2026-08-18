import {
  BATCH_G_AGGREGATES,
  BATCH_G_SCHEMA_VERSION,
  batchGContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch G — the six performance-readiness aggregates of canonical
 * Engines 26-30.
 *
 * ## What this replaces
 *
 * Nothing, for the seventh time and the same reason: these six collections were absent from the store's
 * routing table, so `PostgresTrustStore` refused every one of them with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. An acceptance criterion, a success metric, a dependency, a payment
 * trigger rule, a baseline and a variance could not be written to PostgreSQL at all.
 *
 * ## Four of the six are updatable, and three of those could not be updated before
 *
 * `202608030005` put the blanket append-only trigger on `acceptance_criteria`, `success_metrics` and
 * `payment_trigger_rules`, all three of which their engines transition. So this batch is the first where
 * the repository's `update` would have been refused by the database even after the collection was routed
 * — the trigger, not the routing, was the binding constraint. `202608110009` replaces those triggers with
 * governed-transition ones, and the header of that migration explains why the payment trigger rule is the
 * consequential case: a rule that cannot leave DRAFT can never be evaluated, and `paymentEligibility`
 * names it as the authority a release rests on.
 *
 * `performance_baselines` and `baseline_variances` have no `update` here, and that is a claim about the
 * aggregates rather than an omission: a baseline is the plan as it stood, and a variance is an
 * observation. The surviving `<table>_append_only` triggers are the authority; `appendOnly` only makes
 * the refusal legible.
 *
 * ## Reading dates, decimals and signed money
 *
 * The same three column types Batch E met, plus one new case:
 *
 *   - `DATE` columns are read as `::text` rather than rebuilt from a driver `Date`, which would mean
 *     choosing a zone to read a calendar date in.
 *   - `numeric` columns arrive as strings and are genuinely fractional here — a target value of 99.5 per
 *     cent, a risk score of 12.5 — so they are read as finite numbers rather than forced to integers.
 *   - `cost_variance_minor` is **signed** money. Underspend is as real as overspend, so the reader
 *     accepts negatives while still refusing anything outside the exactly representable range: a
 *     silently rounded variance is a wrong answer about money presented as a right one.
 *
 * ## Which invariants live where
 *
 * The repository validates through the canonical schema and lets `202608110009` be the authority for the
 * rest. One invariant lives in neither, deliberately: the **weight allocation per milestone**, which
 * `SuccessMetricsEngine.confirm` bounds at 100% across confirmed metrics. It is a sum over a set with no
 * completion signal — the same shape as Batch E's value allocation — so approximating it would refuse
 * allocations that are legitimately partial.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchGRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The database says the same through the
   * surviving `<table>_append_only` trigger; that trigger is the authority and this flag only makes the
   * refusal legible.
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
  const contract = batchGContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch G aggregate`,
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
 * case is a payment trigger rule: a rule that does not satisfy its own contract is a release condition
 * whose meaning cannot be determined, which is worse than one that is absent.
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
  if (version > BATCH_G_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_G_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry dependency narratives, owner identities
  // and the amounts a release turns on.
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
 * A `DATE` column, as the calendar date it is.
 *
 * Cast to text in the statement rather than rebuilt from a driver `Date`: a `Date` is an instant, and
 * turning one back into a calendar date means choosing a zone to read it in.
 */
function calendarDate(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a calendar date');
  return value as string;
}

function optionalCalendarDate(collection: string, row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return calendarDate(collection, row, column);
}

/**
 * A monetary column as a JavaScript number, signed.
 *
 * `bigint` arrives as a string, so this is a conversion. Negatives are accepted because
 * `cost_variance_minor` is genuinely signed — under budget is a real outcome. A value beyond the
 * exactly representable integer range is refused rather than rounded.
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

function optionalAmount(collection: string, row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return amount(collection, row, column);
}

function integer(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) corrupt(collection, column, 'is not an integer');
  return parsed;
}

function optionalInteger(collection: string, row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return integer(collection, row, column);
}

/**
 * A `numeric` column as a JavaScript number.
 *
 * Arrives as a string, like `bigint`. Unlike money it may legitimately be fractional — a target of 99.5
 * per cent, a risk score of 12.5 — so it is not forced to an integer.
 */
function decimal(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
  return parsed;
}

function optionalDecimal(collection: string, row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return decimal(collection, row, column);
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
): BatchGRelation {
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
// Engine 26 — Acceptance Criteria
// ---------------------------------------------------------------------------------------

const acceptanceCriteria = relation('acceptanceCriteria', 'acceptance_criteria', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, deliverable_id, description, test_method, metric, tolerance,
             validator_role, retest_allowed, max_retests, status, created_at, schema_version
      FROM acceptance_criteria ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('acceptanceCriteria', row);
      return validateFromRow('acceptanceCriteria', {
        id: text('acceptanceCriteria', row, 'id'),
        workspaceId: text('acceptanceCriteria', row, 'workspace_id'),
        deliverableId: text('acceptanceCriteria', row, 'deliverable_id'),
        description: text('acceptanceCriteria', row, 'description'),
        testMethod: text('acceptanceCriteria', row, 'test_method'),
        metric: text('acceptanceCriteria', row, 'metric'),
        tolerance: json(row, 'tolerance'),
        validatorRole: text('acceptanceCriteria', row, 'validator_role'),
        retestAllowed: boolean('acceptanceCriteria', row, 'retest_allowed'),
        maxRetests: integer('acceptanceCriteria', row, 'max_retests'),
        status: text('acceptanceCriteria', row, 'status'),
        createdAt: instant('acceptanceCriteria', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('acceptanceCriteria', value);
    await sql`
      INSERT INTO acceptance_criteria
        (id, tenant_id, workspace_id, deliverable_id, description, test_method, metric, tolerance,
         validator_role, retest_allowed, max_retests, status, created_at, row_version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.deliverableId as string}, ${record.description as string},
        ${record.testMethod as string}, ${record.metric as string}, ${sql.json(record.tolerance)},
        ${record.validatorRole as string}, ${record.retestAllowed as boolean},
        ${record.maxRetests as number}, ${record.status as string}, ${record.createdAt as string}, 1,
        ${BATCH_G_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `confirm()` moves DRAFT to CONFIRMED and changes nothing else, which is why every other column sits
  // in the governed-transition trigger's immutable list. Before `202608110009` this statement was
  // refused outright by the blanket append-only trigger.
  async update(sql, value) {
    const record = validateForWrite('acceptanceCriteria', value);
    const rows = await sql<Row[]>`
      UPDATE acceptance_criteria
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('acceptanceCriteria', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 27 — Success Metrics
// ---------------------------------------------------------------------------------------

const successMetrics = relation('successMetrics', 'success_metrics', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, kind, name, target_value, unit, direction,
             weight_percent, status, created_at, schema_version
      FROM success_metrics ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('successMetrics', row);
      return validateFromRow('successMetrics', {
        id: text('successMetrics', row, 'id'),
        workspaceId: text('successMetrics', row, 'workspace_id'),
        milestoneId: text('successMetrics', row, 'milestone_id'),
        kind: text('successMetrics', row, 'kind'),
        name: text('successMetrics', row, 'name'),
        targetValue: decimal('successMetrics', row, 'target_value'),
        unit: text('successMetrics', row, 'unit'),
        direction: text('successMetrics', row, 'direction'),
        weightPercent: decimal('successMetrics', row, 'weight_percent'),
        status: text('successMetrics', row, 'status'),
        createdAt: instant('successMetrics', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('successMetrics', value);
    await sql`
      INSERT INTO success_metrics
        (id, tenant_id, workspace_id, milestone_id, kind, name, target_value, unit, direction,
         weight_percent, status, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.kind as string}, ${record.name as string},
        ${record.targetValue as number}, ${record.unit as string}, ${record.direction as string},
        ${record.weightPercent as number}, ${record.status as string}, ${record.createdAt as string}, 1,
        ${BATCH_G_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Status only. `weight_percent` is immutable in the database precisely because `confirm()` bounds the
  // confirmed weights for a milestone at 100%: a weight that could change afterwards would let the
  // allocation be exceeded one edit at a time, with no single write breaking the rule.
  async update(sql, value) {
    const record = validateForWrite('successMetrics', value);
    const rows = await sql<Row[]>`
      UPDATE success_metrics
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('successMetrics', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 28 — Dependency Intelligence
// ---------------------------------------------------------------------------------------

const dependencies = relation('dependencies', 'dependencies', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, kind, description, owner_id, due_date::text AS due_date,
             criticality, status, created_at, resolved_at, schema_version
      FROM dependencies ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('dependencies', row);
      return validateFromRow(
        'dependencies',
        compact({
          id: text('dependencies', row, 'id'),
          workspaceId: text('dependencies', row, 'workspace_id'),
          milestoneId: text('dependencies', row, 'milestone_id'),
          kind: text('dependencies', row, 'kind'),
          description: text('dependencies', row, 'description'),
          ownerId: text('dependencies', row, 'owner_id'),
          dueDate: calendarDate('dependencies', row, 'due_date'),
          criticality: text('dependencies', row, 'criticality'),
          status: text('dependencies', row, 'status'),
          createdAt: instant('dependencies', row, 'created_at'),
          resolvedAt: optionalInstant('dependencies', row, 'resolved_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('dependencies', value);
    await sql`
      INSERT INTO dependencies
        (id, tenant_id, workspace_id, milestone_id, kind, description, owner_id, due_date, criticality,
         status, created_at, resolved_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.kind as string}, ${record.description as string},
        ${record.ownerId as string}, ${record.dueDate as string}, ${record.criticality as string},
        ${record.status as string}, ${record.createdAt as string},
        ${(record.resolvedAt as string | undefined) ?? null}, 1, ${BATCH_G_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // `resolve()` writes the status and the time together, because a resolution and the moment it happened
  // are the same event and the CHECK requires them to agree. `criticality` is not here: `blockers()`
  // treats an OPEN BLOCKING dependency as a reason a milestone cannot proceed, and a criticality that
  // could be downgraded in place is a blocker that can be made to vanish without being resolved.
  async update(sql, value) {
    const record = validateForWrite('dependencies', value);
    const rows = await sql<Row[]>`
      UPDATE dependencies
      SET status = ${record.status as string},
          resolved_at = ${(record.resolvedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('dependencies', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 29 — Payment Trigger
// ---------------------------------------------------------------------------------------

const paymentTriggerRules = relation('paymentTriggerRules', 'payment_trigger_rules', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, name, rule_type, required_dod_package_id,
             required_acceptance_criterion_ids, amount_minor, currency, status, created_at,
             schema_version
      FROM payment_trigger_rules ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('paymentTriggerRules', row);
      return validateFromRow(
        'paymentTriggerRules',
        compact({
          id: text('paymentTriggerRules', row, 'id'),
          workspaceId: text('paymentTriggerRules', row, 'workspace_id'),
          milestoneId: text('paymentTriggerRules', row, 'milestone_id'),
          name: text('paymentTriggerRules', row, 'name'),
          ruleType: text('paymentTriggerRules', row, 'rule_type'),
          requiredDodPackageId: optionalText('paymentTriggerRules', row, 'required_dod_package_id'),
          requiredAcceptanceCriterionIds: json(row, 'required_acceptance_criterion_ids'),
          amountMinor: amount('paymentTriggerRules', row, 'amount_minor'),
          currency: text('paymentTriggerRules', row, 'currency'),
          status: text('paymentTriggerRules', row, 'status'),
          createdAt: instant('paymentTriggerRules', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('paymentTriggerRules', value);
    await sql`
      INSERT INTO payment_trigger_rules
        (id, tenant_id, workspace_id, milestone_id, name, rule_type, required_dod_package_id,
         required_acceptance_criterion_ids, amount_minor, currency, status, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.name as string}, ${record.ruleType as string},
        ${(record.requiredDodPackageId as string | undefined) ?? null},
        ${sql.json(record.requiredAcceptanceCriterionIds)}, ${record.amountMinor as number},
        ${record.currency as string}, ${record.status as string}, ${record.createdAt as string}, 1,
        ${BATCH_G_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Status only, and this is the statement the batch exists for. `activate()` moves DRAFT to ACTIVE, and
  // before `202608110009` the blanket append-only trigger refused it — so no rule could ever become
  // ACTIVE, and `evaluate()` refuses anything that is not. The amount, the currency, the rule type and
  // the required evidence are all immutable in the database: an activated rule must not be able to
  // authorise a different sum, or a different condition, than the one that was approved.
  async update(sql, value) {
    const record = validateForWrite('paymentTriggerRules', value);
    const rows = await sql<Row[]>`
      UPDATE payment_trigger_rules
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('paymentTriggerRules', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 30 — Performance Baseline
// ---------------------------------------------------------------------------------------

// No `update`. A baseline is the plan as it stood, and revising it would destroy the comparison every
// variance is measured against. `performance_baselines_append_only` is the authority.
const performanceBaselines = relation('performanceBaselines', 'performance_baselines', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, blueprint_id, milestone_id,
             planned_start_date::text AS planned_start_date,
             planned_due_date::text AS planned_due_date, planned_budget_amount_minor,
             planned_scope_item_count, planned_quality_score, planned_risk_score, status, created_at,
             schema_version
      FROM performance_baselines ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('performanceBaselines', row);
      return validateFromRow('performanceBaselines', {
        id: text('performanceBaselines', row, 'id'),
        workspaceId: text('performanceBaselines', row, 'workspace_id'),
        blueprintId: text('performanceBaselines', row, 'blueprint_id'),
        milestoneId: text('performanceBaselines', row, 'milestone_id'),
        plannedStartDate: calendarDate('performanceBaselines', row, 'planned_start_date'),
        plannedDueDate: calendarDate('performanceBaselines', row, 'planned_due_date'),
        plannedBudgetAmountMinor: amount('performanceBaselines', row, 'planned_budget_amount_minor'),
        plannedScopeItemCount: integer('performanceBaselines', row, 'planned_scope_item_count'),
        plannedQualityScore: decimal('performanceBaselines', row, 'planned_quality_score'),
        plannedRiskScore: decimal('performanceBaselines', row, 'planned_risk_score'),
        status: text('performanceBaselines', row, 'status'),
        createdAt: instant('performanceBaselines', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('performanceBaselines', value);
    await sql`
      INSERT INTO performance_baselines
        (id, tenant_id, workspace_id, blueprint_id, milestone_id, planned_start_date, planned_due_date,
         planned_budget_amount_minor, planned_scope_item_count, planned_quality_score,
         planned_risk_score, status, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.blueprintId as string}, ${record.milestoneId as string},
        ${record.plannedStartDate as string}, ${record.plannedDueDate as string},
        ${record.plannedBudgetAmountMinor as number}, ${record.plannedScopeItemCount as number},
        ${record.plannedQualityScore as number}, ${record.plannedRiskScore as number},
        ${record.status as string}, ${record.createdAt as string}, 1, ${BATCH_G_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
});

// No `update`. A variance is an observation recorded at a moment, not a state that moves; a correction is
// a new observation. `baseline_variances_append_only` is the authority.
const baselineVariances = relation('baselineVariances', 'baseline_variances', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, baseline_id, actual_start_date::text AS actual_start_date,
             actual_due_date::text AS actual_due_date, actual_cost_amount_minor,
             actual_scope_item_count, actual_quality_score, actual_risk_score, schedule_variance_days,
             cost_variance_minor, scope_variance_count, recorded_by, recorded_at, schema_version
      FROM baseline_variances ORDER BY recorded_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('baselineVariances', row);
      return validateFromRow(
        'baselineVariances',
        compact({
          id: text('baselineVariances', row, 'id'),
          workspaceId: text('baselineVariances', row, 'workspace_id'),
          baselineId: text('baselineVariances', row, 'baseline_id'),
          actualStartDate: optionalCalendarDate('baselineVariances', row, 'actual_start_date'),
          actualDueDate: optionalCalendarDate('baselineVariances', row, 'actual_due_date'),
          actualCostAmountMinor: optionalAmount('baselineVariances', row, 'actual_cost_amount_minor'),
          actualScopeItemCount: optionalInteger('baselineVariances', row, 'actual_scope_item_count'),
          actualQualityScore: optionalDecimal('baselineVariances', row, 'actual_quality_score'),
          actualRiskScore: optionalDecimal('baselineVariances', row, 'actual_risk_score'),
          scheduleVarianceDays: integer('baselineVariances', row, 'schedule_variance_days'),
          costVarianceMinor: amount('baselineVariances', row, 'cost_variance_minor'),
          scopeVarianceCount: integer('baselineVariances', row, 'scope_variance_count'),
          recordedBy: text('baselineVariances', row, 'recorded_by'),
          recordedAt: instant('baselineVariances', row, 'recorded_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('baselineVariances', value);
    await sql`
      INSERT INTO baseline_variances
        (id, tenant_id, workspace_id, baseline_id, actual_start_date, actual_due_date,
         actual_cost_amount_minor, actual_scope_item_count, actual_quality_score, actual_risk_score,
         schedule_variance_days, cost_variance_minor, scope_variance_count, recorded_by, recorded_at,
         row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.baselineId as string}, ${(record.actualStartDate as string | undefined) ?? null},
        ${(record.actualDueDate as string | undefined) ?? null},
        ${(record.actualCostAmountMinor as number | undefined) ?? null},
        ${(record.actualScopeItemCount as number | undefined) ?? null},
        ${(record.actualQualityScore as number | undefined) ?? null},
        ${(record.actualRiskScore as number | undefined) ?? null},
        ${record.scheduleVarianceDays as number}, ${record.costVarianceMinor as number},
        ${record.scopeVarianceCount as number}, ${record.recordedBy as string},
        ${record.recordedAt as string}, 1, ${BATCH_G_SCHEMA_VERSION}, ${record.recordedAt as string}
      )
    `;
  },
});

export const BATCH_G_RELATIONS: Readonly<Record<string, BatchGRelation>> = Object.freeze(
  Object.fromEntries(
    [
      acceptanceCriteria,
      successMetrics,
      dependencies,
      paymentTriggerRules,
      performanceBaselines,
      baselineVariances,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchGCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_G_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection
 * is Batch G's, and a silent undefined would become a lost write.
 */
export function batchGRelation(collection: string): BatchGRelation {
  const found = BATCH_G_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch G aggregate`,
    );
  return found;
}

export const BATCH_G_RELATION_COUNT = Object.keys(BATCH_G_RELATIONS).length;

if (BATCH_G_RELATION_COUNT !== BATCH_G_AGGREGATES.length)
  throw new Error(
    `${BATCH_G_RELATION_COUNT} relational repositories for ${BATCH_G_AGGREGATES.length} ` +
      'Batch G aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
