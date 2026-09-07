import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { GovernedPaymentIssue } from './multi-currency-payment';

export type PaymentCurrencyRouteRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  paymentInstructionId: string;
  releaseRequestId: string;
  providerKey: string;
  sourceAmountMinor: number;
  sourceCurrency: string;
  settlementAmountMinor: number;
  settlementCurrency: string;
  fxRequired: boolean;
  fxQuoteId?: string;
  createdAt: string;
};

export async function persistPaymentCurrencyRoute(
  store: TrustPersistence,
  context: RequestContext,
  paymentInstruction: { id: string; releaseRequestId: string; providerKey: string },
  governed: GovernedPaymentIssue,
): Promise<PaymentCurrencyRouteRecord> {
  requireActiveWorkspace(context);
  const workspaceId = context.activeWorkspaceId;
  const route = governed.currencyRoute;
  const expected: PaymentCurrencyRouteRecord = {
    id: paymentInstruction.id,
    tenantId: context.tenantId,
    workspaceId,
    paymentInstructionId: paymentInstruction.id,
    releaseRequestId: paymentInstruction.releaseRequestId,
    providerKey: paymentInstruction.providerKey,
    sourceAmountMinor: route.sourceAmountMinor,
    sourceCurrency: route.sourceCurrency,
    settlementAmountMinor: route.settlementAmountMinor,
    settlementCurrency: route.settlementCurrency,
    fxRequired: route.fxRequired,
    fxQuoteId: route.fxQuoteId,
    createdAt: new Date().toISOString(),
  };

  const existing = (await store.list<PaymentCurrencyRouteRecord>('paymentCurrencyRoutes'))
    .find((item) => item.id === paymentInstruction.id && item.workspaceId === workspaceId);

  if (existing) {
    const same =
      existing.paymentInstructionId === expected.paymentInstructionId &&
      existing.releaseRequestId === expected.releaseRequestId &&
      existing.providerKey === expected.providerKey &&
      existing.sourceAmountMinor === expected.sourceAmountMinor &&
      existing.sourceCurrency === expected.sourceCurrency &&
      existing.settlementAmountMinor === expected.settlementAmountMinor &&
      existing.settlementCurrency === expected.settlementCurrency &&
      existing.fxRequired === expected.fxRequired &&
      existing.fxQuoteId === expected.fxQuoteId;
    if (!same) throw new Error('PAYMENT_CURRENCY_ROUTE_IMMUTABILITY_VIOLATION');
    return existing;
  }

  await store.append('paymentCurrencyRoutes', expected);
  await store.audit({
    tenantId: context.tenantId,
    workspaceId,
    actorId: context.actorUserId,
    eventType: 'PaymentCurrencyRoutePersisted',
    aggregateType: 'PaymentInstruction',
    aggregateId: paymentInstruction.id,
    correlationId: context.correlationId,
    metadata: {
      sourceCurrency: expected.sourceCurrency,
      settlementCurrency: expected.settlementCurrency,
      fxRequired: expected.fxRequired,
      fxQuoteId: expected.fxQuoteId ?? null,
    },
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId,
    aggregateType: 'PaymentInstruction',
    aggregateId: paymentInstruction.id,
    eventType: 'PaymentCurrencyRoutePersisted',
    eventVersion: 1,
    payload: {
      sourceAmountMinor: expected.sourceAmountMinor,
      sourceCurrency: expected.sourceCurrency,
      settlementAmountMinor: expected.settlementAmountMinor,
      settlementCurrency: expected.settlementCurrency,
      fxRequired: expected.fxRequired,
      fxQuoteId: expected.fxQuoteId ?? null,
    },
    correlationId: context.correlationId,
  });
  return expected;
}
