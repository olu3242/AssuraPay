import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  DisputeResolutionEngine,
  FinalSettlementEngine,
  FinancialApprovalAuthorityEngine,
  PaymentExecutionEngine,
  ReconciliationLedgerEngine,
} from './index';

const requester = {
  actorUserId: 'requester',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};
const approver1 = { ...requester, actorUserId: 'approver-1' };
const approver2 = { ...requester, actorUserId: 'approver-2' };

describe('Engine 46 Financial Approval & Authority', () => {
  it('enforces segregation of duties, rejects duplicate approvers and requires every configured approval', async () => {
    const s = new InMemoryTrustStore();
    const e = new FinancialApprovalAuthorityEngine(s);
    await expect(e.defineThreshold(requester, { minAmountMinor: 100, maxAmountMinor: 50, currency: 'NGN', requiredApprovals: 1 })).rejects.toThrow('INVALID_THRESHOLD_RANGE');
    await e.defineThreshold(requester, {
      minAmountMinor: 0,
      maxAmountMinor: 1_000_000_000,
      currency: 'NGN',
      requiredApprovals: 2,
    });
    await expect(e.requestAuthorization(requester, { releaseRequestId: 'r', amountMinor: 425_000_000, currency: 'USD' })).rejects.toThrow('NO_APPROVAL_THRESHOLD_CONFIGURED');
    const authorization = await e.requestAuthorization(requester, {
      releaseRequestId: 'r',
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    await expect(e.approve(requester, { id: authorization.id, rationale: 'looks fine' })).rejects.toThrow(
      'SEGREGATION_OF_DUTIES_VIOLATION',
    );
    const firstApproval = await e.approve(approver1, { id: authorization.id, rationale: 'verified against entitlement' });
    expect(firstApproval.status).toBe('PENDING');
    await expect(e.approve(approver1, { id: authorization.id, rationale: 'again' })).rejects.toThrow('DUPLICATE_APPROVER');
    const authorized = await e.approve(approver2, { id: authorization.id, rationale: 'second independent check' });
    expect(authorized.status).toBe('AUTHORIZED');
    await expect(e.approve(approver1, { id: authorization.id, rationale: 'late' })).rejects.toThrow('AUTHORIZATION_NOT_PENDING');
  });
});

describe('Engine 47 Payment Execution & Treasury Integration', () => {
  it('requires authorization and a provider gateway, is idempotent on issue and records provider rejection as failure', async () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentExecutionEngine(s, {
      async submitPayment() {
        return { providerReference: 'prov-ref-1', status: 'ACCEPTED' };
      },
      async getStatus() {
        return { status: 'SETTLED' };
      },
    });
    await expect(e.issue(requester, {
        releaseRequestId: 'r',
        providerKey: 'paystack',
        idempotencyKey: 'idem-1',
        beneficiaryReference: 'acct-1',
        amountMinor: 425_000_000,
        currency: 'NGN',
        authorized: false,
      })).rejects.toThrow('AUTHORIZATION_REQUIRED');
    const first = await e.issue(requester, {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-1',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorized: true,
    });
    const duplicate = await e.issue(requester, {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-1',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorized: true,
    });
    expect(duplicate.id).toBe(first.id);
    const submitted = await e.submit(requester, first.id);
    expect(submitted).toMatchObject({ status: 'SUBMITTED', providerReference: 'prov-ref-1' });
    const settled = await e.refreshStatus(requester, first.id);
    expect(settled.status).toBe('SETTLED');
    await expect(e.reverse(requester, { id: first.id, reason: '' })).rejects.toThrow('REVERSAL_REASON_REQUIRED');
    expect((await e.reverse(requester, { id: first.id, reason: 'chargeback reported by provider' })).status).toBe('REVERSED');

    const rejecting = new PaymentExecutionEngine(s, {
      async submitPayment() {
        return { providerReference: '', status: 'REJECTED' };
      },
      async getStatus() {
        return { status: 'PENDING' };
      },
    });
    const toReject = await rejecting.issue(requester, {
      releaseRequestId: 'r2',
      providerKey: 'paystack',
      idempotencyKey: 'idem-2',
      beneficiaryReference: 'acct-2',
      amountMinor: 100_000_00,
      currency: 'NGN',
      authorized: true,
    });
    await expect(rejecting.submit(requester, toReject.id)).rejects.toThrow('PROVIDER_REJECTED_PAYMENT');
  });
});

describe('Engine 48 Reconciliation & Financial Ledger', () => {
  it('appends ledger entries and flags amount mismatches as reconciliation exceptions', async () => {
    const s = new InMemoryTrustStore();
    const e = new ReconciliationLedgerEngine(s);
    await e.record(requester, {
      paymentInstructionId: 'pi',
      entryType: 'DEBIT',
      amountMinor: 425_000_000,
      currency: 'NGN',
      description: 'escrow debit for milestone payout',
    });
    const matched = await e.reconcile(requester, {
      paymentInstructionId: 'pi',
      providerStatementReference: 'stmt-1',
      providerReportedAmountMinor: 425_000_000,
      recordedAmountMinor: 425_000_000,
    });
    expect(matched.matched).toBe(true);
    const mismatched = await e.reconcile(requester, {
      paymentInstructionId: 'pi2',
      providerStatementReference: 'stmt-2',
      providerReportedAmountMinor: 400_000_000,
      recordedAmountMinor: 425_000_000,
    });
    expect(mismatched).toMatchObject({ matched: false, exceptionReason: 'AMOUNT_MISMATCH' });
    expect(await e.exceptions(requester)).toHaveLength(1);
  });
});

describe('Engine 49 Dispute, Claim & Appeal Resolution', () => {
  it('freezes the release request the moment a dispute is raised and only releases the hold on close', async () => {
    const s = new InMemoryTrustStore();
    const e = new DisputeResolutionEngine(s);
    const dispute = await e.raise(requester, {
      releaseRequestId: 'r',
      kind: 'PAYMENT_DISPUTE',
      description: 'beneficiary disputes the settled amount',
    });
    expect(await e.isHeld(requester, 'r')).toBe(true);
    await e.submitEvidence(requester, { disputeId: dispute.id, reference: 'secure://evidence', description: 'signed delivery note' });
    await e.submitPosition(requester, { disputeId: dispute.id, partyId: 'payee', position: 'amount was short by 5%' });
    await expect(e.appeal(requester, { disputeId: dispute.id, reason: 'too early' })).rejects.toThrow('DISPUTE_NOT_DECIDED');
    await e.decide(requester, { disputeId: dispute.id, decision: 'PARTIAL', rationale: 'partial shortfall confirmed' });
    await e.appeal(requester, { disputeId: dispute.id, reason: 'payee disagrees with partial finding' });
    expect((await e.close(requester, dispute.id)).status).toBe('CLOSED');
    expect(await e.isHeld(requester, 'r')).toBe(false);
  });
});

describe('Engine 50 Final Settlement & Financial Closure', () => {
  it('rejects over-settlement, requires a zero outstanding balance and no open disputes to close, and issues one certificate', async () => {
    const s = new InMemoryTrustStore();
    const e = new FinalSettlementEngine(s);
    await expect(e.account(requester, {
        milestoneId: 'm',
        totalEntitlementAmountMinor: 400_000_000,
        totalSettledAmountMinor: 425_000_000,
        currency: 'NGN',
      })).rejects.toThrow('OVER_SETTLEMENT');
    const account = await e.account(requester, {
      milestoneId: 'm',
      totalEntitlementAmountMinor: 425_000_000,
      totalSettledAmountMinor: 400_000_000,
      currency: 'NGN',
    });
    await expect(e.close(requester, { id: account.id, noOpenDisputes: true })).rejects.toThrow('OUTSTANDING_BALANCE_UNRESOLVED');
    const settledAccount = await e.account(requester, {
      milestoneId: 'm2',
      totalEntitlementAmountMinor: 425_000_000,
      totalSettledAmountMinor: 425_000_000,
      currency: 'NGN',
    });
    await expect(e.close(requester, { id: settledAccount.id, noOpenDisputes: false })).rejects.toThrow(
      'OPEN_DISPUTES_UNRESOLVED',
    );
    const closed = await e.close(requester, { id: settledAccount.id, noOpenDisputes: true });
    expect(closed.status).toBe('CLOSED');
    const certificate = await e.issueCertificate(requester, closed.id);
    expect(certificate.status).toBe('ISSUED');
    await expect(e.issueCertificate(requester, closed.id)).rejects.toThrow('CLOSURE_CERTIFICATE_ALREADY_ISSUED');
  });
});
