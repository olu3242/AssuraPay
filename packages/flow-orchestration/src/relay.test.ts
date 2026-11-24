import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { COMMERCIAL_COMMITMENT_FLOW_V1, FlowOrchestrator, FlowRegistry, type FlowInstance, type StepInstance } from './index';
import { FlowSignalRelay } from './relay';

/**
 * The relay turns committed domain events into flow progress.
 *
 * Before it, `DomainEventFlowBridge` had no callers, so a flow could only be advanced by someone
 * hand-posting a signal. These assertions are about the thing that was missing: that a flow started
 * for a transaction advances *because the domain transitioned*, with nobody telling it to.
 *
 * The negative cases carry as much weight. A relay that advances the wrong flow is worse than one
 * that does nothing, because the wrong flow is the record somebody later releases money against.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-operator',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    memberships: ['workspace-1'],
    correlationId: 'corr-journey-1',
    ...overrides,
  };
}

async function harness() {
  const store = new InMemoryTrustStore();
  const registry = new FlowRegistry();
  registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
  const flows = new FlowOrchestrator(store, registry);
  const relay = new FlowSignalRelay(store, flows, registry);
  return { store, flows, relay };
}

async function startFlow(
  flows: FlowOrchestrator,
  ctx: RequestContext,
  input: { transactionId?: string; idempotencyKey?: string } = {},
) {
  return await flows.start(ctx, {
    flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
    flowVersion: 1,
    organizationId: 'org-1',
    transactionId: input.transactionId ?? 'txn-1',
    agreementId: 'agreement-1',
    idempotencyKey: input.idempotencyKey ?? 'flow-1',
  });
}

/** An authoritative domain event, as an engine would have emitted it. */
async function emitDomainEvent(
  store: InMemoryTrustStore,
  ctx: RequestContext,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  return await store.emit({
    tenantId: ctx.tenantId,
    workspaceId: ctx.activeWorkspaceId,
    aggregateType: 'ExecutionCertificate',
    aggregateId: 'agg-1',
    eventType,
    eventVersion: 1,
    payload,
    correlationId: ctx.correlationId,
  });
}

async function stepStates(flows: FlowOrchestrator, ctx: RequestContext, flowId: string) {
  return Object.fromEntries(
    (await flows.steps(ctx, flowId)).map((step: StepInstance) => [step.stepDefinitionId, step.state]),
  );
}

describe('a committed domain event advances the flow, with nobody signalling it', () => {
  it('relays the first canonical event and completes its step', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);

    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(1);
    expect(result.events[0]).toMatchObject({
      eventType: 'ExecutionCertificateIssued',
      flowId: flow.id,
      outcome: 'SIGNALLED',
    });

    expect((await stepStates(flows, ctx, flow.id))['agreement-executed']).toBe('COMPLETED');
  });

  it('walks several steps in the order the domain transitioned, not the order drained', async () => {
    // The outbox is append-only, so `occurredAt` is the real order. Relaying evidence verification
    // before the workspace activation it depends on would consume the event while the earlier step
    // was still waiting, and the journey would stall one step short for ever.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);

    for (const eventType of [
      'ExecutionCertificateIssued',
      'AgreementIntelligencePublished',
      'PerformanceBlueprintActivated',
      'DefinitionOfDonePublished',
    ])
      await emitDomainEvent(store, ctx, eventType);

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(4);

    const states = await stepStates(flows, ctx, flow.id);
    for (const step of ['agreement-executed', 'agreement-intelligence', 'blueprint', 'dod'])
      expect(states[step], step).toBe('COMPLETED');
  });

  it('is idempotent: draining twice advances nothing further', async () => {
    // The whole safety argument for re-running the relay. `signal` dedupes on the event id, so a
    // crashed or repeated drain cannot double-advance a journey.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);
    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');

    expect((await relay.drain(ctx)).signalled).toBe(1);
    const second = await relay.drain(ctx);
    expect(second.signalled).toBe(0);
    expect(second.events[0].outcome).toBe('ALREADY_APPLIED');

    const signals = await store.list<{ idempotencyKey: string }>('flowSignals');
    expect(signals).toHaveLength(1);
  });

  it('ignores domain events the flow does not orchestrate', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    await startFlow(flows, ctx);
    await emitDomainEvent(store, ctx, 'ContractDraftSubmitted');

    const result = await relay.drain(ctx);
    expect(result.considered).toBe(0);
    expect(result.signalled).toBe(0);
  });
});

describe('the relay refuses to guess which journey an event belongs to', () => {
  it('reports an unmatched event rather than advancing an arbitrary flow', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    await startFlow(flows, ctx, { transactionId: 'txn-1' });

    // Same workspace, unrelated journey: different correlation id and no transactionId to match on.
    await emitDomainEvent(store, { ...ctx, correlationId: 'corr-unrelated' }, 'ExecutionCertificateIssued');

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(0);
    expect(result.events[0].outcome).toBe('NO_MATCHING_FLOW');
  });

  it('refuses an ambiguous match instead of picking one', async () => {
    // A signal's idempotency key is unique per workspace, so one event can advance exactly one flow.
    // Choosing between two correlated journeys would silently decide which one a certificate belongs
    // to, and that record is what somebody later releases money against.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const first = await startFlow(flows, ctx, { transactionId: 'txn-shared', idempotencyKey: 'flow-a' });
    const second = await startFlow(flows, ctx, { transactionId: 'txn-shared', idempotencyKey: 'flow-b' });
    expect(first.id).not.toBe(second.id);

    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued', { transactionId: 'txn-shared' });

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(0);
    expect(result.events[0].outcome).toBe('AMBIGUOUS_FLOW');

    // Neither journey moved.
    for (const flow of [first, second])
      expect((await stepStates(flows, ctx, flow.id))['agreement-executed']).not.toBe('COMPLETED');
  });

  it('matches on transactionId when the correlation id differs', async () => {
    // A webhook or worker delivery carries its own correlation id; the transaction is what ties it to
    // a journey. This is the path that makes asynchronous settlement confirmation work at all.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx, { transactionId: 'txn-7' });
    await flows.evaluate(ctx, flow.id);

    await emitDomainEvent(store, { ...ctx, correlationId: 'corr-from-a-worker' }, 'ExecutionCertificateIssued', {
      transactionId: 'txn-7',
    });

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(1);
    expect(result.events[0].flowId).toBe(flow.id);
  });

  it('does not reach into another workspace', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);
    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');

    const other = context({ activeWorkspaceId: 'workspace-2', memberships: ['workspace-2'] });
    const result = await relay.drain(other);
    expect(result.considered).toBe(0);
    expect((await stepStates(flows, ctx, flow.id))['agreement-executed']).not.toBe('COMPLETED');
  });

  it('leaves a completed flow alone', async () => {
    // With no live flow there is nothing to advance, so the driver stops before reading the outbox
    // at all rather than reporting an unmatched event for a journey that is simply finished.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await store.replace('flowInstances', { ...(flow as FlowInstance), state: 'COMPLETED' });
    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(0);
    expect(result.considered).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('can be scoped to one flow', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    const target = await startFlow(flows, ctx, { idempotencyKey: 'flow-target' });
    await flows.evaluate(ctx, target.id);
    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');

    const result = await relay.drain(ctx, { flowId: target.id });
    expect(result.signalled).toBe(1);
    expect(result.events[0].flowId).toBe(target.id);
  });

  it('requires an active workspace', async () => {
    const { relay } = await harness();
    await expect(
      relay.drain(context({ activeWorkspaceId: undefined, memberships: [] })),
    ).rejects.toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });
});

describe('an event is never delivered to a step that is not waiting for it', () => {
  it('defers rather than burning the idempotency key', async () => {
    // The trap this guard exists for. `signal` consumes an event's idempotency key whether or not a
    // step was waiting, and only completes steps already in WAITING_EVENT. Deliver an event one step
    // too early and the key is spent, the step never completes, and the journey stalls for ever on a
    // transition the domain already made.
    //
    // Here the second event arrives while only the first step has been dispatched, so the relay must
    // report it deferred and leave it for the pass that dispatches its step.
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);
    await flows.dispatch(ctx, flow.id, 'agreement-executed');

    // Only the later event exists, so no pass can dispatch the step that awaits it.
    await emitDomainEvent(store, ctx, 'PerformanceBlueprintActivated');

    const result = await relay.drain(ctx);
    expect(result.signalled).toBe(0);
    expect(result.events[0]).toMatchObject({
      eventType: 'PerformanceBlueprintActivated',
      outcome: 'STEP_NOT_WAITING',
    });

    // The key is unspent, so when the journey does reach that step the event still lands.
    expect(await store.list('flowSignals')).toHaveLength(0);
  });

  it('delivers the deferred event once its step is reached', async () => {
    const { store, flows, relay } = await harness();
    const ctx = context();
    const flow = await startFlow(flows, ctx);
    await flows.evaluate(ctx, flow.id);

    // Out of order on purpose: the blueprint event is committed before the two it depends on.
    await emitDomainEvent(store, ctx, 'PerformanceBlueprintActivated');
    const deferred = await relay.drain(ctx);
    expect(deferred.events.some((entry) => entry.outcome === 'STEP_NOT_WAITING')).toBe(true);

    await emitDomainEvent(store, ctx, 'ExecutionCertificateIssued');
    await emitDomainEvent(store, ctx, 'AgreementIntelligencePublished');

    const result = await relay.drain(ctx);
    const states = await stepStates(flows, ctx, flow.id);
    for (const step of ['agreement-executed', 'agreement-intelligence', 'blueprint'])
      expect(states[step], step).toBe('COMPLETED');
    expect(result.signalled).toBeGreaterThanOrEqual(3);
  });
});
