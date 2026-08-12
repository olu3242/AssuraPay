import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  finalSettlementAccountSchema,
  financialClosureCertificateSchema,
  ledgerEntrySchema,
  paymentInstructionSchema,
  reconciliationRecordSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  FinalSettlementAccount,
  FinancialClosureCertificate,
  LedgerEntry,
  PaymentInstruction,
  ReconciliationRecord,
} from './index';

/**
 * Compile-time proof that this package's Batch C domain types and their canonical Zod schemas
 * describe the same shape, plus the rules those schemas enforce.
 *
 * Journal balance is deliberately **not** tested here, because it cannot be: it is a property of a
 * set of postings, so no single-record schema can express it. It is enforced by the deferred
 * constraint trigger `202608110001` adds, and proved against a live database in
 * `packages/database-testing/src/wave5-batch-c-repository.postgres.test.ts`. A cross-row invariant
 * asserted only in a unit test would be asserted in the one place it cannot hold — the same reason
 * segregation of duties is absent from the Batch B file beside this one.
 */

export const paymentInstructionSchemaConforms: SchemaMatchesType<
  z.infer<typeof paymentInstructionSchema>,
  PaymentInstruction
> = true;

export const ledgerEntrySchemaConforms: SchemaMatchesType<
  z.infer<typeof ledgerEntrySchema>,
  LedgerEntry
> = true;

export const reconciliationRecordSchemaConforms: SchemaMatchesType<
  z.infer<typeof reconciliationRecordSchema>,
  ReconciliationRecord
> = true;

export const finalSettlementAccountSchemaConforms: SchemaMatchesType<
  z.infer<typeof finalSettlementAccountSchema>,
  FinalSettlementAccount
> = true;

export const financialClosureCertificateSchemaConforms: SchemaMatchesType<
  z.infer<typeof financialClosureCertificateSchema>,
  FinancialClosureCertificate
> = true;

const stamp = '2026-08-11T09:00:00.000Z';

describe('the payment-instruction schema holds its money and retry rules', () => {
  const instruction = {
    id: 'pi-1',
    workspaceId: 'ws-1',
    releaseRequestId: 'rr-1',
    providerKey: 'partner-bank',
    idempotencyKey: 'idem-0001',
    beneficiaryReference: 'BENEF-77',
    amountMinor: 925_000,
    currency: 'NGN',
    status: 'DRAFT' as const,
    attempts: 0,
    createdAt: stamp,
  };

  it('accepts a draft with no attempts and a settled one carrying its timestamps', () => {
    expect(paymentInstructionSchema.safeParse(instruction).success).toBe(true);
    expect(
      paymentInstructionSchema.safeParse({
        ...instruction,
        status: 'SETTLED',
        providerReference: 'PROV-1',
        attempts: 1,
        submittedAt: stamp,
        settledAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('permits zero attempts but refuses a negative or fractional count', () => {
    // Zero is the correct value for an instruction that has never been submitted; a counter that can
    // go backwards is a counter that can hide a retry.
    for (const attempts of [-1, 1.5]) {
      expect(
        paymentInstructionSchema.safeParse({ ...instruction, attempts }).success,
        String(attempts),
      ).toBe(false);
    }
  });

  it('refuses a zero amount, an unsupported currency and a blank idempotency key', () => {
    expect(paymentInstructionSchema.safeParse({ ...instruction, amountMinor: 0 }).success).toBe(
      false,
    );
    expect(paymentInstructionSchema.safeParse({ ...instruction, currency: 'EUR' }).success).toBe(
      false,
    );
    expect(paymentInstructionSchema.safeParse({ ...instruction, idempotencyKey: '  ' }).success).toBe(
      false,
    );
  });
});

describe('the ledger-entry schema keeps a posting positive and named', () => {
  const entry = {
    id: 'le-1',
    workspaceId: 'ws-1',
    paymentInstructionId: 'pi-1',
    entryType: 'DEBIT' as const,
    amountMinor: 925_000,
    currency: 'NGN',
    description: 'partner bank escrow release for milestone payout',
    recordedAt: stamp,
  };

  it('accepts both sides of a posting', () => {
    expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...entry, id: 'le-2', entryType: 'CREDIT' }).success).toBe(
      true,
    );
  });

  it('refuses a negative or zero amount', () => {
    // A refund is a compensating posting on the other side, never a negated original —
    // MONETARY_INVARIANTS names that a prohibited shortcut, so a signed amount must not parse.
    for (const amountMinor of [-925_000, 0]) {
      expect(ledgerEntrySchema.safeParse({ ...entry, amountMinor }).success, String(amountMinor)).toBe(
        false,
      );
    }
  });

  it('refuses an entry type outside double entry, and a blank description', () => {
    expect(ledgerEntrySchema.safeParse({ ...entry, entryType: 'ADJUSTMENT' }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...entry, description: '   ' }).success).toBe(false);
  });
});

describe('the reconciliation schema derives its outcome rather than accepting it', () => {
  const matched = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    paymentInstructionId: 'pi-1',
    providerStatementReference: 'stmt-2026-08',
    providerReportedAmountMinor: 925_000,
    recordedAmountMinor: 925_000,
    matched: true,
    reconciledAt: stamp,
  };

  it('accepts a match, and a mismatch that names its exception', () => {
    expect(reconciliationRecordSchema.safeParse(matched).success).toBe(true);
    expect(
      reconciliationRecordSchema.safeParse({
        ...matched,
        providerReportedAmountMinor: 900_000,
        matched: false,
        exceptionReason: 'AMOUNT_MISMATCH',
      }).success,
    ).toBe(true);
  });

  it('refuses a claimed match its own amounts contradict', () => {
    // Reconciliation outcomes must be reproducible from the persisted record. A record asserting a
    // match against differing amounts is not reproducible — it is an assertion about itself.
    expect(
      reconciliationRecordSchema.safeParse({ ...matched, providerReportedAmountMinor: 900_000 })
        .success,
    ).toBe(false);
    expect(reconciliationRecordSchema.safeParse({ ...matched, matched: false }).success).toBe(false);
  });

  it('refuses an unmatched record with no exception reason, and negative amounts', () => {
    expect(
      reconciliationRecordSchema.safeParse({
        ...matched,
        providerReportedAmountMinor: 900_000,
        matched: false,
      }).success,
    ).toBe(false);
    expect(
      reconciliationRecordSchema.safeParse({ ...matched, providerReportedAmountMinor: -1 }).success,
    ).toBe(false);
  });
});

describe('the closure schemas keep settlement arithmetic and evidence honest', () => {
  const account = {
    id: 'fsa-1',
    workspaceId: 'ws-1',
    milestoneId: 'ms-1',
    totalEntitlementAmountMinor: 1_000_000,
    totalSettledAmountMinor: 400_000,
    outstandingAmountMinor: 600_000,
    currency: 'NGN',
    status: 'DRAFT' as const,
    createdAt: stamp,
  };

  it('accepts an open account and a fully settled closed one', () => {
    expect(finalSettlementAccountSchema.safeParse(account).success).toBe(true);
    expect(
      finalSettlementAccountSchema.safeParse({
        ...account,
        totalSettledAmountMinor: 1_000_000,
        outstandingAmountMinor: 0,
        status: 'CLOSED',
        closedAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses an outstanding balance that does not follow from its parts', () => {
    expect(
      finalSettlementAccountSchema.safeParse({ ...account, outstandingAmountMinor: 700_000 })
        .success,
    ).toBe(false);
    // Over-settlement would make outstanding negative, which the arithmetic and the bound both
    // refuse.
    expect(
      finalSettlementAccountSchema.safeParse({
        ...account,
        totalSettledAmountMinor: 1_400_000,
        outstandingAmountMinor: -400_000,
      }).success,
    ).toBe(false);
  });

  it('refuses a closure with no time, and a time with no closure', () => {
    expect(
      finalSettlementAccountSchema.safeParse({
        ...account,
        totalSettledAmountMinor: 1_000_000,
        outstandingAmountMinor: 0,
        status: 'CLOSED',
      }).success,
    ).toBe(false);
    expect(finalSettlementAccountSchema.safeParse({ ...account, closedAt: stamp }).success).toBe(
      false,
    );
  });

  it('requires a closure certificate to carry its hash and its account', () => {
    const certificate = {
      id: 'fcc-1',
      workspaceId: 'ws-1',
      milestoneId: 'ms-1',
      finalSettlementAccountId: 'fsa-1',
      canonicalHash: 'a3f1c9',
      status: 'ISSUED' as const,
      issuedBy: 'u-closer',
      issuedAt: stamp,
    };
    expect(financialClosureCertificateSchema.safeParse(certificate).success).toBe(true);
    expect(
      financialClosureCertificateSchema.safeParse({ ...certificate, canonicalHash: '' }).success,
    ).toBe(false);
    expect(
      financialClosureCertificateSchema.safeParse({ ...certificate, finalSettlementAccountId: '' })
        .success,
    ).toBe(false);
    expect(
      financialClosureCertificateSchema.safeParse({ ...certificate, status: 'SUPERSEDED' }).success,
    ).toBe(false);
  });
});
