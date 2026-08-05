import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { PaymentExecutionEngine } from './index';

// CLAUDE.md hard constraint 1: "No custody, ever." Every PR touching money-movement
// logic must assert no code path calls a hold-funds primitive that isn't the
// external Financial Provider's own escrow/hold API. Engine 47 (Payment Execution
// & Treasury Integration) is the most custody-sensitive engine in the catalog —
// this suite verifies the constraint for `packages/settlement-execution`.

const c = {
  actorUserId: 'treasury-officer',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('non-custody constraint', () => {
  it('defines no local hold/custody/debit/credit/transfer/withdraw primitive of its own', () => {
    const source = readFileSync(resolve('packages/settlement-execution/src/index.ts'), 'utf8');
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

  it('never submits a payment without the provider gateway, and never asserts settlement without the gateway reporting it', async () => {
    const s = new InMemoryTrustStore();
    const noGateway = new PaymentExecutionEngine(s);
    const draft = await noGateway.issue(c, {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-1',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorized: true,
    });
    await expect(await noGateway.submit(c, draft.id)).rejects.toThrow('PAYMENT_PROVIDER_GATEWAY_REQUIRED');
    expect(
      (await s.list<{ id: string; status: string }>('paymentInstructions')).find((x) => x.id === draft.id)?.status,
    ).toBe('DRAFT');

    const rejectingGateway = new PaymentExecutionEngine(s, {
      async submitPayment() {
        return { providerReference: '', status: 'REJECTED' as const };
      },
      async getStatus() {
        return { status: 'PENDING' as const };
      },
    });
    await expect(await rejectingGateway.submit(c, draft.id)).rejects.toThrow('PROVIDER_REJECTED_PAYMENT');
    expect(
      (await s.list<{ id: string; status: string }>('paymentInstructions')).find((x) => x.id === draft.id)?.status,
    ).toBe('FAILED');
  });

  it('is idempotent on issue, so retrying a release never double-instructs the provider', async () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentExecutionEngine(s);
    const input = {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-shared',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorized: true,
    };
    const first = await e.issue(c, input);
    const second = await e.issue(c, input);
    expect(second.id).toBe(first.id);
    expect(await s.list('paymentInstructions')).toHaveLength(1);
  });
});
