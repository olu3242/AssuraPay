import { describe, expect, it } from 'vitest';
import {
  CurrencyRegistry,
  ForeignExchangeService,
  ProviderCurrencyRouter,
  convertForReporting,
  convertMoney,
  exactRate,
  reconcileFxSettlement,
  sumSameCurrency,
  type ProviderCurrencyCapability,
} from './index';

describe('CurrencyRegistry', () => {
  const registry = new CurrencyRegistry();

  it('returns governed precision for 0, 2 and 3 decimal currencies', () => {
    expect(registry.getMinorUnitExponent('JPY')).toBe(0);
    expect(registry.getMinorUnitExponent('USD')).toBe(2);
    expect(registry.getMinorUnitExponent('NGN')).toBe(2);
    expect(registry.getMinorUnitExponent('BHD')).toBe(3);
  });

  it('rejects unsupported currencies and negative base amounts', () => {
    expect(() => registry.getCurrency('BTC')).toThrow('CURRENCY_UNSUPPORTED');
    expect(() => registry.validateMoney({ amountMinor: -1n, currency: 'USD' })).toThrow('MONEY_NEGATIVE_BASE_AMOUNT');
  });
});

describe('exact conversion', () => {
  it('converts same-exponent currencies without floating point', () => {
    const source = { amountMinor: 10_000n, currency: 'USD' as const };
    const result = convertMoney(source, 'NGN', exactRate(150_055n, 100n));
    expect(result.target).toEqual({ amountMinor: 15_005_500n, currency: 'NGN' });
  });

  it('scales correctly across different minor-unit exponents', () => {
    expect(
      convertMoney({ amountMinor: 100n, currency: 'USD' }, 'JPY', exactRate(150n, 1n)).target,
    ).toEqual({ amountMinor: 150n, currency: 'JPY' });

    expect(
      convertMoney({ amountMinor: 1n, currency: 'JPY' }, 'BHD', exactRate(1n, 100n)).target,
    ).toEqual({ amountMinor: 10n, currency: 'BHD' });
  });

  it('honors DOWN versus HALF_UP at the target minor-unit boundary', () => {
    const source = { amountMinor: 100n, currency: 'USD' as const };
    const rate = exactRate(1n, 2n);
    expect(convertMoney(source, 'JPY', rate, 'DOWN').target.amountMinor).toBe(0n);
    expect(convertMoney(source, 'JPY', rate, 'HALF_UP').target.amountMinor).toBe(1n);
  });

  it('requires identity rate for same-currency bypass', () => {
    const source = { amountMinor: 10_000n, currency: 'USD' as const };
    expect(convertMoney(source, 'USD', exactRate(1n, 1n)).target.amountMinor).toBe(10_000n);
    expect(() => convertMoney(source, 'USD', exactRate(2n, 1n))).toThrow('FX_SAME_CURRENCY_RATE_MUST_BE_ONE');
  });

  it('refuses direct mixed-currency totals', () => {
    expect(() => sumSameCurrency([
      { amountMinor: 100n, currency: 'USD' },
      { amountMinor: 100n, currency: 'NGN' },
    ])).toThrow('CROSS_CURRENCY_SUM_REQUIRES_CONVERSION');
  });
});

describe('ForeignExchangeService', () => {
  const service = new ForeignExchangeService();
  const quotedAt = '2026-09-07T13:00:00.000Z';
  const expiresAt = '2026-09-07T13:05:00.000Z';

  const quote = (roundingMode: 'HALF_UP' | 'DOWN' = 'HALF_UP') => service.quote({
    id: 'fxq-1',
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    providerId: 'provider-1',
    source: { amountMinor: 25_000_00n, currency: 'USD' },
    targetCurrency: 'NGN',
    rate: exactRate(160_000n, 100n),
    rateSource: 'provider-1',
    observedAt: quotedAt,
    expiresAt,
    idempotencyKey: 'release-1-fx',
    semanticDigest: 'digest-1',
    roundingMode,
    fees: [
      { kind: 'PROVIDER_FEE', amount: { amountMinor: 500n, currency: 'USD' }, chargedBy: 'provider-1' },
      { kind: 'ASSURAPAY_FEE', amount: { amountMinor: 250n, currency: 'USD' }, chargedBy: 'assurapay' },
    ],
  });

  it('enforces quote lifecycle and maker-checker authorization', () => {
    const accepted = service.accept(quote(), 'buyer-1', '2026-09-07T13:01:00.000Z');
    expect(accepted.status).toBe('ACCEPTED');
    expect(() => service.authorize(accepted, 'buyer-1')).toThrow('FX_SEGREGATION_OF_DUTIES_REQUIRED');
    const authorized = service.authorize(accepted, 'treasury-approver-1');
    const instructed = service.instruct(authorized, 'fxc-1');
    const confirmed = service.confirm(instructed, 'bank-ref-123', '2026-09-07T13:03:00.000Z');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.providerReference).toBe('bank-ref-123');
    expect(confirmed.fees).toHaveLength(2);
  });

  it('preserves quote rounding provenance into the conversion', () => {
    const accepted = service.accept(quote('DOWN'), 'buyer-1', '2026-09-07T13:01:00.000Z');
    const authorized = service.authorize(accepted, 'treasury-approver-1');
    const instructed = service.instruct(authorized, 'fxc-down');
    expect(instructed.roundingMode).toBe('DOWN');
  });

  it('expires stale quotes rather than silently accepting them', () => {
    const expired = service.accept(quote(), 'buyer-1', '2026-09-07T13:06:00.000Z');
    expect(expired.status).toBe('EXPIRED');
  });
});

describe('cross-currency reconciliation', () => {
  it('matches currency-qualified provider settlement exactly', () => {
    const result = reconcileFxSettlement({
      expectedSource: { amountMinor: 10_000n, currency: 'USD' },
      actualSource: { amountMinor: 10_000n, currency: 'USD' },
      expectedTarget: { amountMinor: 16_000_000n, currency: 'NGN' },
      actualTarget: { amountMinor: 16_000_000n, currency: 'NGN' },
    });
    expect(result.matched).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('flags wrong currency and amount variance instead of certifying it', () => {
    const wrongCurrency = reconcileFxSettlement({
      expectedSource: { amountMinor: 10_000n, currency: 'USD' },
      actualSource: { amountMinor: 10_000n, currency: 'USD' },
      expectedTarget: { amountMinor: 16_000_000n, currency: 'NGN' },
      actualTarget: { amountMinor: 16_000_000n, currency: 'GHS' },
    });
    expect(wrongCurrency.matched).toBe(false);
    expect(wrongCurrency.mismatches).toContain('TARGET_CURRENCY_MISMATCH');

    const variance = reconcileFxSettlement({
      expectedSource: { amountMinor: 10_000n, currency: 'USD' },
      actualSource: { amountMinor: 10_000n, currency: 'USD' },
      expectedTarget: { amountMinor: 16_000_000n, currency: 'NGN' },
      actualTarget: { amountMinor: 15_999_000n, currency: 'NGN' },
    });
    expect(variance.matched).toBe(false);
    expect(variance.targetVarianceMinor).toBe(-1_000n);
  });
});

describe('reporting currency', () => {
  it('preserves source fact and historical rate provenance', () => {
    const result = convertForReporting({
      source: { amountMinor: 10_000n, currency: 'USD' },
      reportingCurrency: 'NGN',
      rate: exactRate(160_000n, 100n),
      rateSource: 'historical-provider-snapshot',
      rateDate: '2026-09-07',
      policy: 'TRANSACTION_DATE',
    });
    expect(result.source).toEqual({ amountMinor: 10_000n, currency: 'USD' });
    expect(result.reporting.currency).toBe('NGN');
    expect(result.rateDate).toBe('2026-09-07');
  });
});

describe('ProviderCurrencyRouter', () => {
  const providers: ProviderCurrencyCapability[] = [
    {
      providerId: 'provider-a',
      supportedSourceCurrencies: ['USD', 'NGN'],
      supportedDestinationCurrencies: ['USD', 'NGN'],
      supportedPairs: ['USD/NGN', 'NGN/USD'],
      settlementRails: ['BANK'],
      supportsFx: true,
      quoteCapability: true,
    },
    {
      providerId: 'provider-b',
      supportedSourceCurrencies: ['USD', 'NGN'],
      supportedDestinationCurrencies: ['USD', 'NGN'],
      supportedPairs: ['USD/NGN'],
      settlementRails: ['BANK'],
      supportsFx: true,
      quoteCapability: false,
    },
  ];

  it('routes cross-currency payment only to a provider that can quote and execute FX', () => {
    const selected = new ProviderCurrencyRouter().select({
      sourceCurrency: 'USD',
      destinationCurrency: 'NGN',
      requiredRail: 'BANK',
      providers,
    });
    expect(selected.providerId).toBe('provider-a');
  });

  it('allows same-currency routing without FX quote capability', () => {
    const sameCurrencyOnly: ProviderCurrencyCapability[] = [{
      providerId: 'provider-b',
      supportedSourceCurrencies: ['USD'],
      supportedDestinationCurrencies: ['USD'],
      supportedPairs: [],
      settlementRails: ['BANK'],
      supportsFx: false,
      quoteCapability: false,
    }];
    const selected = new ProviderCurrencyRouter().select({
      sourceCurrency: 'USD',
      destinationCurrency: 'USD',
      requiredRail: 'BANK',
      providers: sameCurrencyOnly,
    });
    expect(selected.providerId).toBe('provider-b');
  });
});
