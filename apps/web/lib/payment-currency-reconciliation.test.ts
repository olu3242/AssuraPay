import { describe, expect, it } from 'vitest';
import { reconcilePaymentCurrencyRoute } from './payment-currency-reconciliation';

const route = {
  paymentInstructionId: 'payment-1',
  releaseRequestId: 'release-1',
  providerKey: 'provider-a',
  sourceAmountMinor: 10_000,
  sourceCurrency: 'USD',
  settlementAmountMinor: 15_000_000,
  settlementCurrency: 'NGN',
  fxRequired: true,
  fxQuoteId: 'fx-1',
};

describe('reconcilePaymentCurrencyRoute', () => {
  it('matches provider settlement against the persisted source→settlement route', () => {
    const result = reconcilePaymentCurrencyRoute(route, {
      sourceAmountMinor: 10_000,
      sourceCurrency: 'USD',
      settlementAmountMinor: 15_000_000,
      settlementCurrency: 'NGN',
    });
    expect(result.matched).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('surfaces amount and currency mismatches without rewriting expected facts', () => {
    const amountMismatch = reconcilePaymentCurrencyRoute(route, {
      sourceAmountMinor: 10_000,
      sourceCurrency: 'USD',
      settlementAmountMinor: 14_999_999,
      settlementCurrency: 'NGN',
    });
    expect(amountMismatch.matched).toBe(false);
    expect(amountMismatch.mismatches).toContain('TARGET_AMOUNT_MISMATCH');
    expect(amountMismatch.targetVarianceMinor).toBe(-1n);

    const currencyMismatch = reconcilePaymentCurrencyRoute(route, {
      sourceAmountMinor: 10_000,
      sourceCurrency: 'USD',
      settlementAmountMinor: 15_000_000,
      settlementCurrency: 'GHS',
    });
    expect(currencyMismatch.matched).toBe(false);
    expect(currencyMismatch.mismatches).toContain('TARGET_CURRENCY_MISMATCH');
  });
});
