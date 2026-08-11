import {
  BATCH_C_AGGREGATES,
  BATCH_C_SCHEMA_VERSION,
  batchCContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch C — the seven settlement-and-money-movement aggregates of
 * canonical Engines 44, 47, 48 and 50.
 *
 * ## What this replaces
 *
 * Nothing, for the third time and the same reason: these seven collections are absent from
 * `GOVERNED_DOCUMENTS`, so `PostgresTrustStore` refused them with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. A funding commitment, a payment instruction, a ledger entry,
 * a reconciliation record or a closure certificate could not be written to PostgreSQL at all —
 * Engines 44–50 worked only against `InMemoryTrustStore`. `trust_records` holds zero rows for them,
 * there is nothing to backfill, and routing each collection to its table is the write cutover and
 * the read cutover in one change.
 *
 * ## Where the journal invariant is *not*
 *
 * Deliberately absent from this file: any check that debits equal credits. Balance is a property of
 * a set of postings, and this repository writes one row per call, so a balance check here would
 * either refuse the first leg of every correct posting or be a check that never fires. It belongs
 * where the whole set is visible — the deferred constraint trigger `202608110001` adds, which fires
 * at COMMIT.
 *
 * What this file does contribute to that invariant is the transaction boundary being usable:
 * `TrustPersistence.transaction` already opens a real `sql.begin`, so two `append` calls inside one
 * transaction reach the database as one unit and the deferred trigger sees them together. The
 * balance rule is therefore enforced by the database and *satisfiable* by the store, which is the
 * combination the entry gate required.
 *
 * ## Money
 *
 * Same rules as Batch B, and the same reader. `bigint` arrives from the driver as a string, so every
 * monetary read is a conversion; a value that is not finite or not a *safe* integer is refused
 * rather than rounded. A silently rounded amount on a payment instruction is an instruction to move
 * the wrong sum of money.
 *
 * ## Which invariants live where
 *
 * The repository validates through the canonical schema and lets `202608110001`'s constraints be the
 * authority, because `docs/finance/MONETARY_INVARIANTS.md` requires that an invariant PostgreSQL can
 * enforce must not exist only as an application check:
 *
 *   - amount bounds, the settlement arithmetic, `matched` following from its amounts, and the
 *     closure timestamp following from status are `CHECK`s;
 *   - currency agreement between a posting and its instruction, and between an instruction and its
 *     release request, are tenant-composite foreign keys carrying currency;
 *   - journal balance is the deferred constraint trigger;
 *   - reconciliation and idempotency uniqueness are unique constraints;
 *   - immutability of posted facts and terminal states are triggers.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the
 * driver's escape hatch to DDL, and a generated INSERT would need it.
 */

type Row = Record<string, unknown>;

export type BatchCRelation = {
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
  const contract = batchCContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch C aggregate`,
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
 * A failure here is a data-integrity incident rather than a caller error: a stored row that does not
 * satisfy its own contract, which for a settlement aggregate means an amount a payment path would
 * otherwise act on.
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
  if (version > BATCH_C_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_C_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry amounts, provider references and
  // actor identities.
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
 * A monetary or count column as a JavaScript number.
 *
 * `bigint` arrives as a string, so this is a conversion. A value that does not survive it is a
 * corrupt row, and one beyond `Number.MAX_SAFE_INTEGER` is a row this build cannot represent
 * exactly — both are refused rather than rounded.
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
): BatchCRelation {
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
// Engine 44 — Escrow Funding Assurance
// ---------------------------------------------------------------------------------------

const fundingCommitments = relation('fundingCommitments', 'funding_commitments', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, provider_key, external_custody_reference,
             committed_amount_minor, currency, status, provider_confirmation_reference,
             created_at, confirmed_at, schema_version
      FROM funding_commitments ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('fundingCommitments', row);
      return validateFromRow(
        'fundingCommitments',
        compact({
          id: text('fundingCommitments', row, 'id'),
          workspaceId: text('fundingCommitments', row, 'workspace_id'),
          milestoneId: text('fundingCommitments', row, 'milestone_id'),
          providerKey: text('fundingCommitments', row, 'provider_key'),
          externalCustodyReference: text('fundingCommitments', row, 'external_custody_reference'),
          committedAmountMinor: amount('fundingCommitments', row, 'committed_amount_minor'),
          currency: text('fundingCommitments', row, 'currency'),
          status: text('fundingCommitments', row, 'status'),
          providerConfirmationReference: optionalText(
            'fundingCommitments',
            row,
            'provider_confirmation_reference',
          ),
          createdAt: instant('fundingCommitments', row, 'created_at'),
          confirmedAt: optionalInstant('fundingCommitments', row, 'confirmed_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('fundingCommitments', value);
    await sql`
      INSERT INTO funding_commitments
        (id, tenant_id, workspace_id, milestone_id, provider_key, external_custody_reference,
         committed_amount_minor, currency, status, provider_confirmation_reference,
         created_at, confirmed_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.providerKey as string},
        ${record.externalCustodyReference as string},
        ${record.committedAmountMinor as number}, ${record.currency as string},
        ${record.status as string},
        ${(record.providerConfirmationReference as string | undefined) ?? null},
        ${record.createdAt as string}, ${(record.confirmedAt as string | undefined) ?? null},
        1, ${BATCH_C_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('fundingCommitments', value);
    // Confirmation and cancellation. The committed amount, the provider and the external custody
    // reference are immutable, enforced by the governed-transition trigger rather than by omitting
    // the columns — an UPDATE that did not mention them would still let a direct statement rewrite
    // them.
    const rows = await sql<Row[]>`
      UPDATE funding_commitments
      SET status = ${record.status as string},
          provider_confirmation_reference = ${
            (record.providerConfirmationReference as string | undefined) ?? null
          },
          confirmed_at = ${(record.confirmedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('fundingCommitments', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const fundReservations = relation('fundReservations', 'fund_reservations', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, funding_commitment_id, invoice_id, reserved_amount_minor,
             status, created_at, schema_version
      FROM fund_reservations ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('fundReservations', row);
      return validateFromRow('fundReservations', {
        id: text('fundReservations', row, 'id'),
        workspaceId: text('fundReservations', row, 'workspace_id'),
        fundingCommitmentId: text('fundReservations', row, 'funding_commitment_id'),
        invoiceId: text('fundReservations', row, 'invoice_id'),
        reservedAmountMinor: amount('fundReservations', row, 'reserved_amount_minor'),
        status: text('fundReservations', row, 'status'),
        createdAt: instant('fundReservations', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('fundReservations', value);
    await sql`
      INSERT INTO fund_reservations
        (id, tenant_id, workspace_id, funding_commitment_id, invoice_id, reserved_amount_minor,
         status, created_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.fundingCommitmentId as string}, ${record.invoiceId as string},
        ${record.reservedAmountMinor as number}, ${record.status as string},
        ${record.createdAt as string}, 1, ${BATCH_C_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('fundReservations', value);
    const rows = await sql<Row[]>`
      UPDATE fund_reservations
      SET status = ${record.status as string}, version = version + 1, updated_at = now()
      WHERE id = ${requireId('fundReservations', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 47 — Payment Execution
// ---------------------------------------------------------------------------------------

const paymentInstructions = relation('paymentInstructions', 'payment_instructions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, release_request_id, provider_key, idempotency_key,
             beneficiary_reference, amount_minor, currency, status, provider_reference,
             attempts, created_at, submitted_at, settled_at, schema_version
      FROM payment_instructions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('paymentInstructions', row);
      return validateFromRow(
        'paymentInstructions',
        compact({
          id: text('paymentInstructions', row, 'id'),
          workspaceId: text('paymentInstructions', row, 'workspace_id'),
          releaseRequestId: text('paymentInstructions', row, 'release_request_id'),
          providerKey: text('paymentInstructions', row, 'provider_key'),
          idempotencyKey: text('paymentInstructions', row, 'idempotency_key'),
          beneficiaryReference: text('paymentInstructions', row, 'beneficiary_reference'),
          amountMinor: amount('paymentInstructions', row, 'amount_minor'),
          currency: text('paymentInstructions', row, 'currency'),
          status: text('paymentInstructions', row, 'status'),
          providerReference: optionalText('paymentInstructions', row, 'provider_reference'),
          attempts: amount('paymentInstructions', row, 'attempts'),
          createdAt: instant('paymentInstructions', row, 'created_at'),
          submittedAt: optionalInstant('paymentInstructions', row, 'submitted_at'),
          settledAt: optionalInstant('paymentInstructions', row, 'settled_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('paymentInstructions', value);
    await sql`
      INSERT INTO payment_instructions
        (id, tenant_id, workspace_id, release_request_id, provider_key, idempotency_key,
         beneficiary_reference, amount_minor, currency, status, provider_reference, attempts,
         created_at, submitted_at, settled_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.releaseRequestId as string}, ${record.providerKey as string},
        ${record.idempotencyKey as string}, ${record.beneficiaryReference as string},
        ${record.amountMinor as number}, ${record.currency as string}, ${record.status as string},
        ${(record.providerReference as string | undefined) ?? null}, ${record.attempts as number},
        ${record.createdAt as string}, ${(record.submittedAt as string | undefined) ?? null},
        ${(record.settledAt as string | undefined) ?? null}, 1, ${BATCH_C_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('paymentInstructions', value);
    // Submission, settlement, failure and reversal, plus the attempt counter. FAILED is not
    // terminal — `PaymentExecutionEngine.submit` accepts DRAFT *or* FAILED, so a rejected payment is
    // retryable and this is the statement that retries it.
    const rows = await sql<Row[]>`
      UPDATE payment_instructions
      SET status = ${record.status as string},
          provider_reference = ${(record.providerReference as string | undefined) ?? null},
          attempts = ${record.attempts as number},
          submitted_at = ${(record.submittedAt as string | undefined) ?? null},
          settled_at = ${(record.settledAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('paymentInstructions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 48 — Reconciliation & Financial Ledger
// ---------------------------------------------------------------------------------------

// No `update`. MONETARY_INVARIANTS: posted ledger entries are immutable, and a correction is a
// compensating posting that must itself balance.
const ledgerEntries = relation('ledgerEntries', 'ledger_entries', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, payment_instruction_id, entry_type, amount_minor, currency,
             description, recorded_at, schema_version
      FROM ledger_entries ORDER BY recorded_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('ledgerEntries', row);
      return validateFromRow('ledgerEntries', {
        id: text('ledgerEntries', row, 'id'),
        workspaceId: text('ledgerEntries', row, 'workspace_id'),
        paymentInstructionId: text('ledgerEntries', row, 'payment_instruction_id'),
        entryType: text('ledgerEntries', row, 'entry_type'),
        amountMinor: amount('ledgerEntries', row, 'amount_minor'),
        currency: text('ledgerEntries', row, 'currency'),
        description: text('ledgerEntries', row, 'description'),
        recordedAt: instant('ledgerEntries', row, 'recorded_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('ledgerEntries', value);
    await sql`
      INSERT INTO ledger_entries
        (id, tenant_id, workspace_id, payment_instruction_id, entry_type, amount_minor, currency,
         description, recorded_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.paymentInstructionId as string}, ${record.entryType as string},
        ${record.amountMinor as number}, ${record.currency as string},
        ${record.description as string}, ${record.recordedAt as string}, 1,
        ${BATCH_C_SCHEMA_VERSION}, ${record.recordedAt as string}
      )
    `;
  },
});

// No `update`. A reconciliation outcome must be reproducible from the record that produced it, which
// an edited record is not.
const reconciliationRecords = relation('reconciliationRecords', 'reconciliation_records', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, payment_instruction_id, provider_statement_reference,
             provider_reported_amount_minor, recorded_amount_minor, matched, exception_reason,
             reconciled_at, schema_version
      FROM reconciliation_records ORDER BY reconciled_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('reconciliationRecords', row);
      return validateFromRow(
        'reconciliationRecords',
        compact({
          id: text('reconciliationRecords', row, 'id'),
          workspaceId: text('reconciliationRecords', row, 'workspace_id'),
          paymentInstructionId: text('reconciliationRecords', row, 'payment_instruction_id'),
          providerStatementReference: text(
            'reconciliationRecords',
            row,
            'provider_statement_reference',
          ),
          providerReportedAmountMinor: amount(
            'reconciliationRecords',
            row,
            'provider_reported_amount_minor',
          ),
          recordedAmountMinor: amount('reconciliationRecords', row, 'recorded_amount_minor'),
          matched: boolean('reconciliationRecords', row, 'matched'),
          exceptionReason: optionalText('reconciliationRecords', row, 'exception_reason'),
          reconciledAt: instant('reconciliationRecords', row, 'reconciled_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('reconciliationRecords', value);
    await sql`
      INSERT INTO reconciliation_records
        (id, tenant_id, workspace_id, payment_instruction_id, provider_statement_reference,
         provider_reported_amount_minor, recorded_amount_minor, matched, exception_reason,
         reconciled_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.paymentInstructionId as string},
        ${record.providerStatementReference as string},
        ${record.providerReportedAmountMinor as number}, ${record.recordedAmountMinor as number},
        ${record.matched as boolean}, ${(record.exceptionReason as string | undefined) ?? null},
        ${record.reconciledAt as string}, 1, ${BATCH_C_SCHEMA_VERSION},
        ${record.reconciledAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 50 — Final Settlement & Financial Closure
// ---------------------------------------------------------------------------------------

const finalSettlementAccounts = relation('finalSettlementAccounts', 'final_settlement_accounts', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, milestone_id, total_entitlement_amount_minor,
             total_settled_amount_minor, outstanding_amount_minor, currency, status,
             created_at, closed_at, schema_version
      FROM final_settlement_accounts ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('finalSettlementAccounts', row);
      return validateFromRow(
        'finalSettlementAccounts',
        compact({
          id: text('finalSettlementAccounts', row, 'id'),
          workspaceId: text('finalSettlementAccounts', row, 'workspace_id'),
          milestoneId: text('finalSettlementAccounts', row, 'milestone_id'),
          totalEntitlementAmountMinor: amount(
            'finalSettlementAccounts',
            row,
            'total_entitlement_amount_minor',
          ),
          totalSettledAmountMinor: amount(
            'finalSettlementAccounts',
            row,
            'total_settled_amount_minor',
          ),
          outstandingAmountMinor: amount('finalSettlementAccounts', row, 'outstanding_amount_minor'),
          currency: text('finalSettlementAccounts', row, 'currency'),
          status: text('finalSettlementAccounts', row, 'status'),
          createdAt: instant('finalSettlementAccounts', row, 'created_at'),
          closedAt: optionalInstant('finalSettlementAccounts', row, 'closed_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('finalSettlementAccounts', value);
    await sql`
      INSERT INTO final_settlement_accounts
        (id, tenant_id, workspace_id, milestone_id, total_entitlement_amount_minor,
         total_settled_amount_minor, outstanding_amount_minor, currency, status,
         created_at, closed_at, version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.milestoneId as string}, ${record.totalEntitlementAmountMinor as number},
        ${record.totalSettledAmountMinor as number}, ${record.outstandingAmountMinor as number},
        ${record.currency as string}, ${record.status as string}, ${record.createdAt as string},
        ${(record.closedAt as string | undefined) ?? null}, 1, ${BATCH_C_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  async update(sql, value) {
    const record = validateForWrite('finalSettlementAccounts', value);
    // Closure, and incremental settlement. The entitlement total and the currency are immutable;
    // settled and outstanding move together, and the `CHECK` requires them to stay consistent.
    const rows = await sql<Row[]>`
      UPDATE final_settlement_accounts
      SET total_settled_amount_minor = ${record.totalSettledAmountMinor as number},
          outstanding_amount_minor = ${record.outstandingAmountMinor as number},
          status = ${record.status as string},
          closed_at = ${(record.closedAt as string | undefined) ?? null},
          version = version + 1, updated_at = now()
      WHERE id = ${requireId('finalSettlementAccounts', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

const financialClosureCertificates = relation(
  'financialClosureCertificates',
  'financial_closure_certificates',
  {
    async list(sql) {
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, milestone_id, final_settlement_account_id, canonical_hash,
               status, issued_by, issued_at, schema_version
        FROM financial_closure_certificates ORDER BY issued_at ASC, id ASC
      `;
      return rows.map((row) => {
        requireSupportedSchemaVersion('financialClosureCertificates', row);
        return validateFromRow('financialClosureCertificates', {
          id: text('financialClosureCertificates', row, 'id'),
          workspaceId: text('financialClosureCertificates', row, 'workspace_id'),
          milestoneId: text('financialClosureCertificates', row, 'milestone_id'),
          finalSettlementAccountId: text(
            'financialClosureCertificates',
            row,
            'final_settlement_account_id',
          ),
          canonicalHash: text('financialClosureCertificates', row, 'canonical_hash'),
          status: text('financialClosureCertificates', row, 'status'),
          issuedBy: text('financialClosureCertificates', row, 'issued_by'),
          issuedAt: instant('financialClosureCertificates', row, 'issued_at'),
        });
      });
    },
    async insert(sql, value, tenantId) {
      const record = validateForWrite('financialClosureCertificates', value);
      await sql`
        INSERT INTO financial_closure_certificates
          (id, tenant_id, workspace_id, milestone_id, final_settlement_account_id, canonical_hash,
           status, issued_by, issued_at, version, schema_version, updated_at)
        VALUES (
          ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
          ${record.milestoneId as string}, ${record.finalSettlementAccountId as string},
          ${record.canonicalHash as string}, ${record.status as string},
          ${record.issuedBy as string}, ${record.issuedAt as string}, 1,
          ${BATCH_C_SCHEMA_VERSION}, ${record.issuedAt as string}
        )
      `;
    },
    async update(sql, value) {
      const record = validateForWrite('financialClosureCertificates', value);
      // Revocation is the only transition. The canonical hash is immutable, which is what makes the
      // certificate evidence rather than an assertion.
      const rows = await sql<Row[]>`
        UPDATE financial_closure_certificates
        SET status = ${record.status as string}, version = version + 1, updated_at = now()
        WHERE id = ${requireId('financialClosureCertificates', record)}
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
 * Every Batch C collection, checked against the contract registry at module load.
 *
 * The cross-check is the point: a repository whose table disagrees with its schema's declared table
 * would write correct-looking rows to the wrong owner, and the failure would surface as absence.
 */
export const BATCH_C_RELATIONS: Readonly<Record<string, BatchCRelation>> = Object.freeze(
  Object.fromEntries(
    [
      fundingCommitments,
      fundReservations,
      paymentInstructions,
      ledgerEntries,
      reconciliationRecords,
      finalSettlementAccounts,
      financialClosureCertificates,
    ].map((entry) => {
      const contract = batchCContract(entry.collection);
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

/** Whether Batch C owns a collection. */
export function isBatchCCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_C_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the
 * collection is Batch C's, and a silent undefined would become a lost write.
 */
export function batchCRelation(collection: string): BatchCRelation {
  const found = BATCH_C_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch C aggregate`,
    );
  return found;
}

export const BATCH_C_RELATION_COUNT = Object.keys(BATCH_C_RELATIONS).length;

if (BATCH_C_RELATION_COUNT !== BATCH_C_AGGREGATES.length)
  throw new Error(
    `${BATCH_C_RELATION_COUNT} relational repositories for ${BATCH_C_AGGREGATES.length} ` +
      'Batch C aggregates; an aggregate with a schema and no repository cannot be stored.',
  );
