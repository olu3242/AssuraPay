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
function get<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = store
    .list<T>(collection)
    .find((x) => x.id === id && x.workspaceId === ws(context));
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
function emit(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  store.emit({
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

  assess(
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
    this.store.append('paymentEligibilities', assessment);
    emit(this.store, context, 'PaymentEligibilityAssessed', 'PaymentEligibility', assessment.id, {
      milestoneId: assessment.milestoneId,
      eligible: assessment.eligible,
    });
    return assessment;
  }

  latest(context: RequestContext, milestoneId: string) {
    const workspaceId = ws(context);
    const records = this.store
      .list<PaymentEligibility>('paymentEligibilities')
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

  calculate(
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
    const eligibility = get<PaymentEligibility>(this.store, 'paymentEligibilities', context, input.paymentEligibilityId);
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
    this.store.append('financialEntitlements', entitlement);
    emit(this.store, context, 'FinancialEntitlementCalculated', 'FinancialEntitlement', entitlement.id, {
      milestoneId: entitlement.milestoneId,
      netPayableAmountMinor: entitlement.netPayableAmountMinor,
    });
    return entitlement;
  }

  confirm(context: RequestContext, id: string) {
    const entitlement = get<FinancialEntitlement>(this.store, 'financialEntitlements', context, id);
    if (entitlement.status !== 'DRAFT') throw new Error('FINANCIAL_ENTITLEMENT_IMMUTABLE');
    const confirmed: FinancialEntitlement = { ...entitlement, status: 'CONFIRMED' };
    this.store.replace('financialEntitlements', confirmed);
    emit(this.store, context, 'FinancialEntitlementConfirmed', 'FinancialEntitlement', id, {
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

  submit(
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
    const entitlement = get<FinancialEntitlement>(
      this.store,
      'financialEntitlements',
      context,
      input.financialEntitlementId,
    );
    if (entitlement.status !== 'CONFIRMED') throw new Error('ENTITLEMENT_NOT_CONFIRMED');
    const workspaceId = ws(context);
    if (
      this.store
        .list<Invoice>('invoices')
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
    this.store.append('invoices', invoice);
    emit(this.store, context, 'InvoiceSubmitted', 'Invoice', invoice.id, {
      milestoneId: invoice.milestoneId,
      status: invoice.status,
    });
    return invoice;
  }

  approve(context: RequestContext, id: string) {
    const invoice = get<Invoice>(this.store, 'invoices', context, id);
    if (invoice.status !== 'MATCHED') throw new Error('INVOICE_NOT_MATCHED');
    const approved: Invoice = { ...invoice, status: 'APPROVED' };
    this.store.replace('invoices', approved);
    emit(this.store, context, 'InvoiceApproved', 'Invoice', id, { amountMinor: invoice.amountMinor });
    return approved;
  }

  reject(context: RequestContext, input: { id: string; reason: string }) {
    const invoice = get<Invoice>(this.store, 'invoices', context, input.id);
    if (invoice.status === 'APPROVED' || invoice.status === 'REJECTED') throw new Error('INVOICE_NOT_REJECTABLE');
    if (!input.reason.trim()) throw new Error('REJECTION_REASON_REQUIRED');
    const rejected: Invoice = { ...invoice, status: 'REJECTED' };
    this.store.replace('invoices', rejected);
    emit(this.store, context, 'InvoiceRejected', 'Invoice', invoice.id, { reason: input.reason });
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

  recordCommitment(
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
    this.store.append('fundingCommitments', commitment);
    emit(this.store, context, 'FundingCommitmentRecorded', 'FundingCommitment', commitment.id, {
      milestoneId: commitment.milestoneId,
      providerKey: commitment.providerKey,
    });
    return commitment;
  }

  async confirmCommitment(context: RequestContext, id: string) {
    const commitment = get<FundingCommitment>(this.store, 'fundingCommitments', context, id);
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
    this.store.replace('fundingCommitments', confirmed);
    emit(this.store, context, 'FundingCommitmentConfirmed', 'FundingCommitment', id, {
      providerConfirmationReference: result.providerConfirmationReference,
    });
    return confirmed;
  }

  reserve(
    context: RequestContext,
    input: { fundingCommitmentId: string; invoiceId: string; reservedAmountMinor: number },
  ) {
    requireIntegerMinorUnits(input.reservedAmountMinor, 'RESERVED_AMOUNT');
    const commitment = get<FundingCommitment>(this.store, 'fundingCommitments', context, input.fundingCommitmentId);
    if (commitment.status !== 'CONFIRMED') throw new Error('FUNDING_COMMITMENT_NOT_CONFIRMED');
    const workspaceId = ws(context);
    const activeReserved = this.store
      .list<FundReservation>('fundReservations')
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
    this.store.append('fundReservations', reservation);
    emit(this.store, context, 'FundReservationCreated', 'FundReservation', reservation.id, {
      fundingCommitmentId: reservation.fundingCommitmentId,
      invoiceId: reservation.invoiceId,
    });
    return reservation;
  }

  releaseReservation(context: RequestContext, id: string) {
    const reservation = get<FundReservation>(this.store, 'fundReservations', context, id);
    if (reservation.status !== 'RESERVED') throw new Error('RESERVATION_NOT_RESERVED');
    const released: FundReservation = { ...reservation, status: 'RELEASED' };
    this.store.replace('fundReservations', released);
    emit(this.store, context, 'FundReservationReleased', 'FundReservation', id, {
      fundingCommitmentId: reservation.fundingCommitmentId,
    });
    return released;
  }

  cancelReservation(context: RequestContext, input: { id: string; reason: string }) {
    const reservation = get<FundReservation>(this.store, 'fundReservations', context, input.id);
    if (reservation.status !== 'RESERVED') throw new Error('RESERVATION_NOT_RESERVED');
    if (!input.reason.trim()) throw new Error('CANCELLATION_REASON_REQUIRED');
    const cancelled: FundReservation = { ...reservation, status: 'CANCELLED' };
    this.store.replace('fundReservations', cancelled);
    emit(this.store, context, 'FundReservationCancelled', 'FundReservation', reservation.id, {
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

  draft(
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
    const entitlement = get<FinancialEntitlement>(
      this.store,
      'financialEntitlements',
      context,
      input.financialEntitlementId,
    );
    const invoice = get<Invoice>(this.store, 'invoices', context, input.invoiceId);
    const reservation = get<FundReservation>(this.store, 'fundReservations', context, input.fundReservationId);
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
    this.store.append('releaseRequests', request);
    emit(this.store, context, 'ReleaseRequestDrafted', 'ReleaseRequest', request.id, {
      milestoneId: request.milestoneId,
      releaseType: request.releaseType,
      requestedAmountMinor: request.requestedAmountMinor,
      invoiceStatus: invoice.status,
    });
    return request;
  }

  evaluate(context: RequestContext, input: { id: string; paymentEligible: boolean }) {
    const request = get<ReleaseRequest>(this.store, 'releaseRequests', context, input.id);
    if (request.status === 'CANCELLED') throw new Error('RELEASE_REQUEST_CANCELLED');
    const invoice = get<Invoice>(this.store, 'invoices', context, request.invoiceId);
    const reservation = get<FundReservation>(this.store, 'fundReservations', context, request.fundReservationId);
    const blockers: string[] = [];
    if (!input.paymentEligible) blockers.push('PAYMENT_NOT_ELIGIBLE');
    if (invoice.status !== 'APPROVED') blockers.push('INVOICE_NOT_APPROVED');
    if (reservation.status !== 'RESERVED') blockers.push('FUNDS_NOT_RESERVED');
    const evaluated: ReleaseRequest = { ...request, status: blockers.length === 0 ? 'CONDITIONS_MET' : 'BLOCKED', blockers };
    this.store.replace('releaseRequests', evaluated);
    emit(this.store, context, 'ReleaseRequestEvaluated', 'ReleaseRequest', request.id, {
      status: evaluated.status,
      blockers: evaluated.blockers,
    });
    return evaluated;
  }

  cancel(context: RequestContext, input: { id: string; reason: string }) {
    const request = get<ReleaseRequest>(this.store, 'releaseRequests', context, input.id);
    if (request.status === 'CANCELLED') throw new Error('RELEASE_REQUEST_ALREADY_CANCELLED');
    if (!input.reason.trim()) throw new Error('CANCELLATION_REASON_REQUIRED');
    const cancelled: ReleaseRequest = { ...request, status: 'CANCELLED' };
    this.store.replace('releaseRequests', cancelled);
    emit(this.store, context, 'ReleaseRequestCancelled', 'ReleaseRequest', request.id, { reason: input.reason });
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
