import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { GovernedPaymentIssue } from './multi-currency-payment';

export type PaymentCurrencyRouteEvidence = {
  paymentInstructionId: string;
  releaseRequestId: string;
  providerKey: string;
  sourceAmountMinor: number;
  sourceCurrency: string;
  settlementAmountMinor: number;
  settlementCurrency: string;
  fxRequired: boolean;
  fxQuoteId?: string;
};

/**
 * Persists the source→settlement currency linkage on Assura's already-certified
 * durable audit/outbox path. PostgreSQL deliberately refuses unknown TrustPersistence
 * collections, so this slice does not invent an unmapped paymentCurrencyRoutes store.
 */
export async function persistPaymentCurrencyRouteEvidence(
  store: TrustPersistence,
  context: RequestContext,
  paymentInstruction: { id: string; releaseRequestId: string; providerKey: string },
  governed: GovernedPaymentIssue,
): Promise<PaymentCurrencyRouteEvidence> {
  requireActiveWorkspace(context);
  const workspaceId = context.activeWorkspaceId;
  const route = governed.currencyRoute;
  const evidence: PaymentCurrencyRouteEvidence = {
    paymentInstructionId: paymentInstruction.id,
    releaseRequestId: paymentInstruction.releaseRequestId,
    providerKey: paymentInstruction.providerKey,
    sourceAmountMinor: route.sourceAmountMinor,
    sourceCurrency: route.sourceCurrency,
    settlementAmountMinor: route.settlementAmountMinor,
    settlementCurrency: route.settlementCurrency,
    fxRequired: route.fxRequired,
    fxQuoteId: route.fxQuoteId,
  };

  await store.audit({
    tenantId: context.tenantId,
    workspaceId,
    actorId: context.actorUserId,
    eventType: 'PaymentCurrencyRoutePersisted',
    aggregateType: 'PaymentInstruction',
    aggregateId: paymentInstruction.id,
    correlationId: context.correlationId,
    metadata: evidence,
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId,
    aggregateType: 'PaymentInstruction',
    aggregateId: paymentInstruction.id,
    eventType: 'PaymentCurrencyRoutePersisted',
    eventVersion: 1,
    payload: evidence,
    correlationId: context.correlationId,
  });
  return evidence;
}
