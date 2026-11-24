import type { OutboxEvent, RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { FlowInstance, FlowOrchestrator, FlowRegistry, FlowState } from './index';
import { CANONICAL_DOMAIN_EVENTS } from './canonical-chain';
import { DomainEventFlowBridge } from './domain-event-bridge';

/**
 * The relay that makes Flow OS actually fire.
 *
 * `DomainEventFlowBridge` converts a committed domain event into a flow signal, and its own comment
 * says the event id is the idempotency key "so replayed/out-of-order webhook or worker delivery
 * cannot advance the same waiting step twice". That sentence describes a worker. There was no worker.
 * The bridge had **zero callers**, so the only thing that could ever advance a flow was somebody
 * hand-posting `/api/v1/flows/{id}/signals`.
 *
 * The consequence is worth stating plainly, because the orchestrator looked finished: engines were
 * issuing certificates, assessing eligibility and submitting payment instructions, each emitting its
 * authoritative event into the outbox — and the flow tracking that journey sat at step one. Flow OS
 * was a parallel bookkeeping system that shared the domain's vocabulary without being connected to
 * it.
 *
 * ## Two links were missing, not one
 *
 * A step's life is `PENDING → READY → WAITING_EVENT → COMPLETED`. `evaluate` performs the first
 * move, `dispatch` the second, `signal` the third. `dispatch` had **no callers either**, so even a
 * perfect event relay would have found every step sitting in `READY` — a state no signal can
 * complete, because `signal` only looks at steps in `WAITING_EVENT`.
 *
 * That is why this is a driver rather than an event pump. One pass evaluates, dispatches whatever
 * became ready, then relays whatever the domain has already committed; completing a step makes its
 * dependents ready, so passes repeat until one changes nothing. The loop is bounded: a journey that
 * could advance for ever would be a cycle in the flow definition, which
 * `flow-trigger-coverage.test.ts` refuses separately.
 *
 * ## Why the outbox is read and never marked
 *
 * `OutboxEvent` carries `publishedAt`, which reads like the obvious drain marker. It cannot be used:
 * `outboxEvents` is a history collection, `replace` refuses anything outside `GOVERNED_DOCUMENTS`,
 * and the schema raises `TRUST_HISTORY_IS_APPEND_ONLY` besides. The outbox is immutable on purpose —
 * it is evidence — so `publishedAt` is vestigial and a relay must not pretend otherwise.
 *
 * Idempotency therefore comes from the other end, which is where it belongs: `FlowOrchestrator.signal`
 * dedupes on `idempotencyKey` within the workspace and returns the flow untouched on a repeat. So
 * re-draining the same events is safe by construction rather than by bookkeeping, and a relay that
 * crashes half-way has done no partial damage.
 *
 * ## Why an ambiguous match is refused rather than guessed
 *
 * A signal's idempotency key is unique per workspace, so one domain event can advance exactly one
 * flow. If two live flows both correlate to an event, picking one would silently decide which
 * journey a completion certificate belongs to. In software that releases money, that guess is worse
 * than stalling: the relay reports `AMBIGUOUS_FLOW` and leaves both flows alone for a human.
 */

export type RelayOutcome =
  | 'SIGNALLED'
  | 'ALREADY_APPLIED'
  | 'NOT_ORCHESTRATED'
  | 'NO_MATCHING_FLOW'
  | 'AMBIGUOUS_FLOW'
  | 'STEP_NOT_WAITING';

export type RelayedEvent = {
  eventId: string;
  eventType: string;
  flowId?: string;
  outcome: RelayOutcome;
};

export type RelayResult = {
  /** Events considered — those the canonical flow actually waits for. */
  considered: number;
  /** READY steps moved into a waiting state, which is what makes them signallable at all. */
  dispatched: number;
  signalled: number;
  /** Passes taken before a pass changed nothing. */
  passes: number;
  /** Per-event detail, so a stalled journey can be explained rather than guessed at. */
  events: RelayedEvent[];
};

/**
 * Enough passes for any sane journey, and a refusal rather than a hang for an insane one.
 *
 * The canonical flow has fourteen steps and each pass completes at least one when it progresses at
 * all, so this is comfortably above what a correct definition needs.
 */
const MAX_PASSES = 64;

/**
 * Flows a signal can no longer advance.
 *
 * Expressed as the terminal states rather than the live ones deliberately: if a new waiting state is
 * ever added to `FlowState`, an allowlist would silently stop relaying to it, while this denylist
 * treats it as live. The failure mode of the first is a flow that stalls for reasons nobody can see;
 * of the second, a signal harmlessly deduped.
 */
const TERMINAL_STATES = new Set<FlowState>(['COMPLETED', 'FAILED', 'CANCELLED']);

export class FlowSignalRelay {
  private readonly bridge: DomainEventFlowBridge;

  constructor(
    private readonly store: TrustPersistence,
    private readonly flows: FlowOrchestrator,
    /**
     * The same registry the orchestrator was built with.
     *
     * Passed in rather than read off the orchestrator, whose registry is private: the relay needs
     * the definitions to know which event each step waits for, and widening the orchestrator's
     * public surface to serve this one caller would be the worse trade.
     */
    private readonly registry: FlowRegistry,
  ) {
    this.bridge = new DomainEventFlowBridge(flows);
  }

  /**
   * Advances every live flow in this workspace as far as the domain already allows.
   *
   * Idempotent and safe to call repeatedly: `dispatch` is only attempted on a step this pass found
   * in `READY`, and `signal` dedupes on the event id. Calling it on an up-to-date workspace does
   * nothing and reports `passes: 1`.
   */
  async drain(context: RequestContext, options: { flowId?: string } = {}): Promise<RelayResult> {
    requireActiveWorkspace(context);

    const events: RelayedEvent[] = [];
    let considered = 0;
    let dispatched = 0;
    let signalled = 0;
    let passes = 0;

    for (; passes < MAX_PASSES; passes++) {
      const flows = await this.liveFlows(context, options.flowId);
      if (flows.length === 0) break;

      let progressed = false;

      // Evaluate first, so a step whose dependencies were satisfied by the previous pass becomes
      // READY before this pass tries to dispatch it.
      for (const flow of flows) {
        await this.flows.evaluate(context, flow.id);
        if (await this.dispatchReady(context, flow.id)) {
          dispatched++;
          progressed = true;
        }
      }

      const relayed = await this.relayEvents(context, options.flowId);
      considered = relayed.considered;
      if (relayed.signalled > 0) progressed = true;
      signalled += relayed.signalled;
      // One entry per event, keeping the most informative outcome rather than the last. A later pass
      // reports an event it already relayed as ALREADY_APPLIED, and letting that overwrite
      // SIGNALLED would make the detail contradict the `signalled` count.
      for (const entry of relayed.events) {
        const existing = events.findIndex((candidate) => candidate.eventId === entry.eventId);
        if (existing < 0) events.push(entry);
        else if (events[existing].outcome !== 'SIGNALLED') events[existing] = entry;
      }

      if (!progressed) {
        passes++;
        break;
      }
    }

    if (passes >= MAX_PASSES) throw new Error('FLOW_ADVANCE_DID_NOT_SETTLE');
    return { considered, dispatched, signalled, passes, events };
  }

  /** Dispatches every READY step of a flow. Returns whether any moved. */
  private async dispatchReady(context: RequestContext, flowId: string): Promise<boolean> {
    let moved = false;
    for (const step of await this.flows.steps(context, flowId)) {
      if (step.state !== 'READY') continue;
      // Re-read inside the loop is unnecessary — `dispatch` re-reads and refuses anything not READY
      // — but a step dispatched earlier in this same loop can make a later one ready, so the refusal
      // is caught rather than prevented.
      try {
        await this.flows.dispatch(context, flowId, step.stepDefinitionId);
        moved = true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'FLOW_STEP_NOT_READY') throw error;
      }
    }
    return moved;
  }

  /** One pass of the event relay: outbox -> bridge -> signal. */
  private async relayEvents(
    context: RequestContext,
    flowId?: string,
  ): Promise<{ considered: number; signalled: number; events: RelayedEvent[] }> {
    requireActiveWorkspace(context);
    const workspaceId = context.activeWorkspaceId;
    const orchestrated = (await this.store.list<OutboxEvent>('outboxEvents'))
      .filter((event) => event.workspaceId === workspaceId)
      .filter((event) => CANONICAL_DOMAIN_EVENTS.has(event.eventType))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));

    const flows = await this.liveFlows(context, flowId);
    const events: RelayedEvent[] = [];

    for (const event of orchestrated) {
      const candidates = flows.filter((flow) => this.correlates(flow, event));

      if (candidates.length === 0) {
        events.push({ eventId: event.id, eventType: event.eventType, outcome: 'NO_MATCHING_FLOW' });
        continue;
      }
      if (candidates.length > 1) {
        events.push({ eventId: event.id, eventType: event.eventType, outcome: 'AMBIGUOUS_FLOW' });
        continue;
      }

      const flow = candidates[0];
      // Asked before signalling rather than inferred from the result, because `signal` returns the
      // flow unchanged on a duplicate and the two cases are indistinguishable from its return value.
      const applied = await this.alreadyApplied(context, event.id);

      // The guard that makes multi-step relaying correct, and the absence of which is a trap worth
      // naming. `signal` records the signal and consumes its idempotency key whether or not any step
      // was waiting for it — it only completes steps already in WAITING_EVENT. So delivering an
      // event while its step is still READY burns the event: the key is spent, the step never
      // completes, and the journey stalls for ever on a transition the domain already made. Found by
      // relaying four consecutive events in one pass, where completing the first makes the second's
      // step merely READY. Deferring instead costs one more pass and nothing else.
      if (!applied && !(await this.isWaitingFor(context, flow.id, event.eventType))) {
        events.push({
          eventId: event.id,
          eventType: event.eventType,
          flowId: flow.id,
          outcome: 'STEP_NOT_WAITING',
        });
        continue;
      }
      const result = await this.bridge.apply(context, flow.id, {
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        workspaceId,
        correlationId: event.correlationId,
        payload: event.payload,
      });

      events.push({
        eventId: event.id,
        eventType: event.eventType,
        flowId: flow.id,
        outcome: !result.accepted ? 'NOT_ORCHESTRATED' : applied ? 'ALREADY_APPLIED' : 'SIGNALLED',
      });
    }

    return {
      considered: orchestrated.length,
      signalled: events.filter((entry) => entry.outcome === 'SIGNALLED').length,
      events,
    };
  }

  private async liveFlows(context: RequestContext, flowId?: string): Promise<FlowInstance[]> {
    requireActiveWorkspace(context);
    return (await this.store.list<FlowInstance>('flowInstances')).filter(
      (flow) =>
        flow.workspaceId === context.activeWorkspaceId &&
        !TERMINAL_STATES.has(flow.state) &&
        (flowId === undefined || flow.id === flowId),
    );
  }

  /**
   * The same predicate the bridge enforces.
   *
   * Deliberately duplicated rather than exported from the bridge: the relay has to *find* a flow
   * before it can name one, and the bridge then re-checks what it was handed. Two independent
   * evaluations of the same rule is the point — the relay choosing wrongly is caught by the bridge
   * refusing, rather than by the relay being trusted.
   */
  private correlates(flow: FlowInstance, event: OutboxEvent): boolean {
    if (flow.correlationId === event.correlationId) return true;
    const transactionId = event.payload?.transactionId;
    return typeof transactionId === 'string' && flow.transactionId === transactionId;
  }

  /** Whether any step of this flow is currently waiting for this event type. */
  private async isWaitingFor(
    context: RequestContext,
    flowId: string,
    eventType: string,
  ): Promise<boolean> {
    const flow = await this.flows.get(context, flowId);
    const steps = await this.flows.steps(context, flowId);
    const awaited = this.registryEventFor(flow.flowDefinitionId, flow.flowVersion);
    return steps.some(
      (step) => step.state === 'WAITING_EVENT' && awaited.get(step.stepDefinitionId) === eventType,
    );
  }

  private registryEventFor(flowDefinitionId: string, flowVersion: number): Map<string, string> {
    const definition = this.registry.get(flowDefinitionId, flowVersion);
    return new Map(
      definition.steps.flatMap((step) => (step.waitForEvent ? [[step.id, step.waitForEvent] as const] : [])),
    );
  }

  private async alreadyApplied(context: RequestContext, eventId: string): Promise<boolean> {
    const key = `domain-event:${eventId}`;
    return (await this.store.list<{ workspaceId: string; idempotencyKey: string }>('flowSignals')).some(
      (signal) => signal.workspaceId === context.activeWorkspaceId && signal.idempotencyKey === key,
    );
  }
}
