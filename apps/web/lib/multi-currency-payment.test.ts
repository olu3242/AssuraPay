import { describe, expect, it } from 'vitest';
import { governPaymentIssueRequest } from './multi-currency-payment';

const base = {
  releaseRequestId: 'release-1',
  providerKey: 'provider-a',
  idempotencyKey: 'idem-1',
  beneficiaryReference: 'beneficiary-1',
  amountMinor: 10_000,
  currency: 'USD',
  authorized: true,
};

const authorizedUsdNgnQuote = {
  id: 'fx-1',
  status: 'AUTHORIZED',
  providerId: 'provider-a',
  sourceAmountMinor: 10_000,
  sourceCurrency: 'USD',
  targetAmountMinor: 15_000_000,
  targetCurrency: 'NGN',
  rateNumerator: '1500',
  rateDenominator: '1',
  expiresAt: '2026-09-07T22:00:00.000Z',
};

describe('governPaymentIssueRequest', () => {
  it('preserves the existing same-currency payment path', () => {
    const result = governPaymentIssueRequest(base, '2026-09-07T20:00:00.000Z');
    expect(result.paymentInput.amountMinor).toBe(10_000);
    expect(result.paymentInput.currency).toBe('USD');
    expect(result.currencyRoute).toMatchObject({
      sourceCurrency: 'USD',
      settlementCurrency: 'USD',
      fxRequired: false,
    });
  });

  it('converts the payment instruction only with a matching authorized quote', () => {
    const result = governPaymentIssueRequest(
      {
        ...base,
        settlementCurrency: 'NGN',
        fxQuote: authorizedUsdNgnQuote,
      },
      '2026-09-07T20:00:00.000Z',
    );
    expect(result.paymentInput.amountMinor).toBe(15_000_000);
    expect(result.paymentInput.currency).toBe('NGN');
    expect(result.currencyRoute).toEqual({
      sourceAmountMinor: 10_000,
      sourceCurrency: 'USD',
      settlementAmountMinor: 15_000_000,
      settlementCurrency: 'NGN',
      fxRequired: true,
      fxQuoteId: 'fx-1',
    });
  });

  it('rejects cross-currency payments without an FX quote', () => {
    expect(() =>
      governPaymentIssueRequest(
        { ...base, settlementCurrency: 'NGN' },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('FX_AUTHORIZED_QUOTE_REQUIRED');
  });

  it('rejects unapproved, expired, provider-mismatched and tampered quotes', () => {
    expect(() =>
      governPaymentIssueRequest(
        {
          ...base,
          settlementCurrency: 'NGN',
          fxQuote: { ...authorizedUsdNgnQuote, status: 'ACCEPTED' },
        },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('FX_QUOTE_NOT_AUTHORIZED');

    expect(() =>
      governPaymentIssueRequest(
        {
          ...base,
          settlementCurrency: 'NGN',
          fxQuote: { ...authorizedUsdNgnQuote, expiresAt: '2026-09-07T19:59:59.000Z' },
        },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('FX_QUOTE_EXPIRED');

    expect(() =>
      governPaymentIssueRequest(
        {
          ...base,
          settlementCurrency: 'NGN',
          fxQuote: { ...authorizedUsdNgnQuote, providerId: 'provider-b' },
        },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('FX_PROVIDER_MISMATCH');

    expect(() =>
      governPaymentIssueRequest(
        {
          ...base,
          settlementCurrency: 'NGN',
          fxQuote: { ...authorizedUsdNgnQuote, targetAmountMinor: 15_000_001 },
        },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('FX_QUOTED_TARGET_MISMATCH');
  });

  it('rejects unsupported currencies and unsafe integer minor-unit payloads', () => {
    expect(() =>
      governPaymentIssueRequest({ ...base, currency: 'BTC' }, '2026-09-07T20:00:00.000Z'),
    ).toThrow('CURRENCY_UNSUPPORTED');

    expect(() =>
      governPaymentIssueRequest(
        { ...base, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
        '2026-09-07T20:00:00.000Z',
      ),
    ).toThrow('AMOUNT_MUST_BE_POSITIVE_SAFE_INTEGER_MINOR_UNITS');
  });
});
