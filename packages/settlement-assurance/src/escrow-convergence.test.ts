import { describe, expect, it } from 'vitest';
import { AgreementEscrowCompiler, PaymentReadinessEngine } from './escrow-convergence';

class Store {
  data = new Map<string, any[]>();
  async list<T>(c: string): Promise<T[]> { return (this.data.get(c) ?? []) as T[]; }
  async append(c: string, v: any) { this.data.set(c, [...(this.data.get(c) ?? []), v]); }
  async replace(c: string, v: any) { this.data.set(c, (this.data.get(c) ?? []).map(x => x.id === v.id ? v : x)); }
  async audit() {}
  async emit() {}
}
const context: any = { tenantId: 't1', activeWorkspaceId: 'w1', actorUserId: 'u1', correlationId: 'corr1' };

describe('agreement -> escrow -> payment readiness convergence', () => {
  it('compiles an executed agreement version into one immutable milestone instruction', async () => {
    const store: any = new Store();
    const compiler = new AgreementEscrowCompiler(store);
    const input = { agreementId: 'a1', agreementVersionId: 'av3', agreementStatus: 'EXECUTED' as const, milestoneId: 'm1', paymentMode: 'MILESTONE_ESCROW' as const, amountMinor: 1_000_000, currency: 'USD', providerKey: 'provider', releaseConditions: ['CERTIFIED', 'NO_DISPUTE'] };
    const first = await compiler.compile(context, input);
    const duplicate = await compiler.compile(context, input);
    expect(first.id).toBe(duplicate.id);
    expect(first.status).toBe('FUNDING_PENDING');
    expect(first.instructionHash).toHaveLength(64);
  });

  it('refuses compilation before agreement execution', async () => {
    const compiler = new AgreementEscrowCompiler(new Store() as any);
    await expect(compiler.compile(context, { agreementId: 'a1', agreementVersionId: 'av1', agreementStatus: 'DRAFT' as any, milestoneId: 'm1', paymentMode: 'MILESTONE_ESCROW', amountMinor: 100, currency: 'USD', releaseConditions: ['CERTIFIED'] })).rejects.toThrow('AGREEMENT_NOT_EXECUTED');
  });

  it('blocks release readiness while escrow funding, approval or dispute conditions fail', async () => {
    const store: any = new Store();
    const instruction = await new AgreementEscrowCompiler(store).compile(context, { agreementId: 'a1', agreementVersionId: 'av1', agreementStatus: 'EXECUTED', milestoneId: 'm1', paymentMode: 'MILESTONE_ESCROW', amountMinor: 100, currency: 'USD', releaseConditions: ['CERTIFIED'] });
    const result = await new PaymentReadinessEngine(store).assess(context, { escrowInstructionId: instruction.id, milestoneId: 'm1', fundingConfirmed: false, evidenceComplete: true, validationPassed: true, completionCertified: true, paymentTriggerEligible: true, invoiceApproved: true, requiredApprovalSatisfied: false, activeDisputeHold: true, blockingRisk: false });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(['FUNDING_NOT_CONFIRMED', 'REQUIRED_APPROVAL_PENDING', 'DISPUTE_HOLD_ACTIVE']);
  });

  it('becomes eligible only when every deterministic release gate passes', async () => {
    const store: any = new Store();
    const instruction = await new AgreementEscrowCompiler(store).compile(context, { agreementId: 'a1', agreementVersionId: 'av1', agreementStatus: 'ACTIVE', milestoneId: 'm1', paymentMode: 'MILESTONE_ESCROW', amountMinor: 100, currency: 'USD', releaseConditions: ['CERTIFIED'] });
    const result = await new PaymentReadinessEngine(store).assess(context, { escrowInstructionId: instruction.id, milestoneId: 'm1', fundingConfirmed: true, evidenceComplete: true, validationPassed: true, completionCertified: true, paymentTriggerEligible: true, invoiceApproved: true, requiredApprovalSatisfied: true, activeDisputeHold: false, blockingRisk: false });
    expect(result.eligible).toBe(true);
    expect(result.score).toBe(100);
    expect(result.blockers).toEqual([]);
  });
});
