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

  it('records only a reference to the external provider escrow, never a held balance', () => {
    const s = new InMemoryTrustStore();
    const commitment = new EscrowFundingAssuranceEngine(s).recordCommitment(c, {
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
    const commitment = new EscrowFundingAssuranceEngine(s).recordCommitment(c, {
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
    expect(s.list<{ id: string; status: string }>('fundingCommitments').find((x) => x.id === commitment.id)?.status).toBe(
      'PENDING_CONFIRMATION',
    );
    const acceptingGateway = { async confirmFunding() { return { confirmed: true, providerConfirmationReference: 'prov-ref-1' }; } };
    const confirmed = await new EscrowFundingAssuranceEngine(s, acceptingGateway).confirmCommitment(c, commitment.id);
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('never lets release orchestration depend on a payment or provider gateway — it only evaluates and records conditions', () => {
    expect(ConditionalReleaseOrchestrationEngine.length).toBe(1);
  });
});
