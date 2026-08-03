import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ConditionalReleaseOrchestrationEngine,
  EscrowFundingAssuranceEngine,
  FinancialEntitlementEngine,
  InvoiceClaimEngine,
  PaymentEligibilityEngine,
} from './index';

describe('e2e Batch 9 certified milestone to a condition-met, non-custodial release request', () => {
  it('carries a certified completion through eligibility, entitlement, invoicing and provider-confirmed funding into a release request', async () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'finance-officer',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const eligibility = new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'erection-milestone',
      completionCertificateId: 'certificate',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'trigger',
      triggerEligible: true,
      triggerBlockers: [],
    });
    expect(eligibility.eligible).toBe(true);

    const entitlementEngine = new FinancialEntitlementEngine(s);
    const entitlement = entitlementEngine.calculate(c, {
      milestoneId: 'erection-milestone',
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossEarnedAmountMinor: 425_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 21_250_000,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
    });
    entitlementEngine.confirm(c, entitlement.id);

    const invoices = new InvoiceClaimEngine(s);
    const invoice = invoices.submit(c, {
      milestoneId: 'erection-milestone',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-2026-08421',
      amountMinor: entitlement.netPayableAmountMinor,
      currency: 'NGN',
    });
    expect(invoice.status).toBe('MATCHED');
    invoices.approve(c, invoice.id);

    const funding = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding(input) {
        return { confirmed: true, providerConfirmationReference: `bank-escrow-ref-${input.externalCustodyReference}` };
      },
    });
    const commitment = funding.recordCommitment(c, {
      milestoneId: 'erection-milestone',
      providerKey: 'partner-bank-escrow',
      externalCustodyReference: 'partner-bank://escrow/AP-2026-08421',
      committedAmountMinor: entitlement.netPayableAmountMinor,
      currency: 'NGN',
    });
    const confirmedCommitment = await funding.confirmCommitment(c, commitment.id);
    expect(confirmedCommitment.status).toBe('CONFIRMED');
    const reservation = funding.reserve(c, {
      fundingCommitmentId: confirmedCommitment.id,
      invoiceId: invoice.id,
      reservedAmountMinor: entitlement.netPayableAmountMinor,
    });

    const release = new ConditionalReleaseOrchestrationEngine(s);
    const request = release.draft(c, {
      milestoneId: 'erection-milestone',
      financialEntitlementId: entitlement.id,
      invoiceId: invoice.id,
      fundReservationId: reservation.id,
      releaseType: 'FULL',
      requestedAmountMinor: entitlement.netPayableAmountMinor,
    });
    const evaluated = release.evaluate(c, { id: request.id, paymentEligible: eligibility.eligible });
    expect(evaluated).toMatchObject({ status: 'CONDITIONS_MET', blockers: [] });
  });
});
