import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AssuranceRouter,
  FlowOrchestrator,
  FlowRegistry,
  type FlowDefinition,
} from './index';

const context = {
  actorUserId: 'operator',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'flow-test',
};

const definition: FlowDefinition = {
  id: 'TEST_FLOW',
  version: 1,
  name: 'Test flow',
  description: 'Proves deterministic orchestration without owning domain truth.',
  steps: [
    { id: 'prepare', title: 'Prepare', handler: 'prepare' },
    { id: 'evidence', title: 'Wait for evidence', dependencies: ['prepare'], waitForEvent: 'EVIDENCE_SUBMITTED' },
    { id: 'approval', title: 'Independent approval', dependencies: ['evidence'], humanTaskRole: 'REVIEWER', minimumAssurance: 'ENHANCED' },
    { id: 'finish', title: 'Finish', dependencies: ['approval'], handler: 'finish' },
  ],
};

function setup() {
  const store = new InMemoryTrustStore();
  const registry = new FlowRegistry();
  registry.register(definition);
  const engine = new FlowOrchestrator(store, registry, {
    prepare: async () => 'COMPLETED',
    finish: async () => 'COMPLETED',
  });
  return { store, engine };
}

function asFlow(result: Awaited<ReturnType<FlowOrchestrator['dispatch']>>) {
  if ('status' in result) throw new Error('EXPECTED_FLOW_INSTANCE');
  return result;
}

async function grantReviewer(store: InMemoryTrustStore) {
  await store.append('memberships', {
    id: 'membership-reviewer',
    workspaceId: 'w',
    userId: 'operator',
    status: 'ACTIVE',
    role: 'REVIEWER',
  });
}

async function start(engine: FlowOrchestrator, assuranceLevel: 'STANDARD' | 'ENHANCED') {
  return engine.start(context, {
    flowDefinitionId: 'TEST_FLOW',
    flowVersion: 1,
    organizationId: 'org',
    transactionId: 'tx',
    assuranceLevel,
    idempotencyKey: `start-${assuranceLevel}`,
  });
}

describe('Flow Orchestration OS', () => {
  it('does not skip an assurance gate until its dependencies are complete', async () => {
    const { engine } = setup();
    const flow = await start(engine, 'STANDARD');
    const steps = await engine.steps(context, flow.id);
    expect(steps.find((step) => step.stepDefinitionId === 'approval')?.state).toBe('PENDING');
    expect(steps.find((step) => step.stepDefinitionId === 'finish')?.state).toBe('PENDING');
  });

  it('runs deterministic steps, waits durably for signals, skips higher-assurance gates and completes', async () => {
    const { engine } = setup();
    let flow = await start(engine, 'STANDARD');
    expect(flow.state).toBe('RUNNING');

    await engine.dispatch(context, flow.id, 'prepare');
    flow = asFlow(await engine.dispatch(context, flow.id, 'evidence'));
    expect(flow.state).toBe('WAITING_EVENT');

    flow = await engine.signal(context, {
      flowId: flow.id,
      eventType: 'EVIDENCE_SUBMITTED',
      idempotencyKey: 'signal-1',
    });
    expect(flow.state).toBe('RUNNING');
    expect((await engine.steps(context, flow.id)).find((step) => step.stepDefinitionId === 'approval')?.state).toBe('SKIPPED');

    flow = asFlow(await engine.dispatch(context, flow.id, 'finish'));
    expect(flow.state).toBe('COMPLETED');
  });

  it('requires the task role before accepting a governed human decision', async () => {
    const { engine } = setup();
    let flow = await start(engine, 'ENHANCED');
    await engine.dispatch(context, flow.id, 'prepare');
    await engine.dispatch(context, flow.id, 'evidence');
    flow = await engine.signal(context, { flowId: flow.id, eventType: 'EVIDENCE_SUBMITTED', idempotencyKey: 'signal-role' });
    const task = await engine.dispatch(context, flow.id, 'approval');
    if (!('id' in task)) throw new Error('TASK_ID_MISSING');
    await expect(engine.decide(context, task.id, 'APPROVE')).rejects.toThrow('HUMAN_TASK_REQUIRED_ROLE_MISSING');
  });

  it('requires a governed human decision on enhanced-assurance flows', async () => {
    const { store, engine } = setup();
    await grantReviewer(store);
    let flow = await start(engine, 'ENHANCED');
    await engine.dispatch(context, flow.id, 'prepare');
    await engine.dispatch(context, flow.id, 'evidence');
    flow = await engine.signal(context, { flowId: flow.id, eventType: 'EVIDENCE_SUBMITTED', idempotencyKey: 'signal-2' });
    expect(flow.state).toBe('RUNNING');

    const task = await engine.dispatch(context, flow.id, 'approval');
    expect('status' in task && task.status).toBe('OPEN');
    expect((await engine.get(context, flow.id)).state).toBe('WAITING_HUMAN');

    if (!('id' in task)) throw new Error('TASK_ID_MISSING');
    flow = await engine.decide(context, task.id, 'APPROVE');
    expect(flow.state).toBe('RUNNING');
    flow = asFlow(await engine.dispatch(context, flow.id, 'finish'));
    expect(flow.state).toBe('COMPLETED');
    expect((await store.list('humanTasks')).length).toBe(1);
  });

  it('deduplicates start commands and external signals', async () => {
    const { store, engine } = setup();
    const first = await start(engine, 'STANDARD');
    const second = await start(engine, 'STANDARD');
    expect(second.id).toBe(first.id);

    await engine.dispatch(context, first.id, 'prepare');
    await engine.dispatch(context, first.id, 'evidence');
    await engine.signal(context, { flowId: first.id, eventType: 'EVIDENCE_SUBMITTED', idempotencyKey: 'same-signal' });
    await engine.signal(context, { flowId: first.id, eventType: 'EVIDENCE_SUBMITTED', idempotencyKey: 'same-signal' });
    expect((await store.list('flowSignals')).length).toBe(1);
  });

  it('retries bounded transient handler failures before failing the flow', async () => {
    const store = new InMemoryTrustStore();
    const registry = new FlowRegistry();
    registry.register({
      id: 'RETRY_FLOW', version: 1, name: 'Retry', description: 'Retry proof',
      steps: [{ id: 'unstable', title: 'Unstable', handler: 'unstable', retry: { maxAttempts: 2, backoffSeconds: 1 } }],
    });
    const engine = new FlowOrchestrator(store, registry, { unstable: async () => { throw new Error('PROVIDER_DOWN'); } });
    let flow = await engine.start(context, {
      flowDefinitionId: 'RETRY_FLOW', flowVersion: 1, organizationId: 'org', transactionId: 'tx-retry', idempotencyKey: 'retry-flow',
    });
    flow = asFlow(await engine.dispatch(context, flow.id, 'unstable'));
    expect(flow.state).toBe('RETRY_PENDING');
    flow = asFlow(await engine.dispatch(context, flow.id, 'unstable'));
    expect(flow.state).toBe('FAILED');
  });
});

describe('Adaptive Assurance Routing', () => {
  it('raises assurance for high-value, low-confidence, high-risk transactions', () => {
    const engine = new AssuranceRouter();
    expect(engine.evaluate({
      transactionAmountMinor: 150_000_000,
      activeExposureMinor: 300_000_000,
      priorCompletionRate: 0.5,
      priorDisputes: 2,
      evidenceQuality: 0.5,
      fundingConfidence: 0.5,
      identityConfidence: 0.6,
      riskScore: 45,
    })).toBe('INSTITUTIONAL');
  });
});