import {
  CurrencyRegistry,
  convertMoney,
  exactRate,
  type CurrencyCode,
} from '../../../packages/multi-currency/src';

export type PaymentIssueRequest = {
  releaseRequestId: string;
  providerKey: string;
  idempotencyKey: string;
  beneficiaryReference: string;
  amountMinor: number;
  currency: string;
  authorized: boolean;
  settlementCurrency?: string;
  fxQuote?: {
    id: string;
    status: string;
    providerId: string;
    sourceAmountMinor: number;
    sourceCurrency: string;
    targetAmountMinor: number;
    targetCurrency: string;
    rateNumerator: string;
    rateDenominator: string;
    expiresAt: string;
  };
};

export type GovernedPaymentIssue = {
  paymentInput: {
    releaseRequestId: string;
    providerKey: string;
    idempotencyKey: string;
    beneficiaryReference: string;
    amountMinor: number;
    currency: string;
    authorized: boolean;
  };
  currencyRoute: {
    sourceAmountMinor: number;
    sourceCurrency: CurrencyCode;
    settlementAmountMinor: number;
    settlementCurrency: CurrencyCode;
    fxRequired: boolean;
    fxQuoteId?: string;
  };
};

const registry = new CurrencyRegistry();

function requireSafePositiveMinor(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field}_MUST_BE_POSITIVE_SAFE_INTEGER_MINOR_UNITS`);
  }
  return value;
}

function currency(code: string): CurrencyCode {
  return registry.getCurrency(code).code;
}

/**
 * Governs the API boundary between a contractual/release amount and the amount
 * Engine 47 instructs a licensed provider to settle.
 *
 * Same-currency instructions preserve the existing path. Cross-currency
 * instructions fail closed unless the caller supplies an unexpired, AUTHORIZED
 * quote whose source, target and provider exactly match the payment request.
 * The quoted target is recomputed from the exact rational rate; caller-supplied
 * converted amounts are never trusted by themselves.
 */
export function governPaymentIssueRequest(
  input: PaymentIssueRequest,
  at = new Date().toISOString(),
): GovernedPaymentIssue {
  const sourceCurrency = currency(input.currency);
  const sourceAmountMinor = requireSafePositiveMinor(input.amountMinor, 'AMOUNT');
  const settlementCurrency = currency(input.settlementCurrency ?? sourceCurrency);

  if (settlementCurrency === sourceCurrency) {
    if (input.fxQuote) throw new Error('FX_QUOTE_NOT_ALLOWED_FOR_SAME_CURRENCY_PAYMENT');
    return {
      paymentInput: {
        releaseRequestId: input.releaseRequestId,
        providerKey: input.providerKey,
        idempotencyKey: input.idempotencyKey,
        beneficiaryReference: input.beneficiaryReference,
        amountMinor: sourceAmountMinor,
        currency: sourceCurrency,
        authorized: input.authorized,
      },
      currencyRoute: {
        sourceAmountMinor,
        sourceCurrency,
        settlementAmountMinor: sourceAmountMinor,
        settlementCurrency,
        fxRequired: false,
      },
    };
  }

  const quote = input.fxQuote;
  if (!quote) throw new Error('FX_AUTHORIZED_QUOTE_REQUIRED');
  if (quote.status !== 'AUTHORIZED') throw new Error('FX_QUOTE_NOT_AUTHORIZED');
  if (new Date(at).getTime() >= new Date(quote.expiresAt).getTime()) {
    throw new Error('FX_QUOTE_EXPIRED');
  }
  if (quote.providerId !== input.providerKey) throw new Error('FX_PROVIDER_MISMATCH');

  const quoteSourceCurrency = currency(quote.sourceCurrency);
  const quoteTargetCurrency = currency(quote.targetCurrency);
  const quoteSourceAmountMinor = requireSafePositiveMinor(
    quote.sourceAmountMinor,
    'FX_SOURCE_AMOUNT',
  );
  const quoteTargetAmountMinor = requireSafePositiveMinor(
    quote.targetAmountMinor,
    'FX_TARGET_AMOUNT',
  );

  if (
    quoteSourceCurrency !== sourceCurrency ||
    quoteSourceAmountMinor !== sourceAmountMinor
  ) {
    throw new Error('FX_SOURCE_MISMATCH');
  }
  if (quoteTargetCurrency !== settlementCurrency) {
    throw new Error('FX_TARGET_CURRENCY_MISMATCH');
  }

  let numerator: bigint;
  let denominator: bigint;
  try {
    numerator = BigInt(quote.rateNumerator);
    denominator = BigInt(quote.rateDenominator);
  } catch {
    throw new Error('FX_RATE_INVALID');
  }

  const recomputed = convertMoney(
    { amountMinor: BigInt(sourceAmountMinor), currency: sourceCurrency },
    settlementCurrency,
    exactRate(numerator, denominator),
  );
  if (recomputed.target.amountMinor !== BigInt(quoteTargetAmountMinor)) {
    throw new Error('FX_QUOTED_TARGET_MISMATCH');
  }

  return {
    paymentInput: {
      releaseRequestId: input.releaseRequestId,
      providerKey: input.providerKey,
      idempotencyKey: input.idempotencyKey,
      beneficiaryReference: input.beneficiaryReference,
      amountMinor: quoteTargetAmountMinor,
      currency: settlementCurrency,
      authorized: input.authorized,
    },
    currencyRoute: {
      sourceAmountMinor,
      sourceCurrency,
      settlementAmountMinor: quoteTargetAmountMinor,
      settlementCurrency,
      fxRequired: true,
      fxQuoteId: quote.id,
    },
  };
}
