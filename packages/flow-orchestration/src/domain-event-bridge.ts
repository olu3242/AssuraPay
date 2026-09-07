import type { RequestContext } from '@assurapay/shared';
import type { FlowOrchestrationEngine } from './index';
import { CANONICAL_DOMAIN_EVENTS } from './canonical-chain';

export type AuthoritativeDomainEvent = {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId: string;
  correlationId: string;
  payload?: Record<string, unknown>;
};

/**
 * Converts an event already committed by an authoritative domain engine into a
 * Flow OS signal. It never performs the domain transition itself.
 *
 * eventId is the idempotency key, so replayed/out-of-order webhook or worker
 * delivery cannot advance the same waiting step twice.
 */
export class DomainEventFlowBridge {
  constructor(private readonly flows: FlowOrchestrationEngine) {}

  async apply(context: RequestContext, flowId: string, event: AuthoritativeDomainEvent) {
    if (event.workspaceId !== context.activeWorkspaceId) throw new Error('FLOW_EVENT_WORKSPACE_MISMATCH');
    if (!CANONICAL_DOMAIN_EVENTS.has(event.eventType)) return { accepted: false as const, reason: 'EVENT_NOT_ORCHESTRATED' as const };

    const flow = await this.flows.get(context, flowId);
    if (flow.correlationId !== event.correlationId && flow.transactionId !== event.payload?.transactionId)
      throw new Error('FLOW_EVENT_CORRELATION_MISMATCH');

    await this.flows.signal(context, {
      flowId,
      eventType: event.eventType,
      idempotencyKey: `domain-event:${event.eventId}`,
      payload: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        ...event.payload,
      },
    });
    return { accepted: true as const };
  }
}
