import {
  reconcileFxSettlement,
  type CurrencyCode,
  type FxReconciliationResult,
} from '../../../packages/multi-currency/src';
import type { PaymentCurrencyRouteEvidence } from './payment-currency-link';

export function reconcilePaymentCurrencyRoute(
  route: PaymentCurrencyRouteEvidence,
  actual: {
    sourceAmountMinor: number;
    sourceCurrency: string;
    settlementAmountMinor: number;
    settlementCurrency: string;
  },
): FxReconciliationResult {
  return reconcileFxSettlement({
    expectedSource: {
      amountMinor: BigInt(route.sourceAmountMinor),
      currency: route.sourceCurrency as CurrencyCode,
    },
    actualSource: {
      amountMinor: BigInt(actual.sourceAmountMinor),
      currency: actual.sourceCurrency as CurrencyCode,
    },
    expectedTarget: {
      amountMinor: BigInt(route.settlementAmountMinor),
      currency: route.settlementCurrency as CurrencyCode,
    },
    actualTarget: {
      amountMinor: BigInt(actual.settlementAmountMinor),
      currency: actual.settlementCurrency as CurrencyCode,
    },
  });
}
