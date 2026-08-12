import { describe, expect, it } from 'vitest';
import { paymentInstructionSchema, reconciliationRecordSchema } from './batch-c';

/**
 * The two fields `202608110003` added, tested where they are declared.
 *
 * `docs/persistence/WAVE_5_BATCH_C_ACTIVATION.md` recorded both as gaps that "need a change to a
 * domain type, and this capability is persistence". The domain types changed, so these are the rules
 * the schemas now carry — and they belong in this package because the schema is the thing under test,
 * not the engine that fills it in.
 */

const stamp = '2026-08-11T09:00:00.000Z';

describe('the payload digest a drifted retry is compared against', () => {
  const instruction = {
    id: 'pi-1',
    workspaceId: 'ws-1',
    releaseRequestId: 'rr-1',
    providerKey: 'partner-bank',
    idempotencyKey: 'idem-0001',
    payloadDigest: 'a3f1c9d2e4b6',
    beneficiaryReference: 'BENEF-77',
    amountMinor: 925_000,
    currency: 'NGN',
    status: 'DRAFT' as const,
    attempts: 0,
    createdAt: stamp,
  };

  it('is required and non-blank', () => {
    // MONETARY_INVARIANTS: reusing a key with a different semantic payload must fail, and "a key alone
    // cannot detect it". A blank digest compares equal to nothing and unequal to everything.
    expect(paymentInstructionSchema.safeParse(instruction).success).toBe(true);
    for (const payloadDigest of ['', '   ']) {
      expect(
        paymentInstructionSchema.safeParse({ ...instruction, payloadDigest }).success,
        JSON.stringify(payloadDigest),
      ).toBe(false);
    }
    const { payloadDigest: _absent, ...withoutDigest } = instruction;
    expect(paymentInstructionSchema.safeParse(withoutDigest).success).toBe(false);
  });
});

describe('the currency a reconciliation compares its amounts in', () => {
  const record = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    paymentInstructionId: 'pi-1',
    providerStatementReference: 'stmt-2026-08',
    currency: 'NGN',
    providerReportedAmountMinor: 925_000,
    recordedAmountMinor: 925_000,
    matched: true,
    reconciledAt: stamp,
  };

  it('is required, and from the governed set', () => {
    // Two money amounts and no unit was the gap. Nothing was wrong in practice — the amounts are only
    // compared to each other — but without the column the key to the instruction could not carry
    // currency, so a reconciliation could name an instruction in a currency it never stated.
    expect(reconciliationRecordSchema.safeParse(record).success).toBe(true);
    const { currency: _absent, ...withoutCurrency } = record;
    expect(reconciliationRecordSchema.safeParse(withoutCurrency).success).toBe(false);
    for (const currency of ['GBP', 'ngn', '']) {
      expect(
        reconciliationRecordSchema.safeParse({ ...record, currency }).success,
        currency,
      ).toBe(false);
    }
  });
});
