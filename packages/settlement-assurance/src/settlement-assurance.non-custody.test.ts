import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { ConditionalReleaseOrchestrationEngine, EscrowFundingAssuranceEngine } from './index';

// CLAUDE.md hard constraint 1: "No custody, ever." Every PR touching money-movement
// logic must assert no code path calls a hold-funds primitive that isn't the
// external Financial Provider's own escrow/hold API. This suite verifies that
// constraint for `packages/settlement-assurance`.

const c = {
  actorUserId: 'finance-officer',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('non-custody constraint', () => {
  it('defines no local hold/custody/debit/credit/transfer primitive of its own', () => {
    const source = readFileSync(resolve('packages/settlement-assurance/src/index.ts'), 'utf8');
    for (const forbidden of [
      /\bholdFunds\s*\(/i,
      /\btakeCustody\s*\(/i,
      /\bdebitAccount\s*\(/i,
      /\bcreditAccount\s*\(/i,
      /\btransferFunds\s*\(/i,
      /\bpoolFunds\s*\(/i,
      /\bwithdraw\s*\(/i,
    ])
      expect(source).not.toMatch(forbidden);
  });

  it('records only a reference to the external provider escrow, never a held balance', async () => {
    const s = new InMemoryTrustStore();
    const commitment = await new EscrowFundingAssuranceEngine(s).recordCommitment(c, {
      milestoneId: 'm',
      providerKey: 'paystack',
      externalCustodyReference: 'paystack://escrow/abc123',
      committedAmountMinor: 425_000_000,
      currency: 'NGN',
    });
    expect(commitment).not.toHaveProperty('balance');
    expect(commitment).not.toHaveProperty('heldAmountMinor');
    expect(commitment.externalCustodyReference).toBe('paystack://escrow/abc123');
  });

  it('never transitions funding to confirmed without the provider gateway confirming it', async () => {
    const s = new InMemoryTrustStore();
    const commitment = await new EscrowFundingAssuranceEngine(s).recordCommitment(c, {
      milestoneId: 'm',
      providerKey: 'paystack',
      externalCustodyReference: 'paystack://escrow/abc123',
      committedAmountMinor: 425_000_000,
      currency: 'NGN',
    });
    await expect(new EscrowFundingAssuranceEngine(s).confirmCommitment(c, commitment.id)).rejects.toThrow(
      'EXTERNAL_CUSTODY_GATEWAY_REQUIRED',
    );
    const decliningGateway = { async confirmFunding() { return { confirmed: false, providerConfirmationReference: '' }; } };
    await expect(new EscrowFundingAssuranceEngine(s, decliningGateway).confirmCommitment(c, commitment.id)).rejects.toThrow(
      'PROVIDER_FUNDING_NOT_CONFIRMED',
    );
    expect((await s.list<{ id: string; status: string }>('fundingCommitments')).find((x) => x.id === commitment.id)?.status).toBe(
      'PENDING_CONFIRMATION',
    );
    const acceptingGateway = { async confirmFunding() { return { confirmed: true, providerConfirmationReference: 'prov-ref-1' }; } };
    const confirmed = await new EscrowFundingAssuranceEngine(s, acceptingGateway).confirmCommitment(c, commitment.id);
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('never lets release orchestration depend on a payment or provider gateway — it only evaluates and records conditions', () => {
    expect(ConditionalReleaseOrchestrationEngine.length).toBe(1);
  });

  it('reserves no more than the provider confirmed, so a reservation never claims funds nobody holds', async () => {
    // The non-custody reading of over-reservation. AssuraPay holds nothing, so a reservation is a
    // claim on money a licensed provider is holding. Reserving past the confirmed commitment claims
    // custody the platform does not have and the provider never granted — and the lie is only found
    // when the provider refuses a release a human has already approved.
    const s = new InMemoryTrustStore();
    const engine = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding() {
        return { confirmed: true, providerConfirmationReference: 'paystack://conf/1' };
      },
    });
    const commitment = await engine.confirmCommitment(
      c,
      (
        await engine.recordCommitment(c, {
          milestoneId: 'm',
          providerKey: 'paystack',
          externalCustodyReference: 'paystack://escrow/abc123',
          committedAmountMinor: 1_000_000,
          currency: 'NGN',
        })
      ).id,
    );

    await engine.reserve(c, {
      fundingCommitmentId: commitment.id,
      invoiceId: 'inv-1',
      reservedAmountMinor: 600_000,
    });
    await expect(
      engine.reserve(c, {
        fundingCommitmentId: commitment.id,
        invoiceId: 'inv-2',
        reservedAmountMinor: 600_000,
      }),
    ).rejects.toThrow('INSUFFICIENT_COMMITTED_FUNDS');
  });

  it('releases no more than was reserved, however many requests draw on the reservation', async () => {
    // The non-custody reading of over-release, and the one that actually moves money. A reservation
    // is a claim on funds a provider holds; nothing in the platform marks it consumed, so without an
    // aggregate check one reservation can back release after release. Each request looks affordable
    // against the reservation's total and the sum is what the provider is asked to pay.
    const s = new InMemoryTrustStore();
    const funding = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding() {
        return { confirmed: true, providerConfirmationReference: 'paystack://conf/2' };
      },
    });
    const commitment = await funding.confirmCommitment(
      c,
      (
        await funding.recordCommitment(c, {
          milestoneId: 'm',
          providerKey: 'paystack',
          externalCustodyReference: 'paystack://escrow/def456',
          committedAmountMinor: 1_000_000,
          currency: 'NGN',
        })
      ).id,
    );
    const reservation = await funding.reserve(c, {
      fundingCommitmentId: commitment.id,
      invoiceId: 'inv-1',
      reservedAmountMinor: 1_000_000,
    });

    // `draft` reads the entitlement and the invoice it is drawn against, so both must exist. The
    // amounts here only have to let a PARTIAL release through: FULL is the type that must equal the
    // entitlement exactly, and this test is about the reservation, not that rule.
    await s.append('financialEntitlements', {
      id: 'fe-1',
      workspaceId: 'w',
      milestoneId: 'm',
      paymentEligibilityId: 'pe-1',
      currency: 'NGN',
      grossEarnedAmountMinor: 1_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 0,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
      netPayableAmountMinor: 1_000_000,
      status: 'CONFIRMED',
      calculatedAt: '2026-01-01T00:00:00.000Z',
    });
    await s.append('invoices', {
      id: 'inv-1',
      workspaceId: 'w',
      milestoneId: 'm',
      financialEntitlementId: 'fe-1',
      invoiceNumber: 'INV-1',
      amountMinor: 1_000_000,
      currency: 'NGN',
      status: 'APPROVED',
      submittedBy: 'finance-officer',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const releases = new ConditionalReleaseOrchestrationEngine(s);
    const draft = (amount: number) =>
      releases.draft(c, {
        milestoneId: 'm',
        financialEntitlementId: 'fe-1',
        invoiceId: 'inv-1',
        fundReservationId: reservation.id,
        releaseType: 'PARTIAL',
        requestedAmountMinor: amount,
      });

    // Each of these fits the reservation on its own. Together they do not.
    await draft(600_000);
    await expect(draft(600_000)).rejects.toThrow('RELEASES_EXCEED_RESERVED_FUNDS');
    // And the room that remains is still usable, so the rule constrains the total and not the count.
    await draft(400_000);
  });

  it('will not pay an invoice out of funds reserved for a different one', async () => {
    // Non-custody again, and the least visible version of it. Drawing on another invoice's
    // reservation does not overspend any single total, so every amount check passes — the platform
    // simply takes custodied funds earmarked for one obligation and settles another with them. The
    // invoice that was raided still reports itself funded, so the shortfall appears later, at a
    // release with no obvious connection to the one that caused it.
    const s = new InMemoryTrustStore();
    const funding = new EscrowFundingAssuranceEngine(s, {
      async confirmFunding() {
        return { confirmed: true, providerConfirmationReference: 'paystack://conf/3' };
      },
    });
    const commitment = await funding.confirmCommitment(
      c,
      (
        await funding.recordCommitment(c, {
          milestoneId: 'm',
          providerKey: 'paystack',
          externalCustodyReference: 'paystack://escrow/ghi789',
          committedAmountMinor: 1_000_000,
          currency: 'NGN',
        })
      ).id,
    );
    // Reserved for inv-other, deliberately.
    const reservation = await funding.reserve(c, {
      fundingCommitmentId: commitment.id,
      invoiceId: 'inv-other',
      reservedAmountMinor: 500_000,
    });

    for (const id of ['inv-1', 'inv-other'])
      await s.append('invoices', {
        id,
        workspaceId: 'w',
        milestoneId: 'm',
        financialEntitlementId: 'fe-1',
        invoiceNumber: `INV-${id}`,
        amountMinor: 500_000,
        currency: 'NGN',
        status: 'APPROVED',
        submittedBy: 'finance-officer',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    await s.append('financialEntitlements', {
      id: 'fe-1',
      workspaceId: 'w',
      milestoneId: 'm',
      paymentEligibilityId: 'pe-1',
      currency: 'NGN',
      grossEarnedAmountMinor: 500_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 0,
      taxAmountMinor: 0,
      penaltyAmountMinor: 0,
      netPayableAmountMinor: 500_000,
      status: 'CONFIRMED',
      calculatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      new ConditionalReleaseOrchestrationEngine(s).draft(c, {
        milestoneId: 'm',
        financialEntitlementId: 'fe-1',
        invoiceId: 'inv-1',
        fundReservationId: reservation.id,
        releaseType: 'PARTIAL',
        requestedAmountMinor: 100_000,
      }),
    ).rejects.toThrow('RESERVATION_BELONGS_TO_ANOTHER_INVOICE');
  });

  it('does not treat its own arithmetic as the control that stops over-reservation', () => {
    // The check in `reserve` is a read-then-write: two concurrent callers both read the same total
    // and both pass it. So the constraint lives in the database, and this asserts the source says so
    // rather than leaving a later reader to assume the TypeScript is the guarantee.
    // `docs/finance/MONETARY_INVARIANTS.md` forbids enforcing a monetary invariant only in
    // TypeScript; the durable proof is the raced pair in `wave5-batch-c-repository.postgres.test.ts`.
    const source = readFileSync(resolve('packages/settlement-assurance/src/index.ts'), 'utf8');
    expect(source).toContain('fund_reservations_within_commitment');
    expect(source).toContain('202608110023');
  });
});
