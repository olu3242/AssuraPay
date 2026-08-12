import {
  BATCH_B_AGGREGATES,
  BATCH_B_SCHEMA_VERSION,
  batchBContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch B — the seven entitlement-and-claim aggregates of canonical
 * Engines 41–43 and 45–46.
 *
 * ## What this replaces
 *
 * Nothing, for the same reason Batch A replaced nothing: these seven collections are absent from
 * `GOVERNED_DOCUMENTS`, so `PostgresTrustStore` refused them with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. A payment eligibility, an entitlement, an invoice, a release
 * request or an authorization could not be written to PostgreSQL at all — Engines 41–46 worked only
 * against `InMemoryTrustStore`. `trust_records` therefore holds zero rows for them, there is nothing
 * to backfill, and routing each collection to its table is the write cutover and the read cutover in
 * one change.
 *
 * ## Money
 *
 * This is the first batch where the store handles money, and `bigint` is the reason the column
 * readers matter. PostgreSQL returns `bigint` as a *string* over the wire, so every monetary read is
 * a conversion rather than a cast, and a conversion that silently produced `NaN` would turn a
 * malformed row into a zero-valued entitlement. `amount` below refuses instead, and bounds the value
 * at `Number.MAX_SAFE_INTEGER` — beyond that a JavaScript `number` has already lost precision, and
 * the domain types type money as `number`, so accepting a larger value would promise exactness the
 * language cannot deliver.
 *
 * ## Which invariants live where
 *
 * `docs/finance/MONETARY_INVARIANTS.md`: "An invariant that PostgreSQL can enforce must not exist
 * only as an application check." So the repository does not re-implement the money rules — it
 * validates through the canonical schema and lets `202608100002`'s constraints be the authority:
 *
 *   - amount bounds, deduction non-negativity, and the net-payable arithmetic are `CHECK`s;
 *   - the governed currency set is a `CHECK`;
 *   - currency agreement between an invoice and its entitlement is a composite foreign key;
 *   - cross-tenant references are composite foreign keys, because foreign key checks run as the
 *     table owner and are **not** subject to row-level security — a single-column key would admit a
 *     child in one tenant referencing a parent in another while the policy hid the parent;
 *   - segregation of duties is a trigger, because it compares two rows.
 *
 * ## Where tenancy comes from
 *
 * The ambient trust scope, not the record — none of the seven domain types carries a `tenantId`.
 * Identical to Batch A, and the same refusals apply: no scope, or a record naming another
 * workspace, is `PERSISTENCE_SCOPE_INVALID` rather than a bare policy rejection.
 *
 * ## What is not claimed
 *
 * `version` advances and the database requires it to, but there is still no optimistic-concurrency
 * check at the application boundary: `TrustPersistence.replace` takes a record that does not carry
 * the version it was read at. Two concurrent transitions both succeed and the later wins. That is a
 * persistence-contract change and a separate capability.
 */

type Row = Record<string, unknown>;

export type BatchBRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The database says the same through
   * the surviving `<table>_append_only` trigger; that trigger is the authority and this flag only
   * makes the refusal legible.
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
  const contract = batchBContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch B aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error: it means a stored row does
 * not satisfy its own contract, which for a settlement aggregate means an amount a release gate
 * would otherwise act on.
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
  if (version > BATCH_B_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_B_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry amounts, actor identities and
  // narrative rationales.
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
 * A monetary or count column as a JavaScript number.
 *
 * `bigint` arrives as a string, so this is a conversion. A value that does not survive it is a
 * corrupt row, and one beyond `Number.MAX_SAFE_INTEGER` is a row this build cannot represent
 * exactly — both are refused rather than rounded, because a silently rounded amount is the worst
 * possible outcome for a settlement aggregate.
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
): BatchBRelation {
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
// Engine 41 — Payment Eligibility
// ---------------------------------------------------------------------------------------

const paymentEligibilities = relation('paymentEligibilities', 'payment_eligibilities', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, completion_certificate_id, payment_trigger_rule_id,
             eligible, blockers, evaluated_by, evaluated_at, schema_version
      FROM payment_eligibilities ORDER BY evaluated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('paymentEligibilities', row);
      return validateFromRow('paymentEligibilities', {
        id: text('paymentEligibilities', row, 'id'),
        workspaceId: text('paymentEligibilities', row, 'workspace_id'),
        milestoneId: text('paymentEligibilities', row, 'milestone_id'),
        completionCertificateId: text('paymentEligibilities', row, 'completion_certificate_id'),
        paymentTriggerRuleId: text('paymentEligibilities', row, 'payment_trigger_rule_id'),
        eligible: boolean('paymentEligibilities', row, 'eligible'),
        blockers: json(row, 'blockers'),
        evaluatedBy: text('paymentEligibilities', row, 'evaluated_by'),
        evaluatedAt: instant('paymentEligibilities', row, 'evaluated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('paymentEligibilities', value);
    await sql`
      INSERT INTO payment_eligibilities
        (id, tenant_id, workspace_id, milestone_id, completion_certificate_id,
         payment_trigger_rule_id, eligible, blockers, evaluated_by, evaluated_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.completionCertificateId as string},
        ${record.paymentTriggerRuleId as string}, ${record.eligible as boolean},
        ${sql.json(record.blockers)}, ${record.evaluatedBy as string},
        ${record.evaluatedAt as string}, 1, ${BATCH_B_SCHEMA_VERSION},
        ${record.evaluatedAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 42 — Financial Entitlement
// ---------------------------------------------------------------------------------------

const financialEntitlements = relation('financialEntitlements', 'financial_entitlements', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, payment_eligibility_id, currency,
             gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
             tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status,
             calculated_at, schema_version
      FROM financial_entitlements ORDER BY calculated_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('financialEntitlements', row);
      return validateFromRow('financialEntitlements', {
        id: text('financialEntitlements', row, 'id'),
        workspaceId: text('financialEntitlements', row, 'workspace_id'),
        milestoneId: text('financialEntitlements', row, 'milestone_id'),
        paymentEligibilityId: text('financialEntitlements', row, 'payment_eligibility_id'),
        currency: text('financialEntitlements', row, 'currency'),
        grossEarnedAmountMinor: amount('financialEntitlements', row, 'gross_earned_amount_minor'),
        variationsAmountMinor: amount('financialEntitlements', row, 'variations_amount_minor'),
        retentionAmountMinor: amount('financialEntitlements', row, 'retention_amount_minor'),
        taxAmountMinor: amount('financialEntitlements', row, 'tax_amount_minor'),
        penaltyAmountMinor: amount('financialEntitlements', row, 'penalty_amount_minor'),
        netPayableAmountMinor: amount('financialEntitlements', row, 'net_payable_amount_minor'),
        status: text('financialEntitlements', row, 'status'),
        calculatedAt: instant('financialEntitlements', row, 'calculated_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('financialEntitlements', value);
    await sql`
      INSERT INTO financial_entitlements
        (id, tenant_id, workspace_id, milestone_id, payment_eligibility_id, currency,
         gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
         tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status, calculated_at,
         version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.paymentEligibilityId as string},
        ${record.currency as string}, ${record.grossEarnedAmountMinor as number},
        ${record.variationsAmountMinor as number}, ${record.retentionAmountMinor as number},
        ${record.taxAmountMinor as number}, ${record.penaltyAmountMinor as number},
        ${record.netPayableAmountMinor as number}, ${record.status as string},
        ${record.calculatedAt as string}, 1, ${BATCH_B_SCHEMA_VERSION},
        ${record.calculatedAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('financialEntitlements', value);
    // Confirmation is the only transition. Every calculated amount is immutable, enforced by the
    // governed-transition trigger rather than by omitting the columns here — an UPDATE that did not
    // mention them would still let a direct statement rewrite them.
    const rows = await sql<Row[]>`
      UPDATE financial_entitlements
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('financialEntitlements', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 43 — Invoice & Claim
// ---------------------------------------------------------------------------------------

const invoices = relation('invoices', 'invoices', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, financial_entitlement_id, invoice_number,
             amount_minor, currency, status, submitted_by, created_at, schema_version
      FROM invoices ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('invoices', row);
      return validateFromRow('invoices', {
        id: text('invoices', row, 'id'),
        workspaceId: text('invoices', row, 'workspace_id'),
        milestoneId: text('invoices', row, 'milestone_id'),
        financialEntitlementId: text('invoices', row, 'financial_entitlement_id'),
        invoiceNumber: text('invoices', row, 'invoice_number'),
        amountMinor: amount('invoices', row, 'amount_minor'),
        currency: text('invoices', row, 'currency'),
        status: text('invoices', row, 'status'),
        submittedBy: text('invoices', row, 'submitted_by'),
        createdAt: instant('invoices', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('invoices', value);
    await sql`
      INSERT INTO invoices
        (id, tenant_id, workspace_id, milestone_id, financial_entitlement_id, invoice_number,
         amount_minor, currency, status, submitted_by, created_at, version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.financialEntitlementId as string},
        ${record.invoiceNumber as string}, ${record.amountMinor as number},
        ${record.currency as string}, ${record.status as string},
        ${record.submittedBy as string}, ${record.createdAt as string},
        1, ${BATCH_B_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('invoices', value);
    const rows = await sql<Row[]>`
      UPDATE invoices
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('invoices', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 46 — Financial Approval Authority (threshold)
// ---------------------------------------------------------------------------------------

const approvalThresholds = relation('approvalThresholds', 'approval_thresholds', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, min_amount_minor, max_amount_minor, currency, required_approvals,
             created_at, schema_version
      FROM approval_thresholds ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('approvalThresholds', row);
      return validateFromRow('approvalThresholds', {
        id: text('approvalThresholds', row, 'id'),
        workspaceId: text('approvalThresholds', row, 'workspace_id'),
        minAmountMinor: amount('approvalThresholds', row, 'min_amount_minor'),
        maxAmountMinor: amount('approvalThresholds', row, 'max_amount_minor'),
        currency: text('approvalThresholds', row, 'currency'),
        requiredApprovals: amount('approvalThresholds', row, 'required_approvals'),
        createdAt: instant('approvalThresholds', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('approvalThresholds', value);
    await sql`
      INSERT INTO approval_thresholds
        (id, tenant_id, workspace_id, min_amount_minor, max_amount_minor, currency,
         required_approvals, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.minAmountMinor as number}, ${record.maxAmountMinor as number},
        ${record.currency as string}, ${record.requiredApprovals as number},
        ${record.createdAt as string}, 1, ${BATCH_B_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 45 — Conditional Release Orchestration
// ---------------------------------------------------------------------------------------

const releaseRequests = relation('releaseRequests', 'release_requests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, financial_entitlement_id, invoice_id,
             fund_reservation_id, release_type, requested_amount_minor, currency, status,
             blockers, requested_by, created_at, schema_version
      FROM release_requests ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('releaseRequests', row);
      return validateFromRow('releaseRequests', {
        id: text('releaseRequests', row, 'id'),
        workspaceId: text('releaseRequests', row, 'workspace_id'),
        milestoneId: text('releaseRequests', row, 'milestone_id'),
        financialEntitlementId: text('releaseRequests', row, 'financial_entitlement_id'),
        invoiceId: text('releaseRequests', row, 'invoice_id'),
        fundReservationId: text('releaseRequests', row, 'fund_reservation_id'),
        releaseType: text('releaseRequests', row, 'release_type'),
        requestedAmountMinor: amount('releaseRequests', row, 'requested_amount_minor'),
        currency: text('releaseRequests', row, 'currency'),
        status: text('releaseRequests', row, 'status'),
        blockers: json(row, 'blockers'),
        requestedBy: text('releaseRequests', row, 'requested_by'),
        createdAt: instant('releaseRequests', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('releaseRequests', value);
    await sql`
      INSERT INTO release_requests
        (id, tenant_id, workspace_id, milestone_id, financial_entitlement_id, invoice_id,
         fund_reservation_id, release_type, requested_amount_minor, currency, status, blockers,
         requested_by, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.financialEntitlementId as string},
        ${record.invoiceId as string}, ${record.fundReservationId as string},
        ${record.releaseType as string}, ${record.requestedAmountMinor as number},
        ${record.currency as string}, ${record.status as string},
        ${sql.json(record.blockers)}, ${record.requestedBy as string},
        ${record.createdAt as string}, 1, ${BATCH_B_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('releaseRequests', value);
    // Status and blockers move together: a request becomes BLOCKED *because* of the blockers it
    // then carries, so writing one without the other would record a verdict with no reason.
    const rows = await sql<Row[]>`
      UPDATE release_requests
      SET status = ${record.status as string}, blockers = ${sql.json(record.blockers)},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('releaseRequests', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 46 — Financial Approval Authority (authorization and approvals)
// ---------------------------------------------------------------------------------------

const authorizationDecisions = relation('authorizationDecisions', 'authorization_decisions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, release_request_id, requested_by, amount_minor, currency,
             required_approvals, status, created_at, authorized_at, schema_version
      FROM authorization_decisions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('authorizationDecisions', row);
      return validateFromRow(
        'authorizationDecisions',
        compact({
          id: text('authorizationDecisions', row, 'id'),
          workspaceId: text('authorizationDecisions', row, 'workspace_id'),
          releaseRequestId: text('authorizationDecisions', row, 'release_request_id'),
          requestedBy: text('authorizationDecisions', row, 'requested_by'),
          amountMinor: amount('authorizationDecisions', row, 'amount_minor'),
          currency: text('authorizationDecisions', row, 'currency'),
          requiredApprovals: amount('authorizationDecisions', row, 'required_approvals'),
          status: text('authorizationDecisions', row, 'status'),
          createdAt: instant('authorizationDecisions', row, 'created_at'),
          authorizedAt: optionalInstant('authorizationDecisions', row, 'authorized_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('authorizationDecisions', value);
    await sql`
      INSERT INTO authorization_decisions
        (id, tenant_id, workspace_id, release_request_id, requested_by, amount_minor, currency,
         required_approvals, status, created_at, authorized_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.releaseRequestId as string}, ${record.requestedBy as string},
        ${record.amountMinor as number}, ${record.currency as string},
        ${record.requiredApprovals as number}, ${record.status as string},
        ${record.createdAt as string}, ${(record.authorizedAt as string | undefined) ?? null},
        1, ${BATCH_B_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('authorizationDecisions', value);
    const rows = await sql<Row[]>`
      UPDATE authorization_decisions
      SET status = ${record.status as string},
          authorized_at = ${(record.authorizedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('authorizationDecisions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const financialApprovalDecisions = relation(
  'financialApprovalDecisions',
  'financial_approval_decisions',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, authorization_id, approver_id, decision, rationale, decided_at,
               schema_version
        FROM financial_approval_decisions ORDER BY decided_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('financialApprovalDecisions', row);
        return validateFromRow('financialApprovalDecisions', {
          id: text('financialApprovalDecisions', row, 'id'),
          workspaceId: text('financialApprovalDecisions', row, 'workspace_id'),
          authorizationId: text('financialApprovalDecisions', row, 'authorization_id'),
          approverId: text('financialApprovalDecisions', row, 'approver_id'),
          decision: text('financialApprovalDecisions', row, 'decision'),
          rationale: text('financialApprovalDecisions', row, 'rationale'),
          decidedAt: instant('financialApprovalDecisions', row, 'decided_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('financialApprovalDecisions', value);
      // The segregation trigger fires on this statement and refuses a self-approval. The engine
      // refuses it too; both hold, and the trigger is the one a direct statement cannot evade.
      await sql`
        INSERT INTO financial_approval_decisions
          (id, tenant_id, workspace_id, authorization_id, approver_id, decision, rationale,
           decided_at, version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.authorizationId as string}, ${record.approverId as string},
          ${record.decision as string}, ${record.rationale as string},
          ${record.decidedAt as string}, 1, ${BATCH_B_SCHEMA_VERSION}, ${record.decidedAt as string}
        )
      `;
    },
  },
);

/**
 * The routing table, keyed by the collection name engines pass to `TrustPersistence`.
 *
 * Assembled against the contract registry, and the assembly fails when the two disagree: a
 * collection with a contract and no relation would be a validated aggregate nothing can store, and
 * a relation with no contract would be a write with no schema.
 */
export const BATCH_B_RELATIONS: Readonly<Record<string, BatchBRelation>> = Object.freeze(
  Object.fromEntries(
    [
      paymentEligibilities,
      financialEntitlements,
      invoices,
      approvalThresholds,
      releaseRequests,
      authorizationDecisions,
      financialApprovalDecisions,
    ].map((entry) => {
      const contract = batchBContract(entry.collection);
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

/** Whether Batch B owns a collection. */
export function isBatchBCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_B_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the
 * collection is Batch B's, and a silent undefined would become a lost write.
 */
export function batchBRelation(collection: string): BatchBRelation {
  const found = BATCH_B_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch B aggregate`,
    );
  return found;
}

export const BATCH_B_RELATION_COUNT = Object.keys(BATCH_B_RELATIONS).length;

if (BATCH_B_RELATION_COUNT !== BATCH_B_AGGREGATES.length)
  throw new Error(
    `${BATCH_B_RELATION_COUNT} relational repositories for ${BATCH_B_AGGREGATES.length} ` +
      'Batch B aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
