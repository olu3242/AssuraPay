import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const ws = (context: RequestContext) => { requireActiveWorkspace(context); return context.activeWorkspaceId; };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type EscrowPaymentMode = 'DIRECT'|'MILESTONE_ESCROW'|'FULL_ESCROW'|'DEPOSIT_MILESTONES'|'RETAINER'|'PAY_ON_DELIVERY'|'EXTERNAL_PAYMENT';
export type EscrowInstruction = { id:string; workspaceId:string; agreementId:string; agreementVersionId:string; milestoneId:string; paymentMode:EscrowPaymentMode; amountMinor:number; currency:string; providerKey?:string; releaseConditions:string[]; inspectionWindowHours?:number; instructionHash:string; status:'COMPILED'|'FUNDING_PENDING'|'FUNDED'|'SUPERSEDED'; createdAt:string };
export type PaymentReadiness = { id:string; workspaceId:string; escrowInstructionId:string; milestoneId:string; score:number; eligible:boolean; blockers:string[]; evaluatedAt:string };

type AgreementVersion = { id:string; workspaceId:string; agreementId:string; status?:string };
type FundingCommitment = { id:string; workspaceId:string; milestoneId:string; currency:string; committedAmountMinor:number; status:string };
type PaymentEligibility = { id:string; workspaceId:string; milestoneId:string; eligible:boolean; blockers:string[] };
type Invoice = { id:string; workspaceId:string; milestoneId:string; currency:string; amountMinor:number; status:string };
type DisputeHold = { workspaceId:string; releaseRequestId?:string; milestoneId?:string; active:boolean };
type CompletionCertificate = { id:string; workspaceId:string; milestoneId:string; status:string };

async function emit(store:TrustPersistence, context:RequestContext, eventType:string, aggregateType:string, aggregateId:string, payload:Record<string,unknown>) {
  await store.audit({tenantId:context.tenantId,workspaceId:ws(context),actorId:context.actorUserId,eventType,aggregateType,aggregateId,correlationId:context.correlationId,metadata:payload});
  await store.emit({tenantId:context.tenantId,workspaceId:ws(context),aggregateType,aggregateId,eventType,eventVersion:1,payload,correlationId:context.correlationId});
}
const latest = <T>(records:T[]) => records[records.length-1];

/** Compile only from a canonical executed agreement version already persisted in the workspace. */
export class AgreementEscrowCompiler {
  constructor(private readonly store:TrustPersistence) {}
  async compile(context:RequestContext,input:{agreementId:string;agreementVersionId:string;milestoneId:string;paymentMode:EscrowPaymentMode;amountMinor:number;currency:string;providerKey?:string;releaseConditions:string[];inspectionWindowHours?:number}) {
    const workspaceId=ws(context);
    const version=(await this.store.list<AgreementVersion>('agreementVersions')).find(x=>x.id===input.agreementVersionId&&x.workspaceId===workspaceId&&x.agreementId===input.agreementId);
    if(!version) throw new Error('AGREEMENT_VERSION_NOT_FOUND');
    const agreements=await this.store.list<{id:string;workspaceId:string;status:string;executedVersionId?:string}>('agreements');
    const agreement=agreements.find(x=>x.id===input.agreementId&&x.workspaceId===workspaceId);
    const executable=agreement && ['EXECUTED','ACTIVE'].includes(agreement.status) && (!agreement.executedVersionId || agreement.executedVersionId===input.agreementVersionId);
    if(!executable) throw new Error('AGREEMENT_NOT_EXECUTED');
    if(!Number.isInteger(input.amountMinor)||input.amountMinor<=0) throw new Error('AMOUNT_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    if(!/^[A-Z]{3}$/.test(input.currency)) throw new Error('INVALID_CURRENCY');
    if(input.releaseConditions.length===0) throw new Error('RELEASE_CONDITIONS_REQUIRED');
    const existing=(await this.store.list<EscrowInstruction>('escrowInstructions')).find(x=>x.workspaceId===workspaceId&&x.agreementVersionId===input.agreementVersionId&&x.milestoneId===input.milestoneId&&x.status!=='SUPERSEDED');
    if(existing) return existing;
    const immutable={...input,releaseConditions:[...input.releaseConditions].sort()};
    const instruction:EscrowInstruction={id:randomUUID(),workspaceId,...immutable,instructionHash:hash(immutable),status:['MILESTONE_ESCROW','FULL_ESCROW','DEPOSIT_MILESTONES'].includes(input.paymentMode)?'FUNDING_PENDING':'COMPILED',createdAt:now()};
    await this.store.append('escrowInstructions',instruction);
    await emit(this.store,context,'EscrowInstructionCompiled','EscrowInstruction',instruction.id,{agreementId:instruction.agreementId,agreementVersionId:instruction.agreementVersionId,milestoneId:instruction.milestoneId,instructionHash:instruction.instructionHash});
    return instruction;
  }
}

/**
 * Derived deterministic readiness. Callers provide identity only; authoritative financial/lifecycle
 * facts are read from canonical collections so UI, API and AI cannot manufacture release eligibility.
 */
export class PaymentReadinessEngine {
  constructor(private readonly store:TrustPersistence) {}
  async assess(context:RequestContext,input:{escrowInstructionId:string;milestoneId:string}) {
    const workspaceId=ws(context);
    const instruction=(await this.store.list<EscrowInstruction>('escrowInstructions')).find(x=>x.id===input.escrowInstructionId&&x.workspaceId===workspaceId);
    if(!instruction) throw new Error('ESCROW_INSTRUCTION_NOT_FOUND');
    if(instruction.milestoneId!==input.milestoneId) throw new Error('MILESTONE_INSTRUCTION_MISMATCH');

    const fundingRequired=['MILESTONE_ESCROW','FULL_ESCROW','DEPOSIT_MILESTONES'].includes(instruction.paymentMode);
    const funding=latest((await this.store.list<FundingCommitment>('fundingCommitments')).filter(x=>x.workspaceId===workspaceId&&x.milestoneId===input.milestoneId));
    const certificate=latest((await this.store.list<CompletionCertificate>('completionCertificates')).filter(x=>x.workspaceId===workspaceId&&x.milestoneId===input.milestoneId));
    const eligibility=latest((await this.store.list<PaymentEligibility>('paymentEligibilities')).filter(x=>x.workspaceId===workspaceId&&x.milestoneId===input.milestoneId));
    const invoice=latest((await this.store.list<Invoice>('invoices')).filter(x=>x.workspaceId===workspaceId&&x.milestoneId===input.milestoneId&&x.status!=='REJECTED'));
    const held=(await this.store.list<DisputeHold>('disputeHolds')).some(x=>x.workspaceId===workspaceId&&x.active&&x.milestoneId===input.milestoneId);

    const blockers:string[]=[];
    if(fundingRequired&&funding?.status!=='CONFIRMED') blockers.push('FUNDING_NOT_CONFIRMED');
    if(fundingRequired&&funding&&(funding.currency!==instruction.currency||funding.committedAmountMinor<instruction.amountMinor)) blockers.push('FUNDING_INSTRUCTION_MISMATCH');
    if(certificate?.status!=='CERTIFIED') blockers.push('COMPLETION_NOT_CERTIFIED');
    if(!eligibility?.eligible) blockers.push('PAYMENT_NOT_ELIGIBLE',...(eligibility?.blockers??[]).map(x=>`ELIGIBILITY:${x}`));
    if(invoice?.status!=='APPROVED') blockers.push('INVOICE_NOT_APPROVED');
    if(invoice&&(invoice.currency!==instruction.currency||invoice.amountMinor!==instruction.amountMinor)) blockers.push('INVOICE_INSTRUCTION_MISMATCH');
    if(held) blockers.push('DISPUTE_HOLD_ACTIVE');

    const unique=[...new Set(blockers)];
    const gateCount=5;
    const failedGates=[fundingRequired&&unique.some(x=>x.startsWith('FUNDING_')),unique.includes('COMPLETION_NOT_CERTIFIED'),unique.some(x=>x==='PAYMENT_NOT_ELIGIBLE'||x.startsWith('ELIGIBILITY:')),unique.some(x=>x.startsWith('INVOICE_')),unique.includes('DISPUTE_HOLD_ACTIVE')].filter(Boolean).length;
    const readiness:PaymentReadiness={id:randomUUID(),workspaceId,escrowInstructionId:instruction.id,milestoneId:input.milestoneId,score:Math.max(0,Math.round(((gateCount-failedGates)/gateCount)*100)),eligible:unique.length===0,blockers:unique,evaluatedAt:now()};
    await this.store.append('paymentReadinessAssessments',readiness);
    await emit(this.store,context,'PaymentReadinessAssessed','PaymentReadiness',readiness.id,{milestoneId:readiness.milestoneId,score:readiness.score,eligible:readiness.eligible,blockers:readiness.blockers});
    return readiness;
  }
}
