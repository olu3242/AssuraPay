export type CurrencyCode =
  | 'USD'
  | 'CAD'
  | 'GBP'
  | 'EUR'
  | 'NGN'
  | 'GHS'
  | 'KES'
  | 'ZAR'
  | 'JPY'
  | 'BHD';

export type CurrencyDefinition = {
  code: CurrencyCode;
  exponent: 0 | 2 | 3;
  status: 'ACTIVE' | 'RESTRICTED' | 'INACTIVE';
  symbol: string;
  name: string;
};

export type Money = Readonly<{
  amountMinor: bigint;
  currency: CurrencyCode;
}>;

const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyDefinition>> = Object.freeze({
  USD: { code: 'USD', exponent: 2, status: 'ACTIVE', symbol: '$', name: 'US Dollar' },
  CAD: { code: 'CAD', exponent: 2, status: 'ACTIVE', symbol: '$', name: 'Canadian Dollar' },
  GBP: { code: 'GBP', exponent: 2, status: 'ACTIVE', symbol: '£', name: 'Pound Sterling' },
  EUR: { code: 'EUR', exponent: 2, status: 'ACTIVE', symbol: '€', name: 'Euro' },
  NGN: { code: 'NGN', exponent: 2, status: 'ACTIVE', symbol: '₦', name: 'Nigerian Naira' },
  GHS: { code: 'GHS', exponent: 2, status: 'ACTIVE', symbol: '₵', name: 'Ghanaian Cedi' },
  KES: { code: 'KES', exponent: 2, status: 'ACTIVE', symbol: 'KSh', name: 'Kenyan Shilling' },
  ZAR: { code: 'ZAR', exponent: 2, status: 'ACTIVE', symbol: 'R', name: 'South African Rand' },
  JPY: { code: 'JPY', exponent: 0, status: 'ACTIVE', symbol: '¥', name: 'Japanese Yen' },
  BHD: { code: 'BHD', exponent: 3, status: 'ACTIVE', symbol: 'BD', name: 'Bahraini Dinar' },
});

export class CurrencyRegistry {
  listSupportedCurrencies(): CurrencyDefinition[] {
    return Object.values(CURRENCIES).filter((currency) => currency.status === 'ACTIVE');
  }

  getCurrency(code: string): CurrencyDefinition {
    const currency = CURRENCIES[code as CurrencyCode];
    if (!currency || currency.status !== 'ACTIVE') throw new Error('CURRENCY_UNSUPPORTED');
    return currency;
  }

  getMinorUnitExponent(code: string): number {
    return this.getCurrency(code).exponent;
  }

  validateMoney(input: { amountMinor: bigint; currency: string }): Money {
    const currency = this.getCurrency(input.currency).code;
    if (input.amountMinor < 0n) throw new Error('MONEY_NEGATIVE_BASE_AMOUNT');
    return Object.freeze({ amountMinor: input.amountMinor, currency });
  }
}

export type ExactRate = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

export function exactRate(numerator: bigint, denominator: bigint): ExactRate {
  if (numerator <= 0n || denominator <= 0n) throw new Error('FX_RATE_INVALID');
  return Object.freeze({ numerator, denominator });
}

export type RoundingMode = 'HALF_UP' | 'DOWN';

export type ConversionResult = Readonly<{
  source: Money;
  target: Money;
  rate: ExactRate;
  roundingMode: RoundingMode;
  remainderNumerator: bigint;
  scaledDenominator: bigint;
}>;

const registry = new CurrencyRegistry();
const pow10 = (exponent: number) => 10n ** BigInt(exponent);

export function convertMoney(
  source: Money,
  targetCurrency: CurrencyCode,
  rate: ExactRate,
  roundingMode: RoundingMode = 'HALF_UP',
): ConversionResult {
  const sourceExponent = registry.getMinorUnitExponent(source.currency);
  const targetExponent = registry.getMinorUnitExponent(targetCurrency);

  if (source.currency === targetCurrency) {
    if (rate.numerator !== rate.denominator) throw new Error('FX_SAME_CURRENCY_RATE_MUST_BE_ONE');
    return Object.freeze({
      source,
      target: Object.freeze({ amountMinor: source.amountMinor, currency: targetCurrency }),
      rate,
      roundingMode,
      remainderNumerator: 0n,
      scaledDenominator: 1n,
    });
  }

  // FX rates are quoted in major currency units. Canonical money is stored in minor units,
  // so convert source minor -> source major conceptually, apply the exact rate, then scale
  // to target minor units. Keeping the powers of ten inside the rational avoids floats.
  const rawNumerator = source.amountMinor * rate.numerator * pow10(targetExponent);
  const scaledDenominator = rate.denominator * pow10(sourceExponent);
  const quotient = rawNumerator / scaledDenominator;
  const remainder = rawNumerator % scaledDenominator;
  const rounded = roundingMode === 'HALF_UP' && remainder * 2n >= scaledDenominator
    ? quotient + 1n
    : quotient;

  return Object.freeze({
    source,
    target: Object.freeze({ amountMinor: rounded, currency: targetCurrency }),
    rate,
    roundingMode,
    remainderNumerator: remainder,
    scaledDenominator,
  });
}

export type FxFeeKind = 'PROVIDER_FEE' | 'FX_SPREAD' | 'ASSURAPAY_FEE' | 'TAX_OR_LEVY';

export type FxFee = Readonly<{
  kind: FxFeeKind;
  amount: Money;
  chargedBy: string;
}>;

export type FxQuoteStatus = 'QUOTED' | 'ACCEPTED' | 'AUTHORIZED' | 'EXPIRED' | 'REJECTED';

export type FxQuote = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string;
  providerId: string;
  source: Money;
  target: Money;
  rate: ExactRate;
  rateSource: string;
  observedAt: string;
  expiresAt: string;
  roundingMode: RoundingMode;
  status: FxQuoteStatus;
  idempotencyKey: string;
  semanticDigest: string;
  fees: readonly FxFee[];
  acceptedBy?: string;
  authorizedBy?: string;
}>;

export type FxConversionStatus = 'INSTRUCTED' | 'CONFIRMED' | 'FAILED' | 'REVERSED';

export type FxConversion = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string;
  quoteId: string;
  providerId: string;
  source: Money;
  target: Money;
  rate: ExactRate;
  rateSource: string;
  rateTimestamp: string;
  roundingMode: RoundingMode;
  fees: readonly FxFee[];
  status: FxConversionStatus;
  providerReference?: string;
  confirmedAt?: string;
}>;

export class ForeignExchangeService {
  quote(
    input: Omit<FxQuote, 'target' | 'status' | 'fees' | 'roundingMode'> & {
      targetCurrency: CurrencyCode;
      roundingMode?: RoundingMode;
      fees?: readonly FxFee[];
    },
  ): FxQuote {
    if (new Date(input.expiresAt).getTime() <= new Date(input.observedAt).getTime())
      throw new Error('FX_QUOTE_EXPIRY_INVALID');
    const roundingMode = input.roundingMode ?? 'HALF_UP';
    const conversion = convertMoney(input.source, input.targetCurrency, input.rate, roundingMode);
    for (const fee of input.fees ?? []) {
      if (fee.amount.amountMinor < 0n) throw new Error('FX_FEE_NEGATIVE');
    }
    return Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      source: input.source,
      target: conversion.target,
      rate: input.rate,
      rateSource: input.rateSource,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      roundingMode,
      status: 'QUOTED',
      idempotencyKey: input.idempotencyKey,
      semanticDigest: input.semanticDigest,
      fees: Object.freeze([...(input.fees ?? [])]),
    });
  }

  accept(quote: FxQuote, actorId: string, at = new Date().toISOString()): FxQuote {
    if (quote.status !== 'QUOTED') throw new Error('FX_QUOTE_NOT_ACCEPTABLE');
    if (new Date(at).getTime() >= new Date(quote.expiresAt).getTime())
      return Object.freeze({ ...quote, status: 'EXPIRED' });
    return Object.freeze({ ...quote, status: 'ACCEPTED', acceptedBy: actorId });
  }

  authorize(quote: FxQuote, actorId: string): FxQuote {
    if (quote.status !== 'ACCEPTED') throw new Error('FX_QUOTE_NOT_AUTHORIZABLE');
    if (quote.acceptedBy === actorId) throw new Error('FX_SEGREGATION_OF_DUTIES_REQUIRED');
    return Object.freeze({ ...quote, status: 'AUTHORIZED', authorizedBy: actorId });
  }

  instruct(quote: FxQuote, conversionId: string): FxConversion {
    if (quote.status !== 'AUTHORIZED') throw new Error('FX_QUOTE_NOT_AUTHORIZED');
    return Object.freeze({
      id: conversionId,
      tenantId: quote.tenantId,
      workspaceId: quote.workspaceId,
      quoteId: quote.id,
      providerId: quote.providerId,
      source: quote.source,
      target: quote.target,
      rate: quote.rate,
      rateSource: quote.rateSource,
      rateTimestamp: quote.observedAt,
      roundingMode: quote.roundingMode,
      fees: quote.fees,
      status: 'INSTRUCTED',
    });
  }

  confirm(
    conversion: FxConversion,
    providerReference: string,
    confirmedAt = new Date().toISOString(),
  ): FxConversion {
    if (conversion.status !== 'INSTRUCTED') throw new Error('FX_CONVERSION_NOT_CONFIRMABLE');
    if (!providerReference.trim()) throw new Error('FX_PROVIDER_REFERENCE_REQUIRED');
    return Object.freeze({ ...conversion, status: 'CONFIRMED', providerReference, confirmedAt });
  }
}

export type CurrencyPair = `${CurrencyCode}/${CurrencyCode}`;

export type ProviderCurrencyCapability = Readonly<{
  providerId: string;
  supportedSourceCurrencies: readonly CurrencyCode[];
  supportedDestinationCurrencies: readonly CurrencyCode[];
  supportedPairs: readonly CurrencyPair[];
  settlementRails: readonly string[];
  supportsFx: boolean;
  quoteCapability: boolean;
}>;

export class ProviderCurrencyRouter {
  select(input: {
    sourceCurrency: CurrencyCode;
    destinationCurrency: CurrencyCode;
    requiredRail?: string;
    providers: readonly ProviderCurrencyCapability[];
  }): ProviderCurrencyCapability {
    const pair = `${input.sourceCurrency}/${input.destinationCurrency}` as CurrencyPair;
    const sameCurrency = input.sourceCurrency === input.destinationCurrency;
    const candidates = input.providers.filter((provider) => {
      const sourceSupported = provider.supportedSourceCurrencies.includes(input.sourceCurrency);
      const destinationSupported = provider.supportedDestinationCurrencies.includes(input.destinationCurrency);
      const pairSupported = sameCurrency || provider.supportedPairs.includes(pair);
      const fxSupported = sameCurrency || provider.supportsFx;
      const quoteSupported = sameCurrency || provider.quoteCapability;
      const railSupported = !input.requiredRail || provider.settlementRails.includes(input.requiredRail);
      return sourceSupported && destinationSupported && pairSupported && fxSupported && quoteSupported && railSupported;
    });
    if (candidates.length === 0) throw new Error('FX_PROVIDER_CAPABILITY_NOT_FOUND');
    return [...candidates].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
  }
}

export type ReconciliationMismatch =
  | 'SOURCE_CURRENCY_MISMATCH'
  | 'SOURCE_AMOUNT_MISMATCH'
  | 'TARGET_CURRENCY_MISMATCH'
  | 'TARGET_AMOUNT_MISMATCH';

export type FxReconciliationResult = Readonly<{
  matched: boolean;
  mismatches: readonly ReconciliationMismatch[];
  expectedSource: Money;
  actualSource: Money;
  expectedTarget: Money;
  actualTarget: Money;
  targetVarianceMinor?: bigint;
}>;

export function reconcileFxSettlement(input: {
  expectedSource: Money;
  actualSource: Money;
  expectedTarget: Money;
  actualTarget: Money;
}): FxReconciliationResult {
  const mismatches: ReconciliationMismatch[] = [];
  if (input.expectedSource.currency !== input.actualSource.currency)
    mismatches.push('SOURCE_CURRENCY_MISMATCH');
  else if (input.expectedSource.amountMinor !== input.actualSource.amountMinor)
    mismatches.push('SOURCE_AMOUNT_MISMATCH');
  if (input.expectedTarget.currency !== input.actualTarget.currency)
    mismatches.push('TARGET_CURRENCY_MISMATCH');
  else if (input.expectedTarget.amountMinor !== input.actualTarget.amountMinor)
    mismatches.push('TARGET_AMOUNT_MISMATCH');

  return Object.freeze({
    matched: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
    expectedSource: input.expectedSource,
    actualSource: input.actualSource,
    expectedTarget: input.expectedTarget,
    actualTarget: input.actualTarget,
    targetVarianceMinor:
      input.expectedTarget.currency === input.actualTarget.currency
        ? input.actualTarget.amountMinor - input.expectedTarget.amountMinor
        : undefined,
  });
}

export type ReportingRatePolicy =
  | 'TRANSACTION_DATE'
  | 'SETTLEMENT_DATE'
  | 'PERIOD_END'
  | 'PERIOD_AVERAGE';

export type ReportingConversion = Readonly<{
  source: Money;
  reporting: Money;
  rate: ExactRate;
  rateSource: string;
  rateDate: string;
  policy: ReportingRatePolicy;
}>;

export function convertForReporting(input: {
  source: Money;
  reportingCurrency: CurrencyCode;
  rate: ExactRate;
  rateSource: string;
  rateDate: string;
  policy: ReportingRatePolicy;
}): ReportingConversion {
  if (!input.rateSource.trim() || !input.rateDate.trim())
    throw new Error('REPORTING_RATE_PROVENANCE_REQUIRED');
  const result = convertMoney(input.source, input.reportingCurrency, input.rate);
  return Object.freeze({
    source: input.source,
    reporting: result.target,
    rate: input.rate,
    rateSource: input.rateSource,
    rateDate: input.rateDate,
    policy: input.policy,
  });
}

export type MultiCurrencyObligation = Readonly<{
  id: string;
  amounts: readonly Money[];
}>;

export function sumSameCurrency(amounts: readonly Money[]): Money {
  if (amounts.length === 0) throw new Error('MONEY_SUM_EMPTY');
  const currency = amounts[0].currency;
  if (amounts.some((money) => money.currency !== currency))
    throw new Error('CROSS_CURRENCY_SUM_REQUIRES_CONVERSION');
  return Object.freeze({
    currency,
    amountMinor: amounts.reduce((sum, money) => sum + money.amountMinor, 0n),
  });
}
