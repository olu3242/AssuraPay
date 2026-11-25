import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import {
  AGENT_ESCALATION_COLLECTION,
  AgenticDispatchEngine,
  type AgentEscalation,
  type DispatchProfile,
  type DispatchTask,
} from './dispatch';
import type { AgentActionClass, AutonomyMandate } from './autonomy';

/**
 * Constitutional dispatch: one route to an agent, and a durable record when a person must act.
 *
 * `autonomy.test.ts` proves the verdict over the whole matrix. This proves what the engine does with
 * it — and the two properties that are easy to get wrong and invisible when they are:
 *
 * 1. **An escalation is written before the method returns.** An escalation the caller knows about and
 *    the store does not is a stall nobody can list, which is the failure the flow relay existed to
 *    remove, repeated one layer up.
 * 2. **The runtime is never reached unless the verdict said so.** A denial or escalation that still
 *    called `execute` would mean the mandate decorated a dispatch rather than gating it.
 */

const ROLE = 'ASSURANCE_ANALYST';

function context(over: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-asking',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    memberships: ['workspace-a'],
    correlationId: 'corr-1',
    ...over,
  };
}

function mandate(over: Partial<AutonomyMandate> = {}): AutonomyMandate {
  return {
    autonomyLevel: 2,
    allowedActionClasses: ['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE'] as AgentActionClass[],
    maxRisk: 'MEDIUM',
    allowedRoles: [ROLE],
    ...over,
  };
}

function profile(over: Partial<DispatchProfile> = {}): DispatchProfile {
  return {
    agent: 'Blueprint',
    persona: 'execution-lead',
    mandate: mandate(),
    registeredAgentId: 'agent-1',
    capabilityId: 'capability-1',
    promptId: 'prompt-1',
    ...over,
  };
}

function task(over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    actionClass: 'ANALYZE',
    risk: 'LOW',
    roles: [ROLE],
    contextSnapshotId: 'snapshot-1',
    model: 'sandbox',
    variables: { subject: 'milestone-1' },
    idempotencyKey: `task-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

/** A runtime that records what it was asked to execute, and nothing more. */
function recordingRuntime() {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    runtime: {
      async execute(_context: RequestContext, input: Record<string, unknown>) {
        calls.push(input);
        return { id: `execution-${calls.length}` };
      },
    } as never,
  };
}

function engineWith(runtime: ReturnType<typeof recordingRuntime>) {
  const store = new InMemoryTrustStore();
  return {
    store,
    engine: new AgenticDispatchEngine({
      runtime: runtime.runtime,
      store,
      now: () => new Date('2026-11-25T21:00:00.000Z'),
    }),
  };
}

describe('a task within the mandate goes to the runtime', () => {
  it('executes with the governed identities and no others', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    const outcome = await engine.dispatch(context(), profile(), task());

    expect(outcome).toEqual({ outcome: 'DISPATCHED', executionId: 'execution-1' });
    expect(runtime.calls).toHaveLength(1);
    // The three identities the runtime enforces. Passing anything else would mean dispatch had its
    // own idea of what the agent may use.
    expect(runtime.calls[0]).toMatchObject({
      agentId: 'agent-1',
      capabilityId: 'capability-1',
      promptId: 'prompt-1',
      contextSnapshotId: 'snapshot-1',
      model: 'sandbox',
    });
  });

  it('records the mandate on the execution, so telemetry can say what admitted it', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    await engine.dispatch(context(), profile(), task({ actionClass: 'PREPARE', risk: 'LOW' }));

    expect(runtime.calls[0]?.variables).toMatchObject({
      subject: 'milestone-1',
      agent: 'Blueprint',
      persona: 'execution-lead',
      actionClass: 'PREPARE',
      risk: 'LOW',
      autonomyLevel: '2',
    });
  });

  it('writes no escalation when nothing was escalated', async () => {
    const runtime = recordingRuntime();
    const { engine, store } = engineWith(runtime);

    await engine.dispatch(context(), profile(), task());

    expect(await store.list(AGENT_ESCALATION_COLLECTION)).toEqual([]);
    expect(await engine.openEscalations(context())).toEqual([]);
  });

  it('omits the optional retry bounds rather than sending undefined', async () => {
    // `exactOptionalPropertyTypes` aside, a runtime reading `maxAttempts: undefined` cannot tell it
    // apart from a caller asking for zero attempts.
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    await engine.dispatch(context(), profile(), task());
    expect(Object.keys(runtime.calls[0] ?? {})).not.toContain('maxAttempts');

    await engine.dispatch(context(), profile(), task({ maxAttempts: 3, timeoutMs: 1_000 }));
    expect(runtime.calls[1]).toMatchObject({ maxAttempts: 3, timeoutMs: 1_000 });
  });
});

describe('a task beyond the mandate reaches a person, durably', () => {
  it('writes an open escalation and does not call the runtime', async () => {
    const runtime = recordingRuntime();
    const { engine, store } = engineWith(runtime);

    const outcome = await engine.dispatch(
      context(),
      profile(),
      task({ actionClass: 'ANALYZE', risk: 'CRITICAL', idempotencyKey: 'over-risk' }),
    );

    expect(outcome.outcome).toBe('ESCALATED');
    // Never executed. A mandate that decorated the call rather than gating it would show up here.
    expect(runtime.calls).toEqual([]);

    const stored = await store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      agent: 'Blueprint',
      persona: 'execution-lead',
      actionClass: 'ANALYZE',
      risk: 'CRITICAL',
      autonomyLevel: 2,
      reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE',
      requestedBy: 'user-asking',
      status: 'OPEN',
      workspaceId: 'workspace-a',
    });
  });

  it('escalates an insufficient autonomy level with that reason', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    const outcome = await engine.dispatch(
      context(),
      profile({ mandate: mandate({ autonomyLevel: 0 }) }),
      task({ actionClass: 'RECOMMEND' }),
    );

    expect(outcome.outcome).toBe('ESCALATED');
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');
    expect(outcome.escalation.reason).toBe('AUTONOMY_LEVEL_INSUFFICIENT');
    expect(outcome.escalation.autonomyLevel).toBe(0);
  });

  it('lists open escalations oldest first', async () => {
    const runtime = recordingRuntime();
    const store = new InMemoryTrustStore();
    let tick = 0;
    const engine = new AgenticDispatchEngine({
      runtime: runtime.runtime,
      store,
      now: () => new Date(Date.UTC(2026, 10, 25, 21, 0, (tick += 1))),
    });

    await engine.dispatch(context(), profile(), task({ risk: 'CRITICAL', idempotencyKey: 'a' }));
    await engine.dispatch(context(), profile(), task({ risk: 'CRITICAL', idempotencyKey: 'b' }));

    const open = await engine.openEscalations(context());
    expect(open.map((entry) => entry.idempotencyKey)).toEqual(['a', 'b']);
  });

  it('shows a workspace only its own escalations', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    await engine.dispatch(context(), profile(), task({ risk: 'CRITICAL', idempotencyKey: 'mine' }));

    const other = context({ activeWorkspaceId: 'workspace-b', memberships: ['workspace-b'] });
    expect(await engine.openEscalations(other)).toEqual([]);
    expect(await engine.openEscalations(context())).toHaveLength(1);
  });
});

describe('a retry neither re-executes nor re-escalates', () => {
  it('returns the escalation already recorded', async () => {
    const runtime = recordingRuntime();
    const { engine, store } = engineWith(runtime);
    const repeated = task({ risk: 'CRITICAL', idempotencyKey: 'spent-once' });

    const first = await engine.dispatch(context(), profile(), repeated);
    const second = await engine.dispatch(context(), profile(), repeated);

    expect(first.outcome).toBe('ESCALATED');
    expect(second).toEqual(first);
    // One row, not two. A caller that retries is normal; duplicating the person's queue is not.
    expect(await store.list(AGENT_ESCALATION_COLLECTION)).toHaveLength(1);
  });

  it('answers a retry from the record rather than re-judging it', async () => {
    // The mandate can change between the first call and the retry. Re-judging would make the same
    // key mean two different things, and the second answer would silently replace the first.
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const repeated = task({ risk: 'CRITICAL', idempotencyKey: 'stable' });

    const first = await engine.dispatch(context(), profile(), repeated);
    // Now widen the ceiling so the same task would be dispatchable.
    const widened = profile({ mandate: mandate({ maxRisk: 'CRITICAL' }) });
    const second = await engine.dispatch(context(), widened, repeated);

    expect(second).toEqual(first);
    expect(runtime.calls).toEqual([]);
  });

  it('keys idempotency per workspace, so two tenants may use the same key', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const shared = task({ risk: 'CRITICAL', idempotencyKey: 'shared-key' });

    await engine.dispatch(context(), profile(), shared);
    const other = context({ activeWorkspaceId: 'workspace-b', memberships: ['workspace-b'] });
    const outcome = await engine.dispatch(other, profile(), shared);

    expect(outcome.outcome).toBe('ESCALATED');
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');
    expect(outcome.escalation.workspaceId).toBe('workspace-b');
  });
});

describe('a denied task is answered, not thrown', () => {
  it('returns the denial for a class outside the mandate', async () => {
    const runtime = recordingRuntime();
    const { engine, store } = engineWith(runtime);

    const outcome = await engine.dispatch(
      context(),
      profile({ mandate: mandate({ allowedActionClasses: ['READ'] }) }),
      task({ actionClass: 'PREPARE' }),
    );

    expect(outcome).toEqual({ outcome: 'DENIED', reason: 'ACTION_CLASS_NOT_IN_MANDATE' });
    expect(runtime.calls).toEqual([]);
    // No escalation: the agent is not for this, so there is nobody to escalate to.
    expect(await store.list(AGENT_ESCALATION_COLLECTION)).toEqual([]);
  });

  it('returns the denial for a caller holding no permitted role', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);

    const outcome = await engine.dispatch(
      context(),
      profile(),
      task({ roles: ['SOMEONE_ELSE'] }),
    );

    expect(outcome).toEqual({ outcome: 'DENIED', reason: 'CALLER_HOLDS_NO_PERMITTED_ROLE' });
    expect(runtime.calls).toEqual([]);
  });

  it('refuses a caller with no active workspace', async () => {
    // The one case that does throw, because it is not a verdict about a mandate: there is no
    // workspace in which to evaluate one, and every store read would be unscoped.
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const unscoped = context({ activeWorkspaceId: undefined, memberships: [] });

    await expect(engine.dispatch(unscoped, profile(), task())).rejects.toThrow(
      'ACTIVE_WORKSPACE_REQUIRED',
    );
  });
});

describe('resolving an escalation records who, not what', () => {
  it('marks it resolved with the actor and the time', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const outcome = await engine.dispatch(
      context(),
      profile(),
      task({ risk: 'CRITICAL', idempotencyKey: 'to-resolve' }),
    );
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');

    const resolved = await engine.resolve(
      context({ actorUserId: 'user-deciding' }),
      outcome.escalation.id,
    );

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedBy).toBe('user-deciding');
    expect(resolved.resolvedAt).toBe('2026-11-25T21:00:00.000Z');
    // And it leaves the open queue.
    expect(await engine.openEscalations(context())).toEqual([]);
  });

  it('carries no decision, because deciding is not this engine’s business', async () => {
    // An escalation is a routing record. What a person then decides happens in whichever
    // deterministic engine owns the act, under that engine's own authorization and audit — so there
    // is deliberately no APPROVED/REJECTED here to mistake for one.
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const outcome = await engine.dispatch(
      context(),
      profile(),
      task({ risk: 'CRITICAL', idempotencyKey: 'no-decision' }),
    );
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');

    const resolved = await engine.resolve(context(), outcome.escalation.id);
    expect(Object.keys(resolved)).not.toContain('decision');
    expect(['OPEN', 'RESOLVED']).toContain(resolved.status);
  });

  it('is idempotent, and refuses an escalation from another workspace', async () => {
    const runtime = recordingRuntime();
    const { engine } = engineWith(runtime);
    const outcome = await engine.dispatch(
      context(),
      profile(),
      task({ risk: 'CRITICAL', idempotencyKey: 'twice' }),
    );
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');

    const once = await engine.resolve(context(), outcome.escalation.id);
    const twice = await engine.resolve(context(), outcome.escalation.id);
    expect(twice).toEqual(once);

    const other = context({ activeWorkspaceId: 'workspace-b', memberships: ['workspace-b'] });
    await expect(engine.resolve(other, outcome.escalation.id)).rejects.toThrow(
      'AGENT_ESCALATION_NOT_FOUND',
    );
  });
});
