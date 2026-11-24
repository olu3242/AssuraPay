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
