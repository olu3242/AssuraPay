import { z } from 'zod';
import {
  approvalCount,
  currencyCode,
  identifier,
  instant,
  minorUnits,
  positiveMinorUnits,
  requiredText,
  signedMinorUnits,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch B — the seven entitlement-and-claim aggregates of
 * canonical Engines 41–43 and 45–46.
 *
 * This is the first batch that carries money, so `docs/finance/MONETARY_INVARIANTS.md` governs it
 * and the representation rules are load-bearing rather than descriptive:
 *
 *   - every amount is an integer in minor units, never a fraction and never a float;
 *   - every amount is accompanied by a currency from the governed set, and the two validate
 *     together, because a row cannot hold one without the other;
 *   - base amounts — gross entitlement, invoice, requested release — are strictly positive;
 *   - deductions are non-negative, so a negative retention cannot inflate a net payable;
 *   - the only signed field is a *variation*, which is a delta rather than a base amount.
 *
 * Every rule here is also a database constraint, added by `202608100002`. The pairing is deliberate
 * and neither half is redundant: `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` is explicit that Zod
 * validation does not replace a database constraint — a schema that runs in one process cannot
 * constrain a console session — and that database rows do not define domain semantics.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine
 * won and the disagreement is recorded: `financial_entitlements` left retention, tax and penalty
 * unconstrained while `FinancialEntitlementEngine.calculate` has always refused a negative one, so
 * the schema and the new `CHECK` follow the engine.
 */

// Engine 41 — Payment Eligibility

export const paymentEligibilitySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    completionCertificateId: identifier,
    paymentTriggerRuleId: identifier,
    eligible: z.boolean(),
    // Machine-readable reason codes — `CERTIFICATE_NOT_CERTIFIED`, `TRIGGER:<code>`. Never empty
    // strings: a blocker nobody can name is a blocker nobody can clear.
    blockers: z.array(requiredText),
    evaluatedBy: identifier,
    evaluatedAt: instant,
  })
  .strict();

// Engine 42 — Financial Entitlement

export const financialEntitlementSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    paymentEligibilityId: identifier,
    currency: currencyCode,
    // Strictly positive: `CHECK (gross_earned_amount_minor > 0)`. An entitlement to nothing is not
    // an entitlement.
    grossEarnedAmountMinor: positiveMinorUnits,
    // The one signed field in the batch. A variation may reduce the entitlement.
    variationsAmountMinor: signedMinorUnits,
    // Deductions. Non-negative, or a "deduction" would add to the net payable.
    retentionAmountMinor: minorUnits,
    taxAmountMinor: minorUnits,
    penaltyAmountMinor: minorUnits,
    // Non-negative, and constrained by the database to equal gross + variations − deductions.
    netPayableAmountMinor: minorUnits,
    status: z.enum(['DRAFT', 'CONFIRMED']),
    calculatedAt: instant,
  })
  .strict()
  // The arithmetic, checked here as well as by `financial_entitlements_net_follows_from_parts`.
  // Both, because they catch different callers: this one refuses a record the application built
  // wrong, the constraint refuses a row a statement wrote directly.
  .refine(
    (entitlement) =>
      entitlement.netPayableAmountMinor ===
      entitlement.grossEarnedAmountMinor +
        entitlement.variationsAmountMinor -
        entitlement.retentionAmountMinor -
        entitlement.taxAmountMinor -
        entitlement.penaltyAmountMinor,
    { message: 'net payable does not follow from gross, variations and deductions' },
  );

// Engine 43 — Invoice & Claim

export const invoiceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    financialEntitlementId: identifier,
    invoiceNumber: requiredText,
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum(['SUBMITTED', 'MATCHED', 'APPROVED', 'REJECTED']),
    submittedBy: identifier,
    createdAt: instant,
  })
  .strict();

// Engine 45 — Conditional Release Orchestration

export const releaseRequestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    financialEntitlementId: identifier,
    invoiceId: identifier,
    fundReservationId: identifier,
    releaseType: z.enum(['FULL', 'PARTIAL', 'STAGED']),
    requestedAmountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum(['DRAFT', 'CONDITIONS_MET', 'BLOCKED', 'CANCELLED']),
    blockers: z.array(requiredText),
    requestedBy: identifier,
    createdAt: instant,
  })
  .strict();

// Engine 46 — Financial Approval Authority

export const approvalThresholdSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    minAmountMinor: minorUnits,
    maxAmountMinor: positiveMinorUnits,
    currency: currencyCode,
    requiredApprovals: approvalCount,
    createdAt: instant,
  })
  .strict()
  // `CHECK (max_amount_minor > min_amount_minor)`. A band whose ceiling is not above its floor
  // matches nothing, so a threshold defined that way silently approves at no level.
  .refine((threshold) => threshold.maxAmountMinor > threshold.minAmountMinor, {
    message: 'threshold ceiling must exceed its floor',
  });

export const authorizationDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    releaseRequestId: identifier,
    requestedBy: identifier,
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    requiredApprovals: approvalCount,
    status: z.enum(['PENDING', 'AUTHORIZED', 'REJECTED']),
    createdAt: instant,
    authorizedAt: instant.optional(),
  })
  .strict();

export const financialApprovalDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    authorizationId: identifier,
    approverId: identifier,
    decision: z.enum(['APPROVE', 'REJECT']),
    // Required content. An approval releasing money with a blank rationale is an unexplained
    // release, and the engine refuses it.
    rationale: requiredText,
    decidedAt: instant,
  })
  .strict();

/** The schema version every Batch B table is written at by this capability. */
export const BATCH_B_SCHEMA_VERSION = 1;

/**
 * One aggregate's persistence contract. Same shape as Batch A's, deliberately: a second registry
 * shape would mean two ways to describe one thing.
 */
export type BatchBAggregateContract = {
  readonly collection: string;
  readonly table: string;
  /** Canonical engine id from `docs/ENGINE_CATALOG.md`. */
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/**
 * The registry, in dependency order.
 *
 * Load-bearing, because the tenant-composite foreign keys `202608100002` adds make it so: a
 * financial entitlement references a payment eligibility, an invoice references an entitlement, a
 * release request references both plus a fund reservation, an authorization references a release
 * request, and an approval references an authorization.
 *
 * `fundReservations` and `fundingCommitments` are absent on purpose. Their tables are in Batch B's
 * foreign-key closure and were converged by the same migration — the closure could not be converted
 * in parts — but they are Batch C aggregates, they have no schema or repository here, and nothing
 * routes to them yet. Converging a table is not activating it.
 */
export const BATCH_B_AGGREGATES: readonly BatchBAggregateContract[] = Object.freeze([
  { collection: 'paymentEligibilities', table: 'payment_eligibilities', engine: '41', schema: paymentEligibilitySchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'financialEntitlements', table: 'financial_entitlements', engine: '42', schema: financialEntitlementSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'invoices', table: 'invoices', engine: '43', schema: invoiceSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'approvalThresholds', table: 'approval_thresholds', engine: '46', schema: approvalThresholdSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'releaseRequests', table: 'release_requests', engine: '45', schema: releaseRequestSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'authorizationDecisions', table: 'authorization_decisions', engine: '46', schema: authorizationDecisionSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
  { collection: 'financialApprovalDecisions', table: 'financial_approval_decisions', engine: '46', schema: financialApprovalDecisionSchema, schemaVersion: BATCH_B_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_B_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_B_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_B_TABLES: readonly string[] = Object.freeze(
  BATCH_B_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * Tables converged by `202608100002` but *not* activated by it.
 *
 * Batch C aggregates that Batch B's foreign-key closure forced into the same conversion. Named here
 * so the distinction is executable rather than a comment: a test can assert that no repository
 * routes to them and no readiness check requires them, which is what makes "converged, not
 * activated" a checkable claim.
 */
export const BATCH_B_CONVERGED_NOT_ACTIVATED: readonly string[] = Object.freeze([
  'fund_reservations',
  'funding_commitments',
]);

/** The contract for a collection, or `undefined` when Batch B does not own it. */
export function batchBContract(collection: string): BatchBAggregateContract | undefined {
  return BATCH_B_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}
