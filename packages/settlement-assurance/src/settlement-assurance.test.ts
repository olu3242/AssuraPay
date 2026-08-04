import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ConditionalReleaseOrchestrationEngine,
  EscrowFundingAssuranceEngine,
  FinancialEntitlementEngine,
  InvoiceClaimEngine,
  PaymentEligibilityEngine,
} from './index';

const c = {
  actorUserId: 'finance-officer',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 41 Payment Eligibility', () => {
  it('is only eligible when the certificate is certified and the trigger is eligible, and prefixes trigger blockers', () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentEligibilityEngine(s);
    const revoked = e.assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'REVOKED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: false,
      triggerBlockers: ['ACCEPTANCE_CRITERIA_NOT_MET'],
    });
    expect(revoked).toMatchObject({
      eligible: false,
      blockers: ['CERTIFICATE_NOT_CERTIFIED', 'TRIGGER:ACCEPTANCE_CRITERIA_NOT_MET'],
    });
    const eligible = e.assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    expect(eligible).toMatchObject({ eligible: true, blockers: [] });
    expect(e.latest(c, 'm')?.id).toBe(eligible.id);
  });
});

describe('Engine 42 Financial Entitlement', () => {
  it('requires an eligible assessment, rejects non-integer amounts and a negative net payable, and locks on confirm', () => {
    const s = new InMemoryTrustStore();
    const eligibility = new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const e = new FinancialEntitlementEngine(s);
    expect(() =>
      e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100.5,
        variationsAmountMinor: 0,
        retentionAmountMinor: 0,
        taxAmountMinor: 0,
        penaltyAmountMinor: 0,
      }),
    ).toThrow('MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    expect(() =>
      e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100_000_00,
        variationsAmountMinor: 0,
        retentionAmountMinor: 0,
        taxAmountMinor: 0,
        penaltyAmountMinor: 200_000_00,
      }),
    ).toThrow('NEGATIVE_NET_PAYABLE');
    expect(() =>
      e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100_000_00,
        variationsAmountMinor: 0,
        retentionAmountMinor: -1,
        taxAmountMinor: 0,
        penaltyAmountMinor: 0,
      }),
    ).toThrow('RETENTIONAMOUNTMINOR_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    const entitlement = e.calculate(c, {
      milestoneId: 'm',
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossEarnedAmountMinor: 425_000_000,
      variationsAmountMinor: 10_000_00,
      retentionAmountMinor: 20_000_00,
      taxAmountMinor: 5_000_00,
      penaltyAmountMinor: 0,
    });
    expect(entitlement.netPayableAmountMinor).toBe(425_000_000 + 10_000_00 - 20_000_00 - 5_000_00);
    expect(e.confirm(c, entitlement.id).status).toBe('CONFIRMED');
    expect(() => e.confirm(c, entitlement.id)).toThrow('IMMUTABLE');
  });
});

describe('Engine 43 Invoice & Claim Management', () => {
  it('requires a confirmed entitlement, rejects duplicates, auto-matches on exact amount and gates approval on matching', () => {
    const s = new InMemoryTrustStore();
    const eligibility = new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const entitlementEngine = new FinancialEntitlementEngine(s);
    const entitlement = entitlementEngine.calculate(c, {
      milestoneId: 'm',
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossEarnedAmountMinor: 425_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 0,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
    });
    const e = new InvoiceClaimEngine(s);
    expect(() =>
      e.submit(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceNumber: 'INV-001',
        amountMinor: 425_000_000,
        currency: 'NGN',
      }),
    ).toThrow('ENTITLEMENT_NOT_CONFIRMED');
    entitlementEngine.confirm(c, entitlement.id);
    const unmatched = e.submit(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-002',
      amountMinor: 400_000_000,
      currency: 'NGN',
    });
    expect(unmatched.status).toBe('SUBMITTED');
    expect(() => e.approve(c, unmatched.id)).toThrow('INVOICE_NOT_MATCHED');
    const matched = e.submit(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-001',
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(matched.status).toBe('MATCHED');
    expect(() =>
      e.submit(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceNumber: 'INV-001',
        amountMinor: 425_000_000,
        currency: 'NGN',
      }),
    ).toThrow('DUPLICATE_INVOICE');
    expect(e.approve(c, matched.id).status).toBe('APPROVED');
  });
});

describe('Engine 44 Escrow & Funding Assurance', () => {
  it('confirms funding only through the provider gateway and caps reservations at the committed amount', async () => {
    const s = new InMemoryTrustStore();
    const engine = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding() {
        return { confirmed: true, providerConfirmationReference: 'prov-ref-1' };
      },
    });
    expect(() =>
      engine.recordCommitment(c, {
        milestoneId: 'm',
        providerKey: 'paystack',
        externalCustodyReference: '',
        committedAmountMinor: 425_000_000,
        currency: 'NGN',
      }),
    ).toThrow('EXTERNAL_CUSTODY_REFERENCE_REQUIRED');
    const commitment = engine.recordCommitment(c, {
      milestoneId: 'm',
      providerKey: 'paystack',
      externalCustodyReference: 'paystack://escrow/abc123',
      committedAmountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(commitment.status).toBe('PENDING_CONFIRMATION');
    const confirmed = await engine.confirmCommitment(c, commitment.id);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', providerConfirmationReference: 'prov-ref-1' });
    const reservation = engine.reserve(c, {
      fundingCommitmentId: confirmed.id,
      invoiceId: 'inv',
      reservedAmountMinor: 400_000_000,
    });
    expect(() =>
      engine.reserve(c, { fundingCommitmentId: confirmed.id, invoiceId: 'inv2', reservedAmountMinor: 30_000_000 }),
    ).toThrow('INSUFFICIENT_COMMITTED_FUNDS');
    expect(engine.releaseReservation(c, reservation.id).status).toBe('RELEASED');
  });
});

describe('Engine 45 Conditional Release Orchestration', () => {
  it('validates a full release matches the entitlement, caps the request at reserved funds and re-evaluates conditions', async () => {
    const s = new InMemoryTrustStore();
    const eligibility = new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const entitlementEngine = new FinancialEntitlementEngine(s);
    const entitlement = entitlementEngine.calculate(c, {
      milestoneId: 'm',
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossEarnedAmountMinor: 425_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 0,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
    });
    entitlementEngine.confirm(c, entitlement.id);
    const invoices = new InvoiceClaimEngine(s);
    const invoice = invoices.submit(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-001',
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    const funding = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding() {
        return { confirmed: true, providerConfirmationReference: 'prov-ref-1' };
      },
    });
    const commitment = await funding.confirmCommitment(
      c,
      funding.recordCommitment(c, {
        milestoneId: 'm',
        providerKey: 'paystack',
        externalCustodyReference: 'paystack://escrow/abc123',
        committedAmountMinor: 425_000_000,
        currency: 'NGN',
      }).id,
    );
    const reservation = funding.reserve(c, {
      fundingCommitmentId: commitment.id,
      invoiceId: invoice.id,
      reservedAmountMinor: 425_000_000,
    });
    const e = new ConditionalReleaseOrchestrationEngine(s);
    expect(() =>
      e.draft(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceId: invoice.id,
        fundReservationId: reservation.id,
        releaseType: 'FULL',
        requestedAmountMinor: 400_000_000,
      }),
    ).toThrow('FULL_RELEASE_MUST_MATCH_ENTITLEMENT');
    const request = e.draft(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceId: invoice.id,
      fundReservationId: reservation.id,
      releaseType: 'FULL',
      requestedAmountMinor: 425_000_000,
    });
    const blocked = e.evaluate(c, { id: request.id, paymentEligible: true });
    expect(blocked).toMatchObject({ status: 'BLOCKED', blockers: ['INVOICE_NOT_APPROVED'] });
    invoices.approve(c, invoice.id);
    const conditionsMet = e.evaluate(c, { id: request.id, paymentEligible: true });
    expect(conditionsMet.status).toBe('CONDITIONS_MET');
    expect(() => e.cancel(c, { id: request.id, reason: '' })).toThrow('CANCELLATION_REASON_REQUIRED');
    expect(e.cancel(c, { id: request.id, reason: 'superseded by staged release' }).status).toBe('CANCELLED');
  });
});
