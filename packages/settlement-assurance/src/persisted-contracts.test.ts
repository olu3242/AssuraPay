import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  financialEntitlementSchema,
  invoiceSchema,
  paymentEligibilitySchema,
  releaseRequestSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  FinancialEntitlement,
  Invoice,
  PaymentEligibility,
  ReleaseRequest,
} from './index';

/**
 * Compile-time proof that this package's exported domain types and their canonical Zod schemas
 * describe the same shape, plus the monetary rules those schemas enforce.
 *
 * Batch B is the first batch carrying money, so the schemas narrow *values* considerably —
 * positive base amounts, non-negative deductions, a governed currency set — while leaving the
 * *types* untouched. That distinction is what makes the assertions below hold: `currency` is
 * declared `string` in the domain type, and `currencyCode` is `z.string().refine(...)` rather than
 * `z.enum([...])` precisely so the inferred type stays `string`. An enum would infer
 * `'NGN' | 'USD'`, the identity check would fail, and the fix would have been to change a published
 * contract as a side effect of adding validation.
 *
 * The proofs live in a test file because `apps/web/tsconfig.json` compiles with `strict: false`,
 * and without `strictNullChecks` zod's `addQuestionMarks` treats every key as optional — see
 * `packages/execution-orchestration/src/persisted-contracts.test.ts` for the full account.
 */

export const paymentEligibilitySchemaConforms: SchemaMatchesType<
  z.infer<typeof paymentEligibilitySchema>,
  PaymentEligibility
> = true;

export const financialEntitlementSchemaConforms: SchemaMatchesType<
  z.infer<typeof financialEntitlementSchema>,
  FinancialEntitlement
> = true;

export const invoiceSchemaConforms: SchemaMatchesType<z.infer<typeof invoiceSchema>, Invoice> = true;

export const releaseRequestSchemaConforms: SchemaMatchesType<
  z.infer<typeof releaseRequestSchema>,
  ReleaseRequest
> = true;

const stamp = '2026-08-10T09:00:00.000Z';

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fe-1',
    workspaceId: 'ws-1',
    milestoneId: 'ms-1',
    paymentEligibilityId: 'pe-1',
    currency: 'NGN',
    grossEarnedAmountMinor: 1_000_000,
    variationsAmountMinor: 0,
    retentionAmountMinor: 50_000,
    taxAmountMinor: 25_000,
    penaltyAmountMinor: 0,
    netPayableAmountMinor: 925_000,
    status: 'DRAFT',
    calculatedAt: stamp,
    ...overrides,
  };
}

describe('the entitlement schema enforces the monetary invariants', () => {
  it('accepts a well-formed entitlement', () => {
    expect(financialEntitlementSchema.safeParse(entitlement()).success).toBe(true);
  });

  it('accepts a negative variation, because a variation is a delta and not a base amount', () => {
    // MONETARY_INVARIANTS constrains base contractual, claim, invoice, entitlement, funding,
    // release and payment amounts. A contract variation may legitimately reduce the entitlement.
    expect(
      financialEntitlementSchema.safeParse(
        entitlement({ variationsAmountMinor: -100_000, netPayableAmountMinor: 825_000 }),
      ).success,
    ).toBe(true);
  });

  it('refuses a negative deduction, which would inflate the net past the gross', () => {
    for (const field of ['retentionAmountMinor', 'taxAmountMinor', 'penaltyAmountMinor']) {
      const result = financialEntitlementSchema.safeParse(
        entitlement({ [field]: -1, netPayableAmountMinor: 925_001 }),
      );
      expect(result.success, field).toBe(false);
    }
  });

  it('refuses a zero or negative gross entitlement', () => {
    for (const grossEarnedAmountMinor of [0, -1]) {
      expect(
        financialEntitlementSchema.safeParse(
          entitlement({ grossEarnedAmountMinor, netPayableAmountMinor: 0 }),
        ).success,
        String(grossEarnedAmountMinor),
      ).toBe(false);
    }
  });

  it('refuses a net payable that does not follow from its parts', () => {
    // The same arithmetic `financial_entitlements_net_follows_from_parts` constrains. Both exist:
    // this refuses a record the application built wrong, the constraint refuses a direct write.
    expect(
      financialEntitlementSchema.safeParse(entitlement({ netPayableAmountMinor: 999_999 })).success,
    ).toBe(false);
  });

  it('refuses a negative net payable even when the arithmetic agrees', () => {
    expect(
      financialEntitlementSchema.safeParse(
        entitlement({ penaltyAmountMinor: 2_000_000, netPayableAmountMinor: -1_075_000 }),
      ).success,
    ).toBe(false);
  });

  it('refuses a fractional amount', () => {
    expect(
      financialEntitlementSchema.safeParse(
        entitlement({ grossEarnedAmountMinor: 1_000_000.5, netPayableAmountMinor: 925_000.5 }),
      ).success,
    ).toBe(false);
  });

  it('refuses a currency outside the governed set, and refuses none at all', () => {
    expect(financialEntitlementSchema.safeParse(entitlement({ currency: 'EUR' })).success).toBe(
      false,
    );
    expect(financialEntitlementSchema.safeParse(entitlement({ currency: 'ngn' })).success).toBe(
      false,
    );
    const { currency: _dropped, ...withoutCurrency } = entitlement();
    expect(financialEntitlementSchema.safeParse(withoutCurrency).success).toBe(false);
  });
});

describe('the claim and release schemas hold their own money rules', () => {
  it('requires a positive invoice amount and a governed currency', () => {
    const invoice = {
      id: 'inv-1',
      workspaceId: 'ws-1',
      milestoneId: 'ms-1',
      financialEntitlementId: 'fe-1',
      invoiceNumber: 'INV-0001',
      amountMinor: 925_000,
      currency: 'NGN',
      status: 'SUBMITTED' as const,
      submittedBy: 'u-1',
      createdAt: stamp,
    };
    expect(invoiceSchema.safeParse(invoice).success).toBe(true);
    expect(invoiceSchema.safeParse({ ...invoice, amountMinor: 0 }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...invoice, currency: 'GBP' }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...invoice, invoiceNumber: '  ' }).success).toBe(false);
  });

  it('requires a positive requested release and rejects an unknown release type', () => {
    const request = {
      id: 'rr-1',
      workspaceId: 'ws-1',
      milestoneId: 'ms-1',
      financialEntitlementId: 'fe-1',
      invoiceId: 'inv-1',
      fundReservationId: 'fr-1',
      releaseType: 'FULL' as const,
      requestedAmountMinor: 925_000,
      currency: 'NGN',
      status: 'DRAFT' as const,
      blockers: [],
      requestedBy: 'u-1',
      createdAt: stamp,
    };
    expect(releaseRequestSchema.safeParse(request).success).toBe(true);
    expect(releaseRequestSchema.safeParse({ ...request, requestedAmountMinor: -1 }).success).toBe(
      false,
    );
    expect(releaseRequestSchema.safeParse({ ...request, releaseType: 'INSTANT' }).success).toBe(
      false,
    );
    // A blocker nobody can name is a blocker nobody can clear.
    expect(releaseRequestSchema.safeParse({ ...request, blockers: [''] }).success).toBe(false);
  });

  it('refuses an unknown field on an eligibility rather than dropping it', () => {
    const eligibility = {
      id: 'pe-1',
      workspaceId: 'ws-1',
      milestoneId: 'ms-1',
      completionCertificateId: 'cert-1',
      paymentTriggerRuleId: 'ptr-1',
      eligible: true,
      blockers: [],
      evaluatedBy: 'u-1',
      evaluatedAt: stamp,
    };
    expect(paymentEligibilitySchema.safeParse(eligibility).success).toBe(true);
    expect(paymentEligibilitySchema.safeParse({ ...eligibility, override: true }).success).toBe(
      false,
    );
  });
});
