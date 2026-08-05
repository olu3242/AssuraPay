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
  it('is only eligible when the certificate is certified and the trigger is eligible, and prefixes trigger blockers', async () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentEligibilityEngine(s);
    const revoked = await e.assess(c, {
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
    const eligible = await e.assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    expect(eligible).toMatchObject({ eligible: true, blockers: [] });
    expect((await e.latest(c, 'm'))?.id).toBe(eligible.id);
  });
});

describe('Engine 42 Financial Entitlement', () => {
  it('requires an eligible assessment, rejects non-integer amounts and a negative net payable, and locks on confirm', async () => {
    const s = new InMemoryTrustStore();
    const eligibility = await new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const e = new FinancialEntitlementEngine(s);
    await expect(await e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100.5,
        variationsAmountMinor: 0,
        retentionAmountMinor: 0,
        taxAmountMinor: 0,
        penaltyAmountMinor: 0,
      })).rejects.toThrow('MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    await expect(await e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100_000_00,
        variationsAmountMinor: 0,
        retentionAmountMinor: 0,
        taxAmountMinor: 0,
        penaltyAmountMinor: 200_000_00,
      })).rejects.toThrow('NEGATIVE_NET_PAYABLE');
    await expect(await e.calculate(c, {
        milestoneId: 'm',
        paymentEligibilityId: eligibility.id,
        currency: 'NGN',
        grossEarnedAmountMinor: 100_000_00,
        variationsAmountMinor: 0,
        retentionAmountMinor: -1,
        taxAmountMinor: 0,
        penaltyAmountMinor: 0,
      })).rejects.toThrow('RETENTIONAMOUNTMINOR_MUST_BE_NON_NEGATIVE_INTEGER_MINOR_UNITS');
    const entitlement = await e.calculate(c, {
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
    expect((await e.confirm(c, entitlement.id)).status).toBe('CONFIRMED');
    await expect(await e.confirm(c, entitlement.id)).rejects.toThrow('IMMUTABLE');
  });
});

describe('Engine 43 Invoice & Claim Management', () => {
  it('requires a confirmed entitlement, rejects duplicates, auto-matches on exact amount and gates approval on matching', async () => {
    const s = new InMemoryTrustStore();
    const eligibility = await new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const entitlementEngine = new FinancialEntitlementEngine(s);
    const entitlement = await entitlementEngine.calculate(c, {
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
    await expect(await e.submit(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceNumber: 'INV-001',
        amountMinor: 425_000_000,
        currency: 'NGN',
      })).rejects.toThrow('ENTITLEMENT_NOT_CONFIRMED');
    await entitlementEngine.confirm(c, entitlement.id);
    const unmatched = await e.submit(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-002',
      amountMinor: 400_000_000,
      currency: 'NGN',
    });
    expect(unmatched.status).toBe('SUBMITTED');
    await expect(await e.approve(c, unmatched.id)).rejects.toThrow('INVOICE_NOT_MATCHED');
    const matched = await e.submit(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceNumber: 'INV-001',
      amountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(matched.status).toBe('MATCHED');
    await expect(await e.submit(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceNumber: 'INV-001',
        amountMinor: 425_000_000,
        currency: 'NGN',
      })).rejects.toThrow('DUPLICATE_INVOICE');
    expect((await e.approve(c, matched.id)).status).toBe('APPROVED');
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
    await expect(await engine.recordCommitment(c, {
        milestoneId: 'm',
        providerKey: 'paystack',
        externalCustodyReference: '',
        committedAmountMinor: 425_000_000,
        currency: 'NGN',
      })).rejects.toThrow('EXTERNAL_CUSTODY_REFERENCE_REQUIRED');
    const commitment = await engine.recordCommitment(c, {
      milestoneId: 'm',
      providerKey: 'paystack',
      externalCustodyReference: 'paystack://escrow/abc123',
      committedAmountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(commitment.status).toBe('PENDING_CONFIRMATION');
    const confirmed = await engine.confirmCommitment(c, commitment.id);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', providerConfirmationReference: 'prov-ref-1' });
    const reservation = await engine.reserve(c, {
      fundingCommitmentId: confirmed.id,
      invoiceId: 'inv',
      reservedAmountMinor: 400_000_000,
    });
    await expect(await engine.reserve(c, { fundingCommitmentId: confirmed.id, invoiceId: 'inv2', reservedAmountMinor: 30_000_000 })).rejects.toThrow('INSUFFICIENT_COMMITTED_FUNDS');
    expect((await engine.releaseReservation(c, reservation.id)).status).toBe('RELEASED');
  });
});

describe('Engine 45 Conditional Release Orchestration', () => {
  it('validates a full release matches the entitlement, caps the request at reserved funds and re-evaluates conditions', async () => {
    const s = new InMemoryTrustStore();
    const eligibility = await new PaymentEligibilityEngine(s).assess(c, {
      milestoneId: 'm',
      completionCertificateId: 'cert',
      certificateStatus: 'CERTIFIED',
      paymentTriggerRuleId: 'rule',
      triggerEligible: true,
      triggerBlockers: [],
    });
    const entitlementEngine = new FinancialEntitlementEngine(s);
    const entitlement = await entitlementEngine.calculate(c, {
      milestoneId: 'm',
      paymentEligibilityId: eligibility.id,
      currency: 'NGN',
      grossEarnedAmountMinor: 425_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 0,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
    });
    await entitlementEngine.confirm(c, entitlement.id);
    const invoices = new InvoiceClaimEngine(s);
    const invoice = await invoices.submit(c, {
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
      (await funding.recordCommitment(c, {
        milestoneId: 'm',
        providerKey: 'paystack',
        externalCustodyReference: 'paystack://escrow/abc123',
        committedAmountMinor: 425_000_000,
        currency: 'NGN',
      })).id,
    );
    const reservation = await funding.reserve(c, {
      fundingCommitmentId: commitment.id,
      invoiceId: invoice.id,
      reservedAmountMinor: 425_000_000,
    });
    const e = new ConditionalReleaseOrchestrationEngine(s);
    await expect(await e.draft(c, {
        milestoneId: 'm',
        financialEntitlementId: entitlement.id,
        invoiceId: invoice.id,
        fundReservationId: reservation.id,
        releaseType: 'FULL',
        requestedAmountMinor: 400_000_000,
      })).rejects.toThrow('FULL_RELEASE_MUST_MATCH_ENTITLEMENT');
    const request = await e.draft(c, {
      milestoneId: 'm',
      financialEntitlementId: entitlement.id,
      invoiceId: invoice.id,
      fundReservationId: reservation.id,
      releaseType: 'FULL',
      requestedAmountMinor: 425_000_000,
    });
    const blocked = await e.evaluate(c, { id: request.id, paymentEligible: true });
    expect(blocked).toMatchObject({ status: 'BLOCKED', blockers: ['INVOICE_NOT_APPROVED'] });
    await invoices.approve(c, invoice.id);
    const conditionsMet = await e.evaluate(c, { id: request.id, paymentEligible: true });
    expect(conditionsMet.status).toBe('CONDITIONS_MET');
    await expect(await e.cancel(c, { id: request.id, reason: '' })).rejects.toThrow('CANCELLATION_REASON_REQUIRED');
    expect((await e.cancel(c, { id: request.id, reason: 'superseded by staged release' })).status).toBe('CANCELLED');
  });
});
