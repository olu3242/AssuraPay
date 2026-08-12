import { z } from 'zod';
import {
  currencyCode,
  identifier,
  instant,
  minorUnits,
  positiveMinorUnits,
  requiredText,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch C — the seven settlement-and-money-movement
 * aggregates of canonical Engines 44, 47, 48 and 50.
 *
 * Batch B was the first batch to carry money; Batch C is the batch where money *moves*. Everything
 * `docs/finance/MONETARY_INVARIANTS.md` requires of representation still applies — integer minor
 * units, a governed currency travelling with every amount, positive base amounts, non-negative
 * derived ones — and two rules become live here that had nowhere to apply before:
 *
 *   - **A journal balances per currency.** No single-record schema can express that: it is a
 *     property of a set of postings, so it is enforced by the deferred constraint trigger
 *     `202608110001` adds, and proved against a live database. A `LedgerEntry` schema that
 *     asserted balance would be asserting it in the one place it cannot hold.
 *   - **Posted facts are immutable, and a correction is a compensating record.** So `ledgerEntries`
 *     and `reconciliationRecords` are append-only in both the store and the database, while the
 *     three aggregates their engines genuinely transition are not.
 *
 * Two gaps that Batch C recorded rather than papered over are **closed** by `202608110003`, which
 * changed the two domain types Batch C would not:
 *
 *   - `ReconciliationRecord.currency` now exists, taken from the instruction it reconciles, so both
 *     amounts have a unit and the composite key carries currency the way `ledger_entries` does.
 *   - `PaymentInstruction.payloadDigest` now exists, so reusing an idempotency key with a different
 *     semantic payload is refused rather than silently accepted as the original — which is what
 *     MONETARY_INVARIANTS requires and what uniqueness alone could never detect.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine
 * won and the disagreement is recorded: `matched` on a reconciliation record is not an independent
 * assertion but a consequence of the two amounts, which is how `ReconciliationLedgerEngine`
 * computes it, so both the schema and the new `CHECK` derive it rather than accepting it.
 */

// Engine 44 — Escrow Funding Assurance

export const fundingCommitmentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    providerKey: identifier,
    // The licensed provider's own custody record. Non-custody depends on this being a reference to
    // somebody else's ledger rather than a balance of ours, so it must be present and non-blank.
    externalCustodyReference: requiredText,
    committedAmountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum(['PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED']),
    providerConfirmationReference: requiredText.optional(),
    createdAt: instant,
    confirmedAt: instant.optional(),
  })
  .strict();

export const fundReservationSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    fundingCommitmentId: identifier,
    invoiceId: identifier,
    reservedAmountMinor: positiveMinorUnits,
    status: z.enum(['RESERVED', 'RELEASED', 'CANCELLED']),
    createdAt: instant,
  })
  .strict();

// Engine 47 — Payment Execution

export const paymentInstructionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    releaseRequestId: identifier,
    providerKey: identifier,
    idempotencyKey: requiredText,
    // The digest of the payload this key was first used with, so a retry that drifted is refused
    // rather than silently accepted as the original.
    payloadDigest: requiredText,
    beneficiaryReference: requiredText,
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum(['DRAFT', 'SUBMITTED', 'SETTLED', 'FAILED', 'REVERSED']),
    providerReference: requiredText.optional(),
    // Non-negative rather than positive: a DRAFT instruction has never been attempted. A counter
    // that can go backwards is a counter that can hide a retry.
    attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    createdAt: instant,
    submittedAt: instant.optional(),
    settledAt: instant.optional(),
  })
  .strict();

// Engine 48 — Reconciliation & Financial Ledger

export const ledgerEntrySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    paymentInstructionId: identifier,
    entryType: z.enum(['DEBIT', 'CREDIT']),
    // Strictly positive. A refund is a compensating posting on the other side, never a negated
    // original — MONETARY_INVARIANTS names that a prohibited shortcut, and a signed amount column
    // would make it expressible.
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    description: requiredText,
    recordedAt: instant,
  })
  .strict();

export const reconciliationRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    paymentInstructionId: identifier,
    providerStatementReference: requiredText,
    // Taken from the instruction, so both amounts have a unit and the composite key can carry it.
    currency: currencyCode,
    providerReportedAmountMinor: minorUnits,
    recordedAmountMinor: minorUnits,
    matched: z.boolean(),
    exceptionReason: requiredText.optional(),
    reconciledAt: instant,
  })
  .strict()
  // `matched` is a consequence, not a claim. Accepting it independently would let a record assert a
  // match its own amounts contradict, and reconciliation outcomes must be reproducible from the
  // persisted record.
  .refine((value) => value.matched === (value.providerReportedAmountMinor === value.recordedAmountMinor), {
    message: 'matched must follow from the reported and recorded amounts',
    path: ['matched'],
  })
  // An unmatched record with no reason is an exception nobody can act on.
  .refine((value) => value.matched || value.exceptionReason !== undefined, {
    message: 'an unmatched reconciliation record requires an exception reason',
    path: ['exceptionReason'],
  });

// Engine 50 — Final Settlement & Financial Closure

export const finalSettlementAccountSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    totalEntitlementAmountMinor: positiveMinorUnits,
    totalSettledAmountMinor: minorUnits,
    outstandingAmountMinor: minorUnits,
    currency: currencyCode,
    status: z.enum(['DRAFT', 'CLOSED']),
    createdAt: instant,
    closedAt: instant.optional(),
  })
  .strict()
  // The arithmetic, in the schema as well as the column. Three independent bounds permitted an
  // account claiming to owe more than it was ever entitled to.
  .refine(
    (value) =>
      value.outstandingAmountMinor ===
      value.totalEntitlementAmountMinor - value.totalSettledAmountMinor,
    {
      message: 'outstanding must be the entitlement less what has been settled',
      path: ['outstandingAmountMinor'],
    },
  )
  // A closure with no time it happened is a closure that cannot be placed in the audit chain, and
  // the closure certificate cites this account as its evidence.
  .refine((value) => (value.status === 'CLOSED') === (value.closedAt !== undefined), {
    message: 'a closed account records when it closed, and an open one does not',
    path: ['closedAt'],
  });

export const financialClosureCertificateSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    finalSettlementAccountId: identifier,
    canonicalHash: requiredText,
    status: z.enum(['ISSUED', 'REVOKED']),
    issuedBy: identifier,
    issuedAt: instant,
  })
  .strict();

/**
 * The schema version stored beside every Batch C row.
 *
 * One for every aggregate in the batch, because they were introduced together. A row declaring a
 * version this build cannot parse is refused rather than read optimistically.
 */
export const BATCH_C_SCHEMA_VERSION = 1;

export type BatchCAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/**
 * The registry, in dependency order.
 *
 * Load-bearing, because the tenant-composite foreign keys make it so: a fund reservation references
 * a funding commitment and an invoice, a payment instruction references a release request, a ledger
 * entry and a reconciliation record reference an instruction, and a closure certificate references
 * a final settlement account.
 *
 * `fundingCommitments` and `fundReservations` appear here for the first time. Their *tables* were
 * converged by `202608100002`, which could not convert Batch B's closure in parts, but they had no
 * schema, no repository and no route until now. This is the activation the Batch B document said
 * Batch C would perform.
 */
export const BATCH_C_AGGREGATES: readonly BatchCAggregateContract[] = Object.freeze([
  { collection: 'fundingCommitments', table: 'funding_commitments', engine: '44', schema: fundingCommitmentSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'fundReservations', table: 'fund_reservations', engine: '44', schema: fundReservationSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'paymentInstructions', table: 'payment_instructions', engine: '47', schema: paymentInstructionSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'ledgerEntries', table: 'ledger_entries', engine: '48', schema: ledgerEntrySchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'reconciliationRecords', table: 'reconciliation_records', engine: '48', schema: reconciliationRecordSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'finalSettlementAccounts', table: 'final_settlement_accounts', engine: '50', schema: finalSettlementAccountSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
  { collection: 'financialClosureCertificates', table: 'financial_closure_certificates', engine: '50', schema: financialClosureCertificateSchema, schemaVersion: BATCH_C_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_C_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_C_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_C_TABLES: readonly string[] = Object.freeze(
  BATCH_C_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * `ledgerEntries` because MONETARY_INVARIANTS says posted entries are immutable and a correction is
 * a compensating posting. `reconciliationRecords` because a reconciliation outcome must be
 * reproducible from the record that produced it, which an edited record is not.
 */
export const BATCH_C_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'ledgerEntries',
  'reconciliationRecords',
]);

/** The contract for a collection, or `undefined` when Batch C does not own it. */
export function batchCContract(collection: string): BatchCAggregateContract | undefined {
  return BATCH_C_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}
