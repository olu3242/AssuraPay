import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ws(context: RequestContext) {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
}
async function get<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = (await store
    .list<T>(collection))
    .find((x) => x.id === id && x.workspaceId === ws(context));
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
async function emit(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  await store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    aggregateType,
    aggregateId,
    eventType,
    eventVersion: 1,
    payload,
    correlationId: context.correlationId,
  });
}
function requireIntegerMinorUnits(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field}_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS`);
}

// Engine 41 — Payment Eligibility

export type PaymentEligibility = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  completionCertificateId: string;
  paymentTriggerRuleId: string;
  eligible: boolean;
  blockers: string[];
  evaluatedBy: string;
  evaluatedAt: string;
};

export class PaymentEligibilityEngine {
  constructor(private readonly store: TrustPersistence) {}

  async assess(
    context: RequestContext,
    input: {
      milestoneId: string;
      completionCertificateId: string;
      certificateStatus: 'CERTIFIED' | 'REVOKED';
      paymentTriggerRuleId: string;
      triggerEligible: boolean;
      triggerBlockers: string[];
    },
  ) {
    const blockers: string[] = [];
    if (input.certificateStatus !== 'CERTIFIED') blockers.push('CERTIFICATE_NOT_CERTIFIED');
    if (!input.triggerEligible) blockers.push(...input.triggerBlockers.map((b) => `TRIGGER:${b}`));
    const assessment: PaymentEligibility = {
      id: randomUUID(),
      workspaceId: ws(context),
      milestoneId: input.milestoneId,
      completionCertificateId: input.completionCertificateId,
      paymentTriggerRuleId: input.paymentTriggerRuleId,
      eligible: blockers.length === 0,
      blockers,
      evaluatedBy: context.actorUserId,
      evaluatedAt: now(),
    };
    await this.store.append('paymentEligibilities', assessment);
    await emit(this.store, context, 'PaymentEligibilityAssessed', 'PaymentEligibility', assessment.id, {
      milestoneId: assessment.milestoneId,
      eligible: assessment.eligible,
    });
    return assessment;
  }

  async latest(context: RequestContext, milestoneId: string) {
    const workspaceId = ws(context);
    const records = (await this.store
      .list<PaymentEligibility>('paymentEligibilities'))
      .filter((x) => x.workspaceId === workspaceId && x.milestoneId === milestoneId);
    return records[records.length - 1];
  }
}

// Engine 42 — Financial Entitlement

export type FinancialEntitlement = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  paymentEligibilityId: string;
  currency: string;
  grossEarnedAmountMinor: number;
  variationsAmountMinor: number;
  retentionAmountMinor: number;
  taxAmountMinor: number;
  penaltyAmountMinor: number;
  netPayableAmountMinor: number;
  status: 'DRAFT' | 'CONFIRMED';
  calculatedAt: string;
};

export class FinancialEntitlementEngine {
  constructor(private readonly store: TrustPersistence) {}

  async calculate(
    context: RequestContext,
    input: {
      milestoneId: string;
      paymentEligibilityId: string;
      currency: string;
      grossEarnedAmountMinor: number;
      variationsAmountMinor: number;
      retentionAmountMinor: number;
      taxAmountMinor: number;
      penaltyAmountMinor: number;
    },
  ) {
    const eligibility = await get<PaymentEligibility>(this.store, 'paymentEligibilities', context, input.paymentEligibilityId);
    if (!eligibility.eligible) throw new Error('PAYMENT_NOT_ELIGIBLE');
    if (!Number.isInteger(input.grossEarnedAmountMinor) || input.grossEarnedAmountMinor <= 0)
      throw new Error('GROSS_EARNED_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    if (!Number.isInteger(input.variationsAmountMinor)) throw new Error('VARIATIONS_AMOUNT_MUST_BE_INTEGER_MINOR_UNITS');
    for (const [field, value] of Object.entries({
      retentionAmountMinor: input.retentionAmountMinor,
      taxAmountMinor: input.taxAmountMinor,
      penaltyAmountMinor: input.penaltyAmountMinor,
    }))
      if (!Number.isInteger(value) || value < 0)
        throw new Error(`${field.toUpperCase()}_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS`);
    const netPayableAmountMinor =
      input.grossEarnedAmountMinor +
      input.variationsAmountMinor -
      input.retentionAmountMinor -
      input.taxAmountMinor -
      input.penaltyAmountMinor;
    if (netPayableAmountMinor < 0) throw new Error('NEGATIVE_NET_PAYABLE');
    const entitlement: FinancialEntitlement = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      netPayableAmountMinor,
      status: 'DRAFT',
      calculatedAt: now(),
    };
    await this.store.append('financialEntitlements', entitlement);
    await emit(this.store, context, 'FinancialEntitlementCalculated', 'FinancialEntitlement', entitlement.id, {
      milestoneId: entitlement.milestoneId,
      netPayableAmountMinor: entitlement.netPayableAmountMinor,
    });
    return entitlement;
  }

  async confirm(context: RequestContext, id: string) {
    const entitlement = await get<FinancialEntitlement>(this.store, 'financialEntitlements', context, id);
    if (entitlement.status !== 'DRAFT') throw new Error('FINANCIAL_ENTITLEMENT_IMMUTABLE');
    const confirmed: FinancialEntitlement = { ...entitlement, status: 'CONFIRMED' };
    await this.store.replace('financialEntitlements', confirmed);
    await emit(this.store, context, 'FinancialEntitlementConfirmed', 'FinancialEntitlement', id, {
      netPayableAmountMinor: entitlement.netPayableAmountMinor,
      currency: entitlement.currency,
    });
    return confirmed;
  }
}

// Engine 43 — Invoice & Claim Management

export type Invoice = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  financialEntitlementId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  status: 'SUBMITTED' | 'MATCHED' | 'APPROVED' | 'REJECTED';
  submittedBy: string;
  createdAt: string;
};

export class InvoiceClaimEngine {
  constructor(private readonly store: TrustPersistence) {}

  async submit(
    context: RequestContext,
    input: {
      milestoneId: string;
      financialEntitlementId: string;
      invoiceNumber: string;
      amountMinor: number;
      currency: string;
    },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const entitlement = await get<FinancialEntitlement>(
      this.store,
      'financialEntitlements',
      context,
      input.financialEntitlementId,
    );
    if (entitlement.status !== 'CONFIRMED') throw new Error('ENTITLEMENT_NOT_CONFIRMED');
    const workspaceId = ws(context);
    if (
      (await this.store
        .list<Invoice>('invoices'))
        .some((x) => x.workspaceId === workspaceId && x.invoiceNumber === input.invoiceNumber && x.status !== 'REJECTED')
    )
      throw new Error('DUPLICATE_INVOICE');
    const invoice: Invoice = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: input.amountMinor === entitlement.netPayableAmountMinor ? 'MATCHED' : 'SUBMITTED',
      submittedBy: context.actorUserId,
      createdAt: now(),
    };
    await this.store.append('invoices', invoice);
    await emit(this.store, context, 'InvoiceSubmitted', 'Invoice', invoice.id, {
      milestoneId: invoice.milestoneId,
      status: invoice.status,
    });
    return invoice;
  }

  async approve(context: RequestContext, id: string) {
    const invoice = await get<Invoice>(this.store, 'invoices', context, id);
    if (invoice.status !== 'MATCHED') throw new Error('INVOICE_NOT_MATCHED');
    const approved: Invoice = { ...invoice, status: 'APPROVED' };
    await this.store.replace('invoices', approved);
    await emit(this.store, context, 'InvoiceApproved', 'Invoice', id, { amountMinor: invoice.amountMinor });
    return approved;
  }

  async reject(context: RequestContext, input: { id: string; reason: string }) {
    const invoice = await get<Invoice>(this.store, 'invoices', context, input.id);
    if (invoice.status === 'APPROVED' || invoice.status === 'REJECTED') throw new Error('INVOICE_NOT_REJECTABLE');
    if (!input.reason.trim()) throw new Error('REJECTION_REASON_REQUIRED');
    const rejected: Invoice = { ...invoice, status: 'REJECTED' };
    await this.store.replace('invoices', rejected);
    await emit(this.store, context, 'InvoiceRejected', 'Invoice', invoice.id, { reason: input.reason });
    return rejected;
  }
}

// Engine 44 — Escrow & Funding Assurance
//
// NON-CUSTODY CONSTRAINT: AssuraPay never holds, pools, or has signing authority over
// funds. Every record in this engine is either (a) a reference to the external
// Financial Provider's own custody/escrow record, confirmed only through the
// provider's own API via `ExternalCustodyGateway`, or (b) a bookkeeping reservation
// against that external reference. No method here moves, holds, or takes possession
// of money — see `settlement-assurance.non-custody.test.ts`.

export interface ExternalCustodyGateway {
  confirmFunding(input: {
    providerKey: string;
    externalCustodyReference: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ confirmed: boolean; providerConfirmationReference: string }>;
}

export type FundingCommitment = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  providerKey: string;
  externalCustodyReference: string;
  committedAmountMinor: number;
  currency: string;
  status: 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED';
  providerConfirmationReference?: string;
  createdAt: string;
  confirmedAt?: string;
};

export type FundReservation = {
  id: string;
  workspaceId: string;
  fundingCommitmentId: string;
  invoiceId: string;
  reservedAmountMinor: number;
  status: 'RESERVED' | 'RELEASED' | 'CANCELLED';
  createdAt: string;
};

export class EscrowFundingAssuranceEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly gateway?: ExternalCustodyGateway,
  ) {}

  async recordCommitment(
    context: RequestContext,
    input: {
      milestoneId: string;
      providerKey: string;
      externalCustodyReference: string;
      committedAmountMinor: number;
      currency: string;
    },
  ) {
    requireIntegerMinorUnits(input.committedAmountMinor, 'COMMITTED_AMOUNT');
    if (!input.externalCustodyReference.trim()) throw new Error('EXTERNAL_CUSTODY_REFERENCE_REQUIRED');
    const commitment: FundingCommitment = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'PENDING_CONFIRMATION',
      createdAt: now(),
    };
    await this.store.append('fundingCommitments', commitment);
    await emit(this.store, context, 'FundingCommitmentRecorded', 'FundingCommitment', commitment.id, {
      milestoneId: commitment.milestoneId,
      providerKey: commitment.providerKey,
    });
    return commitment;
  }

  async confirmCommitment(context: RequestContext, id: string) {
    const commitment = await get<FundingCommitment>(this.store, 'fundingCommitments', context, id);
    if (commitment.status !== 'PENDING_CONFIRMATION') throw new Error('FUNDING_COMMITMENT_NOT_PENDING');
    if (!this.gateway) throw new Error('EXTERNAL_CUSTODY_GATEWAY_REQUIRED');
    const result = await this.gateway.confirmFunding({
      providerKey: commitment.providerKey,
      externalCustodyReference: commitment.externalCustodyReference,
      amountMinor: commitment.committedAmountMinor,
      currency: commitment.currency,
    });
    if (!result.confirmed) throw new Error('PROVIDER_FUNDING_NOT_CONFIRMED');
    const confirmed: FundingCommitment = {
      ...commitment,
      status: 'CONFIRMED',
      providerConfirmationReference: result.providerConfirmationReference,
      confirmedAt: now(),
    };
    await this.store.replace('fundingCommitments', confirmed);
    await emit(this.store, context, 'FundingCommitmentConfirmed', 'FundingCommitment', id, {
      providerConfirmationReference: result.providerConfirmationReference,
    });
    return confirmed;
  }

  async reserve(
    context: RequestContext,
    input: { fundingCommitmentId: string; invoiceId: string; reservedAmountMinor: number },
  ) {
    requireIntegerMinorUnits(input.reservedAmountMinor, 'RESERVED_AMOUNT');
    const commitment = await get<FundingCommitment>(this.store, 'fundingCommitments', context, input.fundingCommitmentId);
    if (commitment.status !== 'CONFIRMED') throw new Error('FUNDING_COMMITMENT_NOT_CONFIRMED');
    const workspaceId = ws(context);
    const activeReserved = (await this.store
      .list<FundReservation>('fundReservations'))
      .filter((x) => x.workspaceId === workspaceId && x.fundingCommitmentId === commitment.id && x.status === 'RESERVED')
      .reduce((sum, x) => sum + x.reservedAmountMinor, 0);
    if (activeReserved + input.reservedAmountMinor > commitment.committedAmountMinor)
      throw new Error('INSUFFICIENT_COMMITTED_FUNDS');
    const reservation: FundReservation = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'RESERVED',
      createdAt: now(),
    };
    await this.store.append('fundReservations', reservation);
    await emit(this.store, context, 'FundReservationCreated', 'FundReservation', reservation.id, {
      fundingCommitmentId: reservation.fundingCommitmentId,
      invoiceId: reservation.invoiceId,
    });
    return reservation;
  }

  async releaseReservation(context: RequestContext, id: string) {
    const reservation = await get<FundReservation>(this.store, 'fundReservations', context, id);
    if (reservation.status !== 'RESERVED') throw new Error('RESERVATION_NOT_RESERVED');
    const released: FundReservation = { ...reservation, status: 'RELEASED' };
    await this.store.replace('fundReservations', released);
    await emit(this.store, context, 'FundReservationReleased', 'FundReservation', id, {
      fundingCommitmentId: reservation.fundingCommitmentId,
    });
    return released;
  }

  async cancelReservation(context: RequestContext, input: { id: string; reason: string }) {
    const reservation = await get<FundReservation>(this.store, 'fundReservations', context, input.id);
    if (reservation.status !== 'RESERVED') throw new Error('RESERVATION_NOT_RESERVED');
    if (!input.reason.trim()) throw new Error('CANCELLATION_REASON_REQUIRED');
    const cancelled: FundReservation = { ...reservation, status: 'CANCELLED' };
    await this.store.replace('fundReservations', cancelled);
    await emit(this.store, context, 'FundReservationCancelled', 'FundReservation', reservation.id, {
      reason: input.reason,
    });
    return cancelled;
  }
}

// Engine 45 — Conditional Release Orchestration
//
// NON-CUSTODY CONSTRAINT: this engine evaluates whether the conditions for a release
// are met and records that outcome. It never authorizes, submits, or otherwise
// triggers a payment instruction to the Financial Provider — that is a distinct,
// later gate (Financial Approval & Authority, Payment Execution & Treasury
// Integration) intentionally out of scope for this engine.

export type ReleaseRequest = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  financialEntitlementId: string;
  invoiceId: string;
  fundReservationId: string;
  releaseType: 'FULL' | 'PARTIAL' | 'STAGED';
  requestedAmountMinor: number;
  currency: string;
  status: 'DRAFT' | 'CONDITIONS_MET' | 'BLOCKED' | 'CANCELLED';
  blockers: string[];
  requestedBy: string;
  createdAt: string;
};

export class ConditionalReleaseOrchestrationEngine {
  constructor(private readonly store: TrustPersistence) {}

  async draft(
    context: RequestContext,
    input: {
      milestoneId: string;
      financialEntitlementId: string;
      invoiceId: string;
      fundReservationId: string;
      releaseType: ReleaseRequest['releaseType'];
      requestedAmountMinor: number;
    },
  ) {
    requireIntegerMinorUnits(input.requestedAmountMinor, 'REQUESTED_AMOUNT');
    const entitlement = await get<FinancialEntitlement>(
      this.store,
      'financialEntitlements',
      context,
      input.financialEntitlementId,
    );
    const invoice = await get<Invoice>(this.store, 'invoices', context, input.invoiceId);
    const reservation = await get<FundReservation>(this.store, 'fundReservations', context, input.fundReservationId);
    if (input.releaseType === 'FULL' && input.requestedAmountMinor !== entitlement.netPayableAmountMinor)
      throw new Error('FULL_RELEASE_MUST_MATCH_ENTITLEMENT');
    if (input.requestedAmountMinor > reservation.reservedAmountMinor) throw new Error('REQUESTED_EXCEEDS_RESERVED');
    const request: ReleaseRequest = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      currency: entitlement.currency,
      status: 'DRAFT',
      blockers: [],
      requestedBy: context.actorUserId,
      createdAt: now(),
    };
    await this.store.append('releaseRequests', request);
    await emit(this.store, context, 'ReleaseRequestDrafted', 'ReleaseRequest', request.id, {
      milestoneId: request.milestoneId,
      releaseType: request.releaseType,
      requestedAmountMinor: request.requestedAmountMinor,
      invoiceStatus: invoice.status,
    });
    return request;
  }

  async evaluate(context: RequestContext, input: { id: string }) {
    const request = await get<ReleaseRequest>(this.store, 'releaseRequests', context, input.id);
    if (request.status === 'CANCELLED') throw new Error('RELEASE_REQUEST_CANCELLED');
    const invoice = await get<Invoice>(this.store, 'invoices', context, request.invoiceId);
    const reservation = await get<FundReservation>(this.store, 'fundReservations', context, request.fundReservationId);
    const entitlement = await get<FinancialEntitlement>(
      this.store,
      'financialEntitlements',
      context,
      request.financialEntitlementId,
    );
    const eligibility = await get<PaymentEligibility>(
      this.store,
      'paymentEligibilities',
      context,
      entitlement.paymentEligibilityId,
    );
    const blockers: string[] = [];
    if (!eligibility.eligible) blockers.push('PAYMENT_NOT_ELIGIBLE');
    if (invoice.status !== 'APPROVED') blockers.push('INVOICE_NOT_APPROVED');
    if (reservation.status !== 'RESERVED') blockers.push('FUNDS_NOT_RESERVED');
    if (await this.heldByDispute(context, request.id)) blockers.push('DISPUTE_HOLD_ACTIVE');
    const evaluated: ReleaseRequest = { ...request, status: blockers.length === 0 ? 'CONDITIONS_MET' : 'BLOCKED', blockers };
    await this.store.replace('releaseRequests', evaluated);
    await emit(this.store, context, 'ReleaseRequestEvaluated', 'ReleaseRequest', request.id, {
      status: evaluated.status,
      blockers: evaluated.blockers,
    });
    return evaluated;
  }

  /**
   * Whether an active dispute hold names this release request.
   *
   * CLAUDE.md hard constraint 2 requires that release happen only with no active hold, and until
   * `202608110002` nothing enforced it: `DisputeResolutionEngine.isHeld` computed the right answer
   * and had no callers, so the constraint existed as a function nobody invoked.
   *
   * This is the caller it was missing, and it is deliberately *not* the enforcement. The database
   * refuses a release-bearing write while a hold is active, for every writer including one the
   * application never mediated. What this adds is that a held request records **why** it is blocked,
   * as a named blocker in the engine's own vocabulary, instead of the caller discovering the hold
   * through a persistence failure. Enforcement and explanation are different jobs, and the trigger
   * cannot do the second one.
   *
   * Read through the store rather than by calling Engine 49: `settlement-assurance` does not depend
   * on `settlement-execution`, and adding that dependency to ask one question would couple the
   * release path to the dispute package for no gain. The hold is a record, and reading a record is
   * what the store is for.
   */
  private async heldByDispute(context: RequestContext, releaseRequestId: string) {
    const workspaceId = ws(context);
    type ActiveHold = { workspaceId: string; releaseRequestId: string; active: boolean };
    return (await this.store.list<ActiveHold>('disputeHolds')).some(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.releaseRequestId === releaseRequestId &&
        candidate.active,
    );
  }

  async cancel(context: RequestContext, input: { id: string; reason: string }) {
    const request = await get<ReleaseRequest>(this.store, 'releaseRequests', context, input.id);
    if (request.status === 'CANCELLED') throw new Error('RELEASE_REQUEST_ALREADY_CANCELLED');
    if (!input.reason.trim()) throw new Error('CANCELLATION_REASON_REQUIRED');
    const cancelled: ReleaseRequest = { ...request, status: 'CANCELLED' };
    await this.store.replace('releaseRequests', cancelled);
    await emit(this.store, context, 'ReleaseRequestCancelled', 'ReleaseRequest', request.id, { reason: input.reason });
    return cancelled;
  }
}

// Deterministic adapter for local development and certification only. Production
// deployments must supply a real `ExternalCustodyGateway` backed by the Financial
// Provider's own escrow/hold API — see the non-custody note on Engine 44 above.
export const deterministicCustodyGateway: ExternalCustodyGateway = {
  async confirmFunding(input) {
    return {
      confirmed: true,
      providerConfirmationReference: digest({ providerKey: input.providerKey, ref: input.externalCustodyReference }),
    };
  },
};
