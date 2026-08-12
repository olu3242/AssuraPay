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

type AuthorizedRelease = {
  id: string;
  workspaceId: string;
  requestedAmountMinor: number;
  currency: string;
  status: 'DRAFT' | 'CONDITIONS_MET' | 'BLOCKED' | 'CANCELLED';
};

export class FinancialApprovalAuthorityEngine {
  constructor(private readonly store: TrustPersistence) {}

  async defineThreshold(
    context: RequestContext,
    input: { minAmountMinor: number; maxAmountMinor: number; currency: string; requiredApprovals: number },
  ) {
    if (!Number.isInteger(input.minAmountMinor) || !Number.isInteger(input.maxAmountMinor))
      throw new Error('THRESHOLD_AMOUNTS_MUST_BE_INTEGER_MINOR_UNITS');
    if (input.minAmountMinor < 0 || input.maxAmountMinor <= input.minAmountMinor) throw new Error('INVALID_THRESHOLD_RANGE');
    if (!Number.isInteger(input.requiredApprovals) || input.requiredApprovals < 1)
      throw new Error('INVALID_REQUIRED_APPROVALS');
    const threshold: ApprovalThreshold = { id: randomUUID(), workspaceId: ws(context), ...input, createdAt: now() };
    await this.store.append('approvalThresholds', threshold);
    await emit(this.store, context, 'ApprovalThresholdDefined', 'ApprovalThreshold', threshold.id, {
      currency: threshold.currency,
      requiredApprovals: threshold.requiredApprovals,
    });
    return threshold;
  }

  async requestAuthorization(
    context: RequestContext,
    input: { releaseRequestId: string; amountMinor: number; currency: string },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const workspaceId = ws(context);
    const release = await get<AuthorizedRelease>(this.store, 'releaseRequests', context, input.releaseRequestId);
    if (release.status !== 'CONDITIONS_MET') throw new Error('RELEASE_CONDITIONS_NOT_MET');
    if (release.requestedAmountMinor !== input.amountMinor || release.currency !== input.currency)
      throw new Error('AUTHORIZATION_RELEASE_MISMATCH');
    const threshold = (await this.store
      .list<ApprovalThreshold>('approvalThresholds'))
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
    await this.store.append('authorizationDecisions', authorization);
    await emit(this.store, context, 'AuthorizationRequested', 'AuthorizationDecision', authorization.id, {
      releaseRequestId: authorization.releaseRequestId,
      amountMinor: authorization.amountMinor,
      requiredApprovals: authorization.requiredApprovals,
    });
    return authorization;
  }

  async approve(context: RequestContext, input: { id: string; rationale: string }) {
    const authorization = await get<AuthorizationDecision>(this.store, 'authorizationDecisions', context, input.id);
    if (authorization.status !== 'PENDING') throw new Error('AUTHORIZATION_NOT_PENDING');
    if (context.actorUserId === authorization.requestedBy) throw new Error('SEGREGATION_OF_DUTIES_VIOLATION');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const workspaceId = ws(context);
    const existingApprovers = (await this.store
      .list<FinancialApprovalDecision>('financialApprovalDecisions'))
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
    await this.store.append('financialApprovalDecisions', decision);
    await emit(this.store, context, 'ApprovalVoteCast', 'AuthorizationDecision', authorization.id, {
      approverId: decision.approverId,
    });
    const approverCount = existingApprovers.length + 1;
    if (approverCount >= authorization.requiredApprovals) {
      const authorized: AuthorizationDecision = { ...authorization, status: 'AUTHORIZED', authorizedAt: now() };
      await this.store.replace('authorizationDecisions', authorized);
      await emit(this.store, context, 'AuthorizationGranted', 'AuthorizationDecision', authorization.id, {
        releaseRequestId: authorization.releaseRequestId,
        approverCount,
      });
      return authorized;
    }
    return authorization;
  }

  async reject(context: RequestContext, input: { id: string; rationale: string }) {
    const authorization = await get<AuthorizationDecision>(this.store, 'authorizationDecisions', context, input.id);
    if (authorization.status !== 'PENDING') throw new Error('AUTHORIZATION_NOT_PENDING');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const rejected: AuthorizationDecision = { ...authorization, status: 'REJECTED' };
    await this.store.replace('authorizationDecisions', rejected);
    await emit(this.store, context, 'AuthorizationRejected', 'AuthorizationDecision', authorization.id, {
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
  /**
   * Digest of the semantic payload this key was first used with.
   *
   * `docs/finance/MONETARY_INVARIANTS.md`: "Reusing a key with a different semantic payload
   * **fails**. This needs a stored payload digest to compare against; a key alone cannot detect it."
   * Without it, `issue` returned the existing instruction for any repeat of the key — so a retry that
   * had drifted to a different beneficiary or amount was silently accepted as the original, which is
   * the one failure mode idempotency is supposed to prevent.
   */
  payloadDigest: string;
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

  async issue(
    context: RequestContext,
    input: {
      releaseRequestId: string;
      providerKey: string;
      idempotencyKey: string;
      beneficiaryReference: string;
      amountMinor: number;
      currency: string;
      authorizationDecisionId: string;
    },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    const workspaceId = ws(context);
    const authorization = await get<AuthorizationDecision>(
      this.store,
      'authorizationDecisions',
      context,
      input.authorizationDecisionId,
    );
    if (authorization.status !== 'AUTHORIZED') throw new Error('AUTHORIZATION_REQUIRED');
    if (
      authorization.releaseRequestId !== input.releaseRequestId ||
      authorization.amountMinor !== input.amountMinor ||
      authorization.currency !== input.currency
    ) throw new Error('AUTHORIZATION_INSTRUCTION_MISMATCH');
    const release = await get<AuthorizedRelease>(this.store, 'releaseRequests', context, input.releaseRequestId);
    if (release.status !== 'CONDITIONS_MET') throw new Error('RELEASE_CONDITIONS_NOT_MET');
    // The semantic payload: everything that determines what money moves and to whom. `providerKey`
    // is included because the same key against a different provider is a different instruction, and
    // the id and timestamps are excluded because they differ on every call by construction.
    const payloadDigest = digest({
      releaseRequestId: input.releaseRequestId,
      providerKey: input.providerKey,
      beneficiaryReference: input.beneficiaryReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
    const existing = (await this.store
      .list<PaymentInstruction>('paymentInstructions'))
      .find((x) => x.workspaceId === workspaceId && x.idempotencyKey === input.idempotencyKey);
    if (existing) {
      // A repeat of the key with a different payload is not a retry, it is a different instruction
      // wearing a retry's clothes. Returning the original would silently discard the new intent;
      // storing a second row would double-instruct the provider. Refusing is the only safe answer.
      if (existing.payloadDigest !== payloadDigest)
        throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      return existing;
    }
    const instructionForRelease = (await this.store
      .list<PaymentInstruction>('paymentInstructions'))
      .find((x) => x.workspaceId === workspaceId && x.releaseRequestId === input.releaseRequestId);
    if (instructionForRelease) throw new Error('RELEASE_ALREADY_INSTRUCTED');
    const { authorizationDecisionId: _authorizationDecisionId, ...record } = input;
    const instruction: PaymentInstruction = {
      id: randomUUID(),
      workspaceId,
      ...record,
      payloadDigest,
      status: 'DRAFT',
      attempts: 0,
      createdAt: now(),
    };
    await this.store.append('paymentInstructions', instruction);
    await emit(this.store, context, 'PaymentInstructionIssued', 'PaymentInstruction', instruction.id, {
      releaseRequestId: instruction.releaseRequestId,
      idempotencyKey: instruction.idempotencyKey,
    });
    return instruction;
  }

  async submit(context: RequestContext, id: string) {
    const instruction = await get<PaymentInstruction>(this.store, 'paymentInstructions', context, id);
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
      await this.store.replace('paymentInstructions', failed);
      await emit(this.store, context, 'PaymentInstructionFailed', 'PaymentInstruction', id, { attempts: failed.attempts });
      throw new Error('PROVIDER_REJECTED_PAYMENT');
    }
    const submitted: PaymentInstruction = {
      ...instruction,
      status: 'SUBMITTED',
      providerReference: result.providerReference,
      attempts: instruction.attempts + 1,
      submittedAt: now(),
    };
    await this.store.replace('paymentInstructions', submitted);
    await emit(this.store, context, 'PaymentInstructionSubmitted', 'PaymentInstruction', id, {
      providerReference: result.providerReference,
    });
    return submitted;
  }

  async refreshStatus(context: RequestContext, id: string) {
    const instruction = await get<PaymentInstruction>(this.store, 'paymentInstructions', context, id);
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
    await this.store.replace('paymentInstructions', updated);
    await emit(this.store, context, 'PaymentInstructionStatusChanged', 'PaymentInstruction', id, { status: result.status });
    return updated;
  }

  async reverse(context: RequestContext, input: { id: string; reason: string }) {
    const instruction = await get<PaymentInstruction>(this.store, 'paymentInstructions', context, input.id);
    if (instruction.status !== 'SETTLED') throw new Error('PAYMENT_INSTRUCTION_NOT_SETTLED');
    if (!input.reason.trim()) throw new Error('REVERSAL_REASON_REQUIRED');
    const reversed: PaymentInstruction = { ...instruction, status: 'REVERSED' };
    await this.store.replace('paymentInstructions', reversed);
    await emit(this.store, context, 'PaymentInstructionReversed', 'PaymentInstruction', input.id, { reason: input.reason });
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
  /**
   * The currency both amounts are in.
   *
   * Absent until now, which meant a reconciliation held two money amounts and no unit. The amounts
   * are only ever compared to each other, so nothing was *wrong* in practice — but MONETARY_INVARIANTS
   * requires a currency to travel with every amount, and without the column the foreign key to the
   * instruction could not carry currency the way `ledger_entries` does. It is taken from the
   * instruction rather than the caller: a reconciliation in a different currency from the payment it
   * reconciles is not a mismatch to record, it is a question nobody asked.
   */
  currency: string;
  providerReportedAmountMinor: number;
  recordedAmountMinor: number;
  matched: boolean;
  exceptionReason?: string;
  reconciledAt: string;
};

export class ReconciliationLedgerEngine {
  constructor(private readonly store: TrustPersistence) {}

  /**
   * Posts one balanced journal transaction: a debit and the credit that answers it.
   *
   * Replaces a single-leg `record`, which could not survive its own aggregate. `LedgerEntry` has
   * always been typed `DEBIT | CREDIT`, but nothing ever wrote a matching pair — the ledger was
   * single-entry with a double-entry vocabulary, and `docs/finance/MONETARY_INVARIANTS.md` requires
   * a journal to balance per currency. A method that posts one leg makes the unbalanced state the
   * default and balance an act of caller discipline.
   *
   * Both legs go through `store.transaction`, so they reach the database as one unit. That matters
   * because the balance rule is enforced by a deferred constraint trigger that fires at COMMIT: the
   * intermediate state after the first leg is unbalanced and permitted, and the committed state
   * cannot be. Posting the legs in separate transactions would be refused by the database, which is
   * the correct outcome and the reason this method exists.
   */
  async post(
    context: RequestContext,
    input: {
      paymentInstructionId: string;
      amountMinor: number;
      currency: string;
      debitDescription: string;
      creditDescription: string;
    },
  ) {
    requireIntegerMinorUnits(input.amountMinor, 'AMOUNT');
    if (!input.debitDescription.trim() || !input.creditDescription.trim())
      throw new Error('LEDGER_ENTRY_DESCRIPTION_REQUIRED');
    const workspaceId = ws(context);
    const recordedAt = now();
    const leg = (entryType: LedgerEntry['entryType'], description: string): LedgerEntry => ({
      id: randomUUID(),
      workspaceId,
      paymentInstructionId: input.paymentInstructionId,
      entryType,
      amountMinor: input.amountMinor,
      currency: input.currency,
      description,
      recordedAt,
    });
    const debit = leg('DEBIT', input.debitDescription);
    const credit = leg('CREDIT', input.creditDescription);

    await this.store.transaction(async (tx) => {
      await tx.append('ledgerEntries', debit);
      await tx.append('ledgerEntries', credit);
    });

    // Emitted after the commit that proved the journal balances. An event announcing a posting the
    // database went on to refuse would be an event for something that never happened.
    await emit(this.store, context, 'LedgerJournalPosted', 'LedgerEntry', debit.id, {
      paymentInstructionId: debit.paymentInstructionId,
      creditEntryId: credit.id,
      amountMinor: debit.amountMinor,
      currency: debit.currency,
    });
    return { debit, credit };
  }

  async reconcile(
    context: RequestContext,
    input: {
      paymentInstructionId: string;
      providerStatementReference: string;
      providerReportedAmountMinor: number;
      recordedAmountMinor: number;
    },
  ) {
    if (!Number.isInteger(input.providerReportedAmountMinor) || input.providerReportedAmountMinor < 0)
      throw new Error('PROVIDER_REPORTED_AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    if (!Number.isInteger(input.recordedAmountMinor) || input.recordedAmountMinor < 0)
      throw new Error('RECORDED_AMOUNT_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    // Loaded rather than trusted from the caller. It supplies the currency, and it also means a
    // reconciliation against an instruction that does not exist fails here instead of at the foreign
    // key — which for a reconciliation report is the difference between "no such payment" and
    // "database error".
    const instruction = await get<PaymentInstruction>(
      this.store,
      'paymentInstructions',
      context,
      input.paymentInstructionId,
    );
    const matched = input.providerReportedAmountMinor === input.recordedAmountMinor;
    const record: ReconciliationRecord = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      currency: instruction.currency,
      matched,
      exceptionReason: matched ? undefined : 'AMOUNT_MISMATCH',
      reconciledAt: now(),
    };
    await this.store.append('reconciliationRecords', record);
    await emit(this.store, context, 'ReconciliationRecorded', 'ReconciliationRecord', record.id, {
      paymentInstructionId: record.paymentInstructionId,
      matched,
    });
    return record;
  }

  async exceptions(context: RequestContext) {
    const workspaceId = ws(context);
    return (await this.store
      .list<ReconciliationRecord>('reconciliationRecords'))
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

  async raise(context: RequestContext, input: { releaseRequestId: string; kind: Dispute['kind']; description: string }) {
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
    await this.store.append('disputes', dispute);
    const hold: DisputeHold = {
      id: randomUUID(),
      workspaceId,
      disputeId: dispute.id,
      releaseRequestId: input.releaseRequestId,
      active: true,
      placedAt: now(),
    };
    await this.store.append('disputeHolds', hold);
    await emit(this.store, context, 'DisputeRaised', 'Dispute', dispute.id, {
      releaseRequestId: dispute.releaseRequestId,
      kind: dispute.kind,
    });
    await emit(this.store, context, 'DisputeHoldPlaced', 'DisputeHold', hold.id, {
      disputeId: hold.disputeId,
      releaseRequestId: hold.releaseRequestId,
    });
    return dispute;
  }

  async submitEvidence(context: RequestContext, input: { disputeId: string; reference: string; description: string }) {
    const dispute = await get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status === 'CLOSED') throw new Error('DISPUTE_CLOSED');
    const evidence: DisputeEvidence = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      submittedBy: context.actorUserId,
      submittedAt: now(),
    };
    await this.store.append('disputeEvidence', evidence);
    await emit(this.store, context, 'DisputeEvidenceSubmitted', 'Dispute', dispute.id, { evidenceId: evidence.id });
    return evidence;
  }

  async submitPosition(context: RequestContext, input: { disputeId: string; partyId: string; position: string }) {
    const dispute = await get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status === 'CLOSED') throw new Error('DISPUTE_CLOSED');
    const position: DisputePosition = { id: randomUUID(), workspaceId: ws(context), ...input, submittedAt: now() };
    await this.store.append('disputePositions', position);
    await emit(this.store, context, 'DisputePositionSubmitted', 'Dispute', dispute.id, { partyId: input.partyId });
    return position;
  }

  async decide(context: RequestContext, input: { disputeId: string; decision: DisputeDecision['decision']; rationale: string }) {
    const dispute = await get<Dispute>(this.store, 'disputes', context, input.disputeId);
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
    await this.store.append('disputeDecisions', decision);
    await this.store.replace('disputes', { ...dispute, status: 'DECIDED' });
    await emit(this.store, context, 'DisputeDecided', 'Dispute', dispute.id, { decision: input.decision });
    return decision;
  }

  async appeal(context: RequestContext, input: { disputeId: string; reason: string }) {
    const dispute = await get<Dispute>(this.store, 'disputes', context, input.disputeId);
    if (dispute.status !== 'DECIDED') throw new Error('DISPUTE_NOT_DECIDED');
    if (!input.reason.trim()) throw new Error('APPEAL_REASON_REQUIRED');
    const appealed: Dispute = { ...dispute, status: 'APPEALED' };
    await this.store.replace('disputes', appealed);
    await emit(this.store, context, 'DisputeAppealed', 'Dispute', dispute.id, { reason: input.reason });
    return appealed;
  }

  async close(context: RequestContext, disputeId: string) {
    const dispute = await get<Dispute>(this.store, 'disputes', context, disputeId);
    if (dispute.status !== 'DECIDED' && dispute.status !== 'APPEALED') throw new Error('DISPUTE_NOT_RESOLVED');
    const workspaceId = ws(context);
    const closed: Dispute = { ...dispute, status: 'CLOSED' };
    await this.store.replace('disputes', closed);
    for (const hold of (await this.store
      .list<DisputeHold>('disputeHolds'))
      .filter((x) => x.workspaceId === workspaceId && x.disputeId === disputeId && x.active)) {
      await this.store.replace('disputeHolds', { ...hold, active: false, releasedAt: now() });
      await emit(this.store, context, 'DisputeHoldReleased', 'DisputeHold', hold.id, {
        disputeId: hold.disputeId,
        releaseRequestId: hold.releaseRequestId,
      });
    }
    await emit(this.store, context, 'DisputeClosed', 'Dispute', dispute.id, {});
    return closed;
  }

  async isHeld(context: RequestContext, releaseRequestId: string) {
    const workspaceId = ws(context);
    return (await this.store
      .list<DisputeHold>('disputeHolds'))
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

  async account(
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
    await this.store.append('finalSettlementAccounts', account);
    await emit(this.store, context, 'FinalSettlementAccountOpened', 'FinalSettlementAccount', account.id, {
      milestoneId: account.milestoneId,
      outstandingAmountMinor: account.outstandingAmountMinor,
    });
    return account;
  }

  async close(context: RequestContext, input: { id: string; noOpenDisputes: boolean }) {
    const account = await get<FinalSettlementAccount>(this.store, 'finalSettlementAccounts', context, input.id);
    if (account.status !== 'DRAFT') throw new Error('ACCOUNT_NOT_DRAFT');
    if (account.outstandingAmountMinor > 0) throw new Error('OUTSTANDING_BALANCE_UNRESOLVED');
    if (!input.noOpenDisputes) throw new Error('OPEN_DISPUTES_UNRESOLVED');
    const closed: FinalSettlementAccount = { ...account, status: 'CLOSED', closedAt: now() };
    await this.store.replace('finalSettlementAccounts', closed);
    await emit(this.store, context, 'FinalSettlementAccountClosed', 'FinalSettlementAccount', account.id, {
      milestoneId: account.milestoneId,
    });
    return closed;
  }

  async issueCertificate(context: RequestContext, finalSettlementAccountId: string) {
    const account = await get<FinalSettlementAccount>(this.store, 'finalSettlementAccounts', context, finalSettlementAccountId);
    if (account.status !== 'CLOSED') throw new Error('ACCOUNT_NOT_CLOSED');
    const workspaceId = ws(context);
    if (
      (await this.store
        .list<FinancialClosureCertificate>('financialClosureCertificates'))
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
    await this.store.append('financialClosureCertificates', certificate);
    await emit(this.store, context, 'FinancialClosureCertificateIssued', 'FinancialClosureCertificate', certificate.id, {
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
