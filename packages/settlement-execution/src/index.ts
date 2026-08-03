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

// Engine 46 — Financial Approval & Authority

export type ApprovalThreshold = {
  id: string;
  workspaceId: string;
  minAmountMinor: number;
  maxAmountMinor: number;
  currency: string;
  requiredApprovals: number;
  createdAt: string;
};

export type FinancialApprovalDecision = {
  id: string;
  workspaceId: string;
  authorizationId: string;
  approverId: string;
  decision: 'APPROVE' | 'REJECT';
  rationale: string;
  decidedAt: string;
};

export type AuthorizationDecision = {
  id: string;
  workspaceId: string;
  releaseRequestId: string;
  requestedBy: string;
  amountMinor: number;
  currency: string;
  requiredApprovals: number;
  status: 'PENDING' | 'AUTHORIZED' | 'REJECTED';
  createdAt: string;
  authorizedAt?: string;
};

export class FinancialApprovalAuthorityEngine {
  constructor(private readonly store: TrustPersistence) {}

  defineThreshold(
    context: RequestContext,
    input: { minAmountMinor: number; maxAmountMinor: number; currency: string; requiredApprovals: number },
  ) {
    if (input.minAmountMinor < 0 || input.maxAmountMinor <= input.minAmountMinor) throw new Error('INVALID_THRESHOLD_RANGE');
    if (!Number.isInteger(input.requiredApprovals) || input.requiredApprovals < 1)
      throw new Error('INVALID_REQUIRED_APPROVALS');
    const threshold: ApprovalThreshold = { id: randomUUID(), workspaceId: ws(context), ...input, createdAt: now() };
    this.store.append('approvalThresholds', threshold);
    return threshold;
  }

  requestAuthorization(
    context: RequestContext,
    input: { releaseRequestId: string; amountMinor: number; currency: string },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const workspaceId = ws(context);
    const threshold = this.store
      .list<ApprovalThreshold>('approvalThresholds')
      .find(
        (x) =>
          x.workspaceId === workspaceId &&
          x.currency === input.currency &&
          input.amountMinor >= x.minAmountMinor &&
          input.amountMinor <= x.maxAmountMinor,
      );
    if (!threshold) throw new Error('NO_APPROVAL_THRESHOLD_CONFIGURED');
    const authorization: AuthorizationDecision = {
      id: randomUUID(),
      workspaceId,
      releaseRequestId: input.releaseRequestId,
      requestedBy: context.actorUserId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      requiredApprovals: threshold.requiredApprovals,
      status: 'PENDING',
      createdAt: now(),
    };
    this.store.append('authorizationDecisions', authorization);
    return authorization;
  }

  approve(context: RequestContext, input: { id: string; rationale: string }) {
    const authorization = get<AuthorizationDecision>(this.store, 'authorizationDecisions', context, input.id);
    if (authorization.status !== 'PENDING') throw new Error('AUTHORIZATION_NOT_PENDING');
    if (context.actorUserId === authorization.requestedBy) throw new Error('SEGREGATION_OF_DUTIES_VIOLATION');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const workspaceId = ws(context);
    const existingApprovers = this.store
      .list<FinancialApprovalDecision>('financialApprovalDecisions')
      .filter((x) => x.workspaceId === workspaceId && x.authorizationId === authorization.id);
    if (existingApprovers.some((x) => x.approverId === context.actorUserId)) throw new Error('DUPLICATE_APPROVER');
    const decision: FinancialApprovalDecision = {
      id: randomUUID(),
      workspaceId,
      authorizationId: authorization.id,
      approverId: context.actorUserId,
      decision: 'APPROVE',
      rationale: input.rationale,
      decidedAt: now(),
    };
    this.store.append('financialApprovalDecisions', decision);
    const approverCount = existingApprovers.length + 1;
    if (approverCount >= authorization.requiredApprovals) {
      const authorized: AuthorizationDecision = { ...authorization, status: 'AUTHORIZED', authorizedAt: now() };
      this.store.replace('authorizationDecisions', authorized);
      emit(this.store, context, 'AuthorizationGranted', 'AuthorizationDecision', authorization.id, {
        releaseRequestId: authorization.releaseRequestId,
        approverCount,
      });
      return authorized;
    }
    return authorization;
  }

  reject(context: RequestContext, input: { id: string; rationale: string }) {
    const authorization = get<AuthorizationDecision>(this.store, 'authorizationDecisions', context, input.id);
    if (authorization.status !== 'PENDING') throw new Error('AUTHORIZATION_NOT_PENDING');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const rejected: AuthorizationDecision = { ...authorization, status: 'REJECTED' };
    this.store.replace('authorizationDecisions', rejected);
    emit(this.store, context, 'AuthorizationRejected', 'AuthorizationDecision', authorization.id, {
      releaseRequestId: authorization.releaseRequestId,
      rationale: input.rationale,
    });
    return rejected;
  }
}

// Engine 47 — Payment Execution & Treasury Integration
//
// NON-CUSTODY CONSTRAINT: AssuraPay never holds, pools, or has signing authority
// over funds. `submit` and `refreshStatus` are the only methods that touch money
// state, and both require the caller-supplied `PaymentProviderGateway` — the
// Financial Provider's own API. A payment instruction's status only ever reflects
// what the provider reports; nothing here asserts settlement unilaterally. See
// `settlement-execution.non-custody.test.ts`.

export interface PaymentProviderGateway {
  submitPayment(input: {
    providerKey: string;
    idempotencyKey: string;
    beneficiaryReference: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ providerReference: string; status: 'ACCEPTED' | 'REJECTED' }>;
  getStatus(input: { providerKey: string; providerReference: string }): Promise<{
    status: 'PENDING' | 'SETTLED' | 'FAILED' | 'REVERSED';
  }>;
}

export type PaymentInstruction = {
  id: string;
  workspaceId: string;
  releaseRequestId: string;
  providerKey: string;
  idempotencyKey: string;
  beneficiaryReference: string;
  amountMinor: number;
  currency: string;
  status: 'DRAFT' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'REVERSED';
  providerReference?: string;
  attempts: number;
  createdAt: string;
  submittedAt?: string;
  settledAt?: string;
};

export class PaymentExecutionEngine {
  constructor(
    private readonly store: TrustPersistence,
    private readonly gateway?: PaymentProviderGateway,
  ) {}

  issue(
    context: RequestContext,
    input: {
      releaseRequestId: string;
      providerKey: string;
      idempotencyKey: string;
      beneficiaryReference: string;
      amountMinor: number;
      currency: string;
      authorized: boolean;
    },
  ) {
    if (!input.authorized) throw new Error('AUTHORIZATION_REQUIRED');
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const workspaceId = ws(context);
    const existing = this.store
      .list<PaymentInstruction>('paymentInstructions')
      .find((x) => x.workspaceId === workspaceId && x.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const { authorized: _authorized, ...record } = input;
    const instruction: PaymentInstruction = {
      id: randomUUID(),
      workspaceId,
      ...record,
      status: 'DRAFT',
      attempts: 0,
      createdAt: now(),
    };
    this.store.append('paymentInstructions', instruction);
    emit(this.store, context, 'PaymentInstructionIssued', 'PaymentInstruction', instruction.id, {
      releaseRequestId: instruction.releaseRequestId,
      idempotencyKey: instruction.idempotencyKey,
    });
    return instruction;
  }

  async submit(context: RequestContext, id: string) {
    const instruction = get<PaymentInstruction>(this.store, 'paymentInstructions', context, id);
    if (instruction.status !== 'DRAFT' && instruction.status !== 'FAILED')
      throw new Error('PAYMENT_INSTRUCTION_NOT_SUBMITTABLE');
    if (!this.gateway) throw new Error('PAYMENT_PROVIDER_GATEWAY_REQUIRED');
    const result = await this.gateway.submitPayment({
      providerKey: instruction.providerKey,
      idempotencyKey: instruction.idempotencyKey,
      beneficiaryReference: instruction.beneficiaryReference,
      amountMinor: instruction.amountMinor,
      currency: instruction.currency,
    });
    if (result.status === 'REJECTED') {
      const failed: PaymentInstruction = { ...instruction, status: 'FAILED', attempts: instruction.attempts + 1 };
      this.store.replace('paymentInstructions', failed);
      emit(this.store, context, 'PaymentInstructionFailed', 'PaymentInstruction', id, { attempts: failed.attempts });
      throw new Error('PROVIDER_REJECTED_PAYMENT');
    }
    const submitted: PaymentInstruction = {
      ...instruction,
      status: 'SUBMITTED',
      providerReference: result.providerReference,
      attempts: instruction.attempts + 1,
      submittedAt: now(),
    };
    this.store.replace('paymentInstructions', submitted);
    emit(this.store, context, 'PaymentInstructionSubmitted', 'PaymentInstruction', id, {
      providerReference: result.providerReference,
    });
    return submitted;
  }

  async refreshStatus(context: RequestContext, id: string) {
    const instruction = get<PaymentInstruction>(this.store, 'paymentInstructions', context, id);
    if (instruction.status !== 'SUBMITTED') throw new Error('PAYMENT_INSTRUCTION_NOT_SUBMITTED');
    if (!this.gateway) throw new Error('PAYMENT_PROVIDER_GATEWAY_REQUIRED');
    const result = await this.gateway.getStatus({
      providerKey: instruction.providerKey,
      providerReference: instruction.providerReference!,
    });
    if (result.status === 'PENDING') return instruction;
    const updated: PaymentInstruction = {
      ...instruction,
      status: result.status,
      settledAt: result.status === 'SETTLED' ? now() : instruction.settledAt,
    };
    this.store.replace('paymentInstructions', updated);
    emit(this.store, context, 'PaymentInstructionStatusChanged', 'PaymentInstruction', id, { status: result.status });
    return updated;
  }

  reverse(context: RequestContext, input: { id: string; reason: string }) {
    const instruction = get<PaymentInstruction>(this.store, 'paymentInstructions', context, input.id);
    if (instruction.status !== 'SETTLED') throw new Error('PAYMENT_INSTRUCTION_NOT_SETTLED');
    if (!input.reason.trim()) throw new Error('REVERSAL_REASON_REQUIRED');
    const reversed: PaymentInstruction = { ...instruction, status: 'REVERSED' };
    this.store.replace('paymentInstructions', reversed);
    emit(this.store, context, 'PaymentInstructionReversed', 'PaymentInstruction', input.id, { reason: input.reason });
    return reversed;
  }
}

// Engine 48 — Reconciliation & Financial Ledger

export type LedgerEntry = {
  id: string;
  workspaceId: string;
  paymentInstructionId: string;
  entryType: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
  description: string;
  recordedAt: string;
};

export type ReconciliationRecord = {
  id: string;
  workspaceId: string;
  paymentInstructionId: string;
  providerStatementReference: string;
  providerReportedAmountMinor: number;
  recordedAmountMinor: number;
  matched: boolean;
  exceptionReason?: string;
  reconciledAt: string;
};

export class ReconciliationLedgerEngine {
  constructor(private readonly store: TrustPersistence) {}

  record(
    context: RequestContext,
    input: {
      paymentInstructionId: string;
      entryType: LedgerEntry['entryType'];
      amountMinor: number;
      currency: string;
      description: string;
    },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const entry: LedgerEntry = { id: randomUUID(), workspaceId: ws(context), ...input, recordedAt: now() };
    this.store.append('ledgerEntries', entry);
    emit(this.store, context, 'LedgerEntryRecorded', 'LedgerEntry', entry.id, {
      paymentInstructionId: entry.paymentInstructionId,
      entryType: entry.entryType,
    });
    return entry;
  }

  reconcile(
    context: RequestContext,
    input: {
      paymentInstructionId: string;
      providerStatementReference: string;
      providerReportedAmountMinor: number;
      recordedAmountMinor: number;
    },
  ) {
    const matched = input.providerReportedAmountMinor === input.recordedAmountMinor;
    const record: ReconciliationRecord = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      matched,
      exceptionReason: matched ? undefined : 'AMOUNT_MISMATCH',
      reconciledAt: now(),
    };
    this.store.append('reconciliationRecords', record);
    emit(this.store, context, 'ReconciliationRecorded', 'ReconciliationRecord', record.id, {
      paymentInstructionId: record.paymentInstructionId,
      matched,
    });
    return record;
  }

  exceptions(context: RequestContext) {
    const workspaceId = ws(context);
    return this.store
      .list<ReconciliationRecord>('reconciliationRecords')
      .filter((x) => x.workspaceId === workspaceId && !x.matched);
  }
}

// Engine 49 — Dispute, Claim & Appeal Resolution

export type Dispute = {
  id: string;
  workspaceId: string;
  releaseRequestId: string;
  kind: 'PAYMENT_DISPUTE' | 'CLAIM' | 'APPEAL';
  description: string;
  status: 'OPEN' | 'MEDIATION' | 'DECIDED' | 'APPEALED' | 'CLOSED';
  raisedBy: string;
  createdAt: string;
};

export type DisputeEvidence = {
  id: string;
  workspaceId: string;
  disputeId: string;
  reference: string;
  description: string;
  submittedBy: string;
  submittedAt: string;
};

export type DisputePosition = {
  id: string;
  workspaceId: string;
  disputeId: string;
  partyId: string;
  position: string;
  submittedAt: string;
};

export type DisputeDecision = {
  id: string;
  workspaceId: string;
  disputeId: string;
  decision: 'UPHELD' | 'REJECTED' | 'PARTIAL';
  rationale: string;
  decidedBy: string;
  decidedAt: string;
};

export type DisputeHold = {
  id: string;
  workspaceId: string;
  disputeId: string;
  releaseRequestId: string;
  active: boolean;
  placedAt: string;
  releasedAt?: string;
};

export class DisputeResolutionEngine {
  constructor(private readonly store: TrustPersistence) {}

  raise(context: RequestContext, input: { releaseRequestId: string; kind: Dispute['kind']; description: string }) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    const workspaceId = ws(context);
    const dispute: Dispute = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'OPEN',
      raisedBy: context.actorUserId,
      createdAt: now(),
    };
    this.store.append('disputes', dispute);
    const hold: DisputeHold = {
      id: randomUUID(),
      workspaceId,
      disputeId: dispute.id,
      releaseRequestId: input.releaseRequestId,
      active: true,
      placedAt: now(),
    };
    this.store.append('disputeHolds', hold);
    emit(this.store, context, 'DisputeRaised', 'Dispute', dispute.id, {
      releaseRequestId: dispute.releaseRequestId,
      kind: dispute.kind,
    });
    return dispute;
  }

  submitEvidence(context: RequestContext, input: { disputeId: string; reference: string; description: string }) {
    const dispute = get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status === 'CLOSED') throw new Error('DISPUTE_CLOSED');
    const evidence: DisputeEvidence = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      submittedBy: context.actorUserId,
      submittedAt: now(),
    };
    this.store.append('disputeEvidence', evidence);
    return evidence;
  }

  submitPosition(context: RequestContext, input: { disputeId: string; partyId: string; position: string }) {
    const dispute = get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status === 'CLOSED') throw new Error('DISPUTE_CLOSED');
    const position: DisputePosition = { id: randomUUID(), workspaceId: ws(context), ...input, submittedAt: now() };
    this.store.append('disputePositions', position);
    return position;
  }

  decide(context: RequestContext, input: { disputeId: string; decision: DisputeDecision['decision']; rationale: string }) {
    const dispute = get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status !== 'OPEN' && dispute.status !== 'MEDIATION') throw new Error('DISPUTE_NOT_DECIDABLE');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const decision: DisputeDecision = {
      id: randomUUID(),
      workspaceId: ws(context),
      disputeId: input.disputeId,
      decision: input.decision,
      rationale: input.rationale,
      decidedBy: context.actorUserId,
      decidedAt: now(),
    };
    this.store.append('disputeDecisions', decision);
    this.store.replace('disputes', { ...dispute, status: 'DECIDED' });
    emit(this.store, context, 'DisputeDecided', 'Dispute', dispute.id, { decision: input.decision });
    return decision;
  }

  appeal(context: RequestContext, input: { disputeId: string; reason: string }) {
    const dispute = get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status !== 'DECIDED') throw new Error('DISPUTE_NOT_DECIDED');
    if (!input.reason.trim()) throw new Error('APPEAL_REASON_REQUIRED');
    const appealed: Dispute = { ...dispute, status: 'APPEALED' };
    this.store.replace('disputes', appealed);
    emit(this.store, context, 'DisputeAppealed', 'Dispute', dispute.id, { reason: input.reason });
    return appealed;
  }

  close(context: RequestContext, disputeId: string) {
    const dispute = get<Dispute>(this.store, 'disputes', context, disputeId);
    if (dispute.status !== 'DECIDED' && dispute.status !== 'APPEALED') throw new Error('DISPUTE_NOT_RESOLVED');
    const workspaceId = ws(context);
    const closed: Dispute = { ...dispute, status: 'CLOSED' };
    this.store.replace('disputes', closed);
    for (const hold of this.store
      .list<DisputeHold>('disputeHolds')
      .filter((x) => x.workspaceId === workspaceId && x.disputeId === disputeId && x.active))
      this.store.replace('disputeHolds', { ...hold, active: false, releasedAt: now() });
    emit(this.store, context, 'DisputeClosed', 'Dispute', dispute.id, {});
    return closed;
  }

  isHeld(context: RequestContext, releaseRequestId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<DisputeHold>('disputeHolds')
      .some((x) => x.workspaceId === workspaceId && x.releaseRequestId === releaseRequestId && x.active);
  }
}

// Engine 50 — Final Settlement & Financial Closure

export type FinalSettlementAccount = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  totalEntitlementAmountMinor: number;
  totalSettledAmountMinor: number;
  outstandingAmountMinor: number;
  currency: string;
  status: 'DRAFT' | 'CLOSED';
  createdAt: string;
  closedAt?: string;
};

export type FinancialClosureCertificate = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  finalSettlementAccountId: string;
  canonicalHash: string;
  status: 'ISSUED' | 'REVOKED';
  issuedBy: string;
  issuedAt: string;
};

export class FinalSettlementEngine {
  constructor(private readonly store: TrustPersistence) {}

  account(
    context: RequestContext,
    input: {
      milestoneId: string;
      totalEntitlementAmountMinor: number;
      totalSettledAmountMinor: number;
      currency: string;
    },
  ) {
    if (!Number.isInteger(input.totalEntitlementAmountMinor) || input.totalEntitlementAmountMinor <= 0)
      throw new Error('TOTAL_ENTITLEMENT_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    if (!Number.isInteger(input.totalSettledAmountMinor) || input.totalSettledAmountMinor < 0)
      throw new Error('TOTAL_SETTLED_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    const outstandingAmountMinor = input.totalEntitlementAmountMinor - input.totalSettledAmountMinor;
    if (outstandingAmountMinor < 0) throw new Error('OVER_SETTLEMENT');
    const account: FinalSettlementAccount = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      outstandingAmountMinor,
      status: 'DRAFT',
      createdAt: now(),
    };
    this.store.append('finalSettlementAccounts', account);
    return account;
  }

  close(context: RequestContext, input: { id: string; noOpenDisputes: boolean }) {
    const account = get<FinalSettlementAccount>(this.store, 'finalSettlementAccounts', context, input.id);
    if (account.status !== 'DRAFT') throw new Error('ACCOUNT_NOT_DRAFT');
    if (account.outstandingAmountMinor > 0) throw new Error('OUTSTANDING_BALANCE_UNRESOLVED');
    if (!input.noOpenDisputes) throw new Error('OPEN_DISPUTES_UNRESOLVED');
    const closed: FinalSettlementAccount = { ...account, status: 'CLOSED', closedAt: now() };
    this.store.replace('finalSettlementAccounts', closed);
    emit(this.store, context, 'FinalSettlementAccountClosed', 'FinalSettlementAccount', account.id, {
      milestoneId: account.milestoneId,
    });
    return closed;
  }

  issueCertificate(context: RequestContext, finalSettlementAccountId: string) {
    const account = get<FinalSettlementAccount>(this.store, 'finalSettlementAccounts', context, finalSettlementAccountId);
    if (account.status !== 'CLOSED') throw new Error('ACCOUNT_NOT_CLOSED');
    const workspaceId = ws(context);
    if (
      this.store
        .list<FinancialClosureCertificate>('financialClosureCertificates')
        .some((x) => x.workspaceId === workspaceId && x.finalSettlementAccountId === account.id && x.status === 'ISSUED')
    )
      throw new Error('CLOSURE_CERTIFICATE_ALREADY_ISSUED');
    const certificate: FinancialClosureCertificate = {
      id: randomUUID(),
      workspaceId,
      milestoneId: account.milestoneId,
      finalSettlementAccountId: account.id,
      canonicalHash: digest({
        milestoneId: account.milestoneId,
        totalEntitlementAmountMinor: account.totalEntitlementAmountMinor,
        totalSettledAmountMinor: account.totalSettledAmountMinor,
      }),
      status: 'ISSUED',
      issuedBy: context.actorUserId,
      issuedAt: now(),
    };
    this.store.append('financialClosureCertificates', certificate);
    emit(this.store, context, 'FinancialClosureCertificateIssued', 'FinancialClosureCertificate', certificate.id, {
      milestoneId: certificate.milestoneId,
    });
    return certificate;
  }
}

// Deterministic adapter for local development and certification only. Production
// deployments must supply a real `PaymentProviderGateway` backed by the Financial
// Provider's own treasury/disbursement API — see the non-custody note on Engine 47.
export const deterministicPaymentGateway: PaymentProviderGateway = {
  async submitPayment(input) {
    return { providerReference: digest({ providerKey: input.providerKey, idempotencyKey: input.idempotencyKey }), status: 'ACCEPTED' };
  },
  async getStatus() {
    return { status: 'SETTLED' };
  },
};
