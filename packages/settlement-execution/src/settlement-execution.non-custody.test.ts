import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { PaymentExecutionEngine, ReconciliationLedgerEngine } from './index';

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

async function authorize(store: InMemoryTrustStore, releaseRequestId = 'r', amountMinor = 425_000_000) {
  await store.append('releaseRequests', {
    id: releaseRequestId, workspaceId: 'w', requestedAmountMinor: amountMinor, currency: 'NGN', status: 'CONDITIONS_MET',
  });
  const id = `auth-${releaseRequestId}`;
  await store.append('authorizationDecisions', {
    id, workspaceId: 'w', releaseRequestId, requestedBy: 'requester', amountMinor, currency: 'NGN',
    requiredApprovals: 1, status: 'AUTHORIZED', createdAt: '2026-08-12T12:00:00.000Z', authorizedAt: '2026-08-12T12:00:00.000Z',
  });
  return id;
}

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
    const authorizationDecisionId = await authorize(s);
    const noGateway = new PaymentExecutionEngine(s);
    const draft = await noGateway.issue(c, {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-1',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorizationDecisionId,
    });
    await expect(noGateway.submit(c, draft.id)).rejects.toThrow('PAYMENT_PROVIDER_GATEWAY_REQUIRED');
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
    await expect(rejectingGateway.submit(c, draft.id)).rejects.toThrow('PROVIDER_REJECTED_PAYMENT');
    expect(
      (await s.list<{ id: string; status: string }>('paymentInstructions')).find((x) => x.id === draft.id)?.status,
    ).toBe('FAILED');
  });

  it('is idempotent on issue, so retrying a release never double-instructs the provider', async () => {
    const s = new InMemoryTrustStore();
    const e = new PaymentExecutionEngine(s);
    const authorizationDecisionId = await authorize(s);
    const input = {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-shared',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorizationDecisionId,
    };
    const first = await e.issue(c, input);
    const second = await e.issue(c, input);
    expect(second.id).toBe(first.id);
    expect(await s.list('paymentInstructions')).toHaveLength(1);
  });

  it('refuses a repeated key whose payload has drifted, rather than returning the original', async () => {
    // MONETARY_INVARIANTS: "Reusing a key with a different semantic payload fails. This needs a stored
    // payload digest to compare against; a key alone cannot detect it." Before the digest existed,
    // `issue` returned the original for any repeat of the key — so a retry pointing at a different
    // beneficiary, or for a different amount, was silently accepted as the first one. Returning the
    // original discards the new intent; storing a second row double-instructs the provider. Refusing
    // is the only safe answer, and it is the one failure mode idempotency exists to prevent.
    const s = new InMemoryTrustStore();
    const e = new PaymentExecutionEngine(s);
    const authorizationDecisionId = await authorize(s);
    const input = {
      releaseRequestId: 'r',
      providerKey: 'paystack',
      idempotencyKey: 'idem-shared',
      beneficiaryReference: 'acct-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      authorizationDecisionId,
    };
    await e.issue(c, input);

    for (const drift of [
      { beneficiaryReference: 'acct-2' },
      { providerKey: 'flutterwave' },
    ]) {
      await expect(e.issue(c, { ...input, ...drift })).rejects.toThrow(
        'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      );
    }
    // And nothing was written on any of the refusals.
    expect(await s.list('paymentInstructions')).toHaveLength(1);
  });

  it('records a journal without a provider gateway, because a posting moves nothing', async () => {
    // Re-certifying the boundary for Batch C's new posting path. A balanced journal describes money
    // the provider moved; it is a record, not an instruction. The proof is that the ledger engine
    // takes no gateway at all — a record-keeping engine that could reach a provider would be a
    // second money-movement path, and the one in `PaymentExecutionEngine` is the only sanctioned
    // one.
    const s = new InMemoryTrustStore();
    const ledger = new ReconciliationLedgerEngine(s);
    expect(ReconciliationLedgerEngine.length).toBe(1);

    const journal = await ledger.post(c, {
      paymentInstructionId: 'pi-1',
      amountMinor: 425_000_000,
      currency: 'NGN',
      debitDescription: 'partner bank escrow release',
      creditDescription: 'beneficiary settlement',
    });

    // Both legs, one amount. Neither leg is negative, so a reversal must be its own compensating
    // journal rather than a negated original — the shortcut MONETARY_INVARIANTS prohibits.
    expect(journal.debit.amountMinor).toBe(425_000_000);
    expect(journal.credit.amountMinor).toBe(425_000_000);
    expect(await s.list('ledgerEntries')).toHaveLength(2);
  });

  it('posts both legs of a journal in one transaction, so the commit is all or nothing', async () => {
    // The balance rule is a deferred constraint trigger firing at COMMIT. If the legs reached the
    // database in separate transactions the first would commit unbalanced and be refused, so the
    // single transaction is load-bearing rather than an optimisation.
    const s = new InMemoryTrustStore();
    let transactions = 0;
    const counting: TrustPersistence = {
      list: s.list.bind(s),
      append: s.append.bind(s),
      replace: s.replace.bind(s),
      audit: s.audit.bind(s),
      emit: s.emit.bind(s),
      async transaction(operation) {
        transactions += 1;
        return await operation(counting);
      },
    };
    await new ReconciliationLedgerEngine(counting).post(c, {
      paymentInstructionId: 'pi-2',
      amountMinor: 1_000,
      currency: 'NGN',
      debitDescription: 'escrow release',
      creditDescription: 'beneficiary settlement',
    });
    expect(transactions).toBe(1);
    expect(await s.list('ledgerEntries')).toHaveLength(2);
  });
});
