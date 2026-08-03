import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  DisputeResolutionEngine,
  FinalSettlementEngine,
  FinancialApprovalAuthorityEngine,
  PaymentExecutionEngine,
  ReconciliationLedgerEngine,
} from './index';

describe('e2e Batch 10 dual-approved release to a certified financial closure', () => {
  it('carries a condition-met release request through authorization, non-custodial payment execution, reconciliation and closure', async () => {
    const s = new InMemoryTrustStore();
    const requester = {
      actorUserId: 'finance-officer',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };
    const approver1 = { ...requester, actorUserId: 'treasury-lead' };
    const approver2 = { ...requester, actorUserId: 'finance-director' };

    const approvals = new FinancialApprovalAuthorityEngine(s);
    approvals.defineThreshold(requester, {
      minAmountMinor: 0,
      maxAmountMinor: 1_000_000_000,
      currency: 'NGN',
      requiredApprovals: 2,
    });
    const authorization = approvals.requestAuthorization(requester, {
      releaseRequestId: 'release-request',
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    approvals.approve(approver1, { id: authorization.id, rationale: 'matches confirmed entitlement' });
    const authorized = approvals.approve(approver2, { id: authorization.id, rationale: 'independent second check' });
    expect(authorized.status).toBe('AUTHORIZED');

    const disputes = new DisputeResolutionEngine(s);
    expect(disputes.isHeld(requester, 'release-request')).toBe(false);

    const payments = new PaymentExecutionEngine(s, {
      async submitPayment(input) {
        return { providerReference: `bank-ref-${input.idempotencyKey}`, status: 'ACCEPTED' };
      },
      async getStatus() {
        return { status: 'SETTLED' };
      },
    });
    const instruction = payments.issue(requester, {
      releaseRequestId: authorization.releaseRequestId,
      providerKey: 'partner-bank-escrow',
      idempotencyKey: `release-${authorization.releaseRequestId}`,
      beneficiaryReference: 'lagos-steel-supply-acct',
      amountMinor: authorization.amountMinor,
      currency: authorization.currency,
      authorized: authorized.status === 'AUTHORIZED',
    });
    await payments.submit(requester, instruction.id);
    const settled = await payments.refreshStatus(requester, instruction.id);
    expect(settled.status).toBe('SETTLED');

    const ledger = new ReconciliationLedgerEngine(s);
    ledger.record(requester, {
      paymentInstructionId: instruction.id,
      entryType: 'DEBIT',
      amountMinor: instruction.amountMinor,
      currency: instruction.currency,
      description: 'partner bank escrow release for milestone payout',
    });
    const reconciliation = ledger.reconcile(requester, {
      paymentInstructionId: instruction.id,
      providerStatementReference: 'stmt-2026-08',
      providerReportedAmountMinor: instruction.amountMinor,
      recordedAmountMinor: instruction.amountMinor,
    });
    expect(reconciliation.matched).toBe(true);
    expect(ledger.exceptions(requester)).toHaveLength(0);

    const closure = new FinalSettlementEngine(s);
    const account = closure.account(requester, {
      milestoneId: 'erection-milestone',
      totalEntitlementAmountMinor: instruction.amountMinor,
      totalSettledAmountMinor: instruction.amountMinor,
      currency: 'NGN',
    });
    const closed = closure.close(requester, { id: account.id, noOpenDisputes: !disputes.isHeld(requester, 'release-request') });
    expect(closed.status).toBe('CLOSED');
    const certificate = closure.issueCertificate(requester, closed.id);
    expect(certificate).toMatchObject({ status: 'ISSUED', milestoneId: 'erection-milestone' });
  });
});
