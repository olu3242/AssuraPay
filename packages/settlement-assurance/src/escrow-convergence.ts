import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const ws = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type EscrowPaymentMode =
  | 'DIRECT'
  | 'MILESTONE_ESCROW'
  | 'FULL_ESCROW'
  | 'DEPOSIT_MILESTONES'
  | 'RETAINER'
  | 'PAY_ON_DELIVERY'
  | 'EXTERNAL_PAYMENT';

export type EscrowInstruction = {
  id: string;
  workspaceId: string;
  agreementId: string;
  agreementVersionId: string;
  milestoneId: string;
  paymentMode: EscrowPaymentMode;
  amountMinor: number;
  currency: string;
  providerKey?: string;
  releaseConditions: string[];
  inspectionWindowHours?: number;
  instructionHash: string;
  status: 'COMPILED' | 'FUNDING_PENDING' | 'FUNDED' | 'SUPERSEDED';
  createdAt: string;
};

export type PaymentReadiness = {
  id: string;
  workspaceId: string;
  escrowInstructionId: string;
  milestoneId: string;
  score: number;
  eligible: boolean;
  blockers: string[];
  evaluatedAt: string;
};

async function emit(store: TrustPersistence, context: RequestContext, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  await store.audit({ tenantId: context.tenantId, workspaceId: ws(context), actorId: context.actorUserId, eventType, aggregateType, aggregateId, correlationId: context.correlationId, metadata: payload });
  await store.emit({ tenantId: context.tenantId, workspaceId: ws(context), aggregateType, aggregateId, eventType, eventVersion: 1, payload, correlationId: context.correlationId });
}

/**
 * Compiles the executed agreement's payment clauses into immutable financial instructions.
 * This does not create, hold or move funds. The instruction is the governed bridge between
 * the agreement source-of-truth and an external regulated custody/payment provider.
 */
export class AgreementEscrowCompiler {
  constructor(private readonly store: TrustPersistence) {}

  async compile(context: RequestContext, input: {
    agreementId: string;
    agreementVersionId: string;
    agreementStatus: 'EXECUTED' | 'ACTIVE';
    milestoneId: string;
    paymentMode: EscrowPaymentMode;
    amountMinor: number;
    currency: string;
    providerKey?: string;
    releaseConditions: string[];
    inspectionWindowHours?: number;
  }) {
    if (!['EXECUTED', 'ACTIVE'].includes(input.agreementStatus)) throw new Error('AGREEMENT_NOT_EXECUTED');
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('AMOUNT_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('INVALID_CURRENCY');
    if (input.releaseConditions.length === 0) throw new Error('RELEASE_CONDITIONS_REQUIRED');
    const workspaceId = ws(context);
    const existing = (await this.store.list<EscrowInstruction>('escrowInstructions')).find(x =>
      x.workspaceId === workspaceId && x.agreementVersionId === input.agreementVersionId && x.milestoneId === input.milestoneId && x.status !== 'SUPERSEDED');
    if (existing) return existing;
    const immutable = {
      agreementId: input.agreementId,
      agreementVersionId: input.agreementVersionId,
      milestoneId: input.milestoneId,
      paymentMode: input.paymentMode,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerKey: input.providerKey,
      releaseConditions: [...input.releaseConditions].sort(),
      inspectionWindowHours: input.inspectionWindowHours,
    };
    const instruction: EscrowInstruction = {
      id: randomUUID(), workspaceId, ...immutable,
      instructionHash: hash(immutable),
      status: input.paymentMode.includes('ESCROW') || input.paymentMode === 'DEPOSIT_MILESTONES' ? 'FUNDING_PENDING' : 'COMPILED',
      createdAt: now(),
    };
    await this.store.append('escrowInstructions', instruction);
    await emit(this.store, context, 'EscrowInstructionCompiled', 'EscrowInstruction', instruction.id, {
      agreementId: instruction.agreementId, agreementVersionId: instruction.agreementVersionId,
      milestoneId: instruction.milestoneId, instructionHash: instruction.instructionHash,
    });
    return instruction;
  }
}

/** Deterministic readiness gate. AI may supply evidence/risk findings upstream but cannot set eligible. */
export class PaymentReadinessEngine {
  constructor(private readonly store: TrustPersistence) {}

  async assess(context: RequestContext, input: {
    escrowInstructionId: string;
    milestoneId: string;
    fundingConfirmed: boolean;
    evidenceComplete: boolean;
    validationPassed: boolean;
    completionCertified: boolean;
    paymentTriggerEligible: boolean;
    invoiceApproved: boolean;
    requiredApprovalSatisfied: boolean;
    activeDisputeHold: boolean;
    blockingRisk: boolean;
  }) {
    const instruction = (await this.store.list<EscrowInstruction>('escrowInstructions')).find(x => x.id === input.escrowInstructionId && x.workspaceId === ws(context));
    if (!instruction) throw new Error('ESCROW_INSTRUCTION_NOT_FOUND');
    if (instruction.milestoneId !== input.milestoneId) throw new Error('MILESTONE_INSTRUCTION_MISMATCH');
    const blockers: string[] = [];
    const escrowFundingRequired = ['MILESTONE_ESCROW', 'FULL_ESCROW', 'DEPOSIT_MILESTONES'].includes(instruction.paymentMode);
    if (escrowFundingRequired && !input.fundingConfirmed) blockers.push('FUNDING_NOT_CONFIRMED');
    if (!input.evidenceComplete) blockers.push('EVIDENCE_INCOMPLETE');
    if (!input.validationPassed) blockers.push('VALIDATION_NOT_PASSED');
    if (!input.completionCertified) blockers.push('COMPLETION_NOT_CERTIFIED');
    if (!input.paymentTriggerEligible) blockers.push('PAYMENT_TRIGGER_NOT_ELIGIBLE');
    if (!input.invoiceApproved) blockers.push('INVOICE_NOT_APPROVED');
    if (!input.requiredApprovalSatisfied) blockers.push('REQUIRED_APPROVAL_PENDING');
    if (input.activeDisputeHold) blockers.push('DISPUTE_HOLD_ACTIVE');
    if (input.blockingRisk) blockers.push('BLOCKING_RISK_ACTIVE');
    const checks = 9 - blockers.length;
    const readiness: PaymentReadiness = {
      id: randomUUID(), workspaceId: ws(context), escrowInstructionId: instruction.id, milestoneId: input.milestoneId,
      score: Math.max(0, Math.round((checks / 9) * 100)), eligible: blockers.length === 0, blockers, evaluatedAt: now(),
    };
    await this.store.append('paymentReadinessAssessments', readiness);
    await emit(this.store, context, 'PaymentReadinessAssessed', 'PaymentReadiness', readiness.id, {
      milestoneId: readiness.milestoneId, score: readiness.score, eligible: readiness.eligible, blockers: readiness.blockers,
    });
    return readiness;
  }
}
