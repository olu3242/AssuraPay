import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { catalogueKeys } from '@assurapay/permissions';
import type { RequestContext } from '@assurapay/shared';
import {
  FLOW_RELAY_SYSTEM_ACTOR,
  FlowRelayWorker,
  systemContext,
  type DrainWorkspace,
} from './flow-relay-worker';
import type { ClaimedWorkspace, DurableFlowRelayQueue } from './flow-relay-queue';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * The worker loop, and the authority it deliberately does not have.
 *
 * The queue's durability properties are proved against PostgreSQL in
 * `flow-relay-queue.postgres.test.ts`, because leases and concurrency cannot be proved in memory.
 * What is proved here is what the loop does with the claims it gets — above all that one workspace's
 * failure does not stop the others, which is the difference between a relay that degrades and one
 * that stops the platform's settlement because a single tenant has a bad row.
 *
 * And the identity. The worker acts without a human behind it, so what it *cannot* do is the most
 * important thing about it, and the least visible. Those assertions are here rather than in prose.
 */

const TENANT = 'tenant-a';

/** A queue that records what the worker did to it, with no database. */
function fakeQueue(claims: ClaimedWorkspace[]) {
  const completed: string[] = [];
  const failed: { workspaceId: string; error: string }[] = [];
  let handedOut = false;
  const queue = {
    async claim() {
      // One batch, then nothing: the loop under test is a single pass, and a queue that kept
      // handing out the same claim would make `runOnce` look like an infinite worker.
      if (handedOut) return [];
      handedOut = true;
      return claims;
    },
    async complete(claim: ClaimedWorkspace) {
      completed.push(claim.workspaceId);
    },
    async fail(claim: ClaimedWorkspace, error: string) {
      failed.push({ workspaceId: claim.workspaceId, error });
      return { deadLettered: claim.attempts + 1 >= 5 };
    },
  } as unknown as DurableFlowRelayQueue;
  return { queue, completed, failed };
}

function claim(workspaceId: string, attempts = 0): ClaimedWorkspace {
  return { tenantId: TENANT, workspaceId, claimedSeq: '1', attempts };
}

describe('one pass drains what it claimed', () => {
  it('drains every claimed workspace and completes each one', async () => {
    const { queue, completed, failed } = fakeQueue([claim('ws-1'), claim('ws-2'), claim('ws-3')]);
    const drained: string[] = [];
    const drain: DrainWorkspace = async (context) => {
      drained.push(context.activeWorkspaceId!);
    };

    const pass = await new FlowRelayWorker(queue, drain).runOnce();

    expect(drained).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(completed).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(failed).toEqual([]);
    expect(pass).toMatchObject({ claimed: 3, drained: 3, failed: 0, deadLettered: 0 });
  });

  it('does nothing, cheaply, when nothing is due', async () => {
    const { queue, completed } = fakeQueue([]);
    const drain = vi.fn<DrainWorkspace>(async () => undefined);

    const pass = await new FlowRelayWorker(queue, drain).runOnce();

    expect(drain).not.toHaveBeenCalled();
    expect(completed).toEqual([]);
    expect(pass).toMatchObject({ claimed: 0, drained: 0, failed: 0 });
  });

  it('gives each workspace its own context, never a shared one', async () => {
    // A context reused across workspaces would carry the previous workspace's scope into the next
    // drain, which under row-level security means reading the wrong tenant's rows — or, worse,
    // signalling the wrong tenant's flow.
    const { queue } = fakeQueue([claim('ws-1'), claim('ws-2')]);
    const contexts: RequestContext[] = [];
    const drain: DrainWorkspace = async (context) => {
      contexts.push(context);
    };

    await new FlowRelayWorker(queue, drain).runOnce();

    expect(contexts.map((context) => context.activeWorkspaceId)).toEqual(['ws-1', 'ws-2']);
    expect(contexts[0]).not.toBe(contexts[1]);
    // Distinct correlation ids, so two relayed journeys are distinguishable in the audit record.
    expect(contexts[0]!.correlationId).not.toBe(contexts[1]!.correlationId);
  });
});

describe('one workspace failing does not stop the others', () => {
  it('records the failure and carries on with the rest of the batch', async () => {
    // The property that matters most about this loop. A batch that aborted on the first error would
    // let one broken tenant hold up every other tenant's settlement.
    const { queue, completed, failed } = fakeQueue([claim('ws-ok1'), claim('ws-bad'), claim('ws-ok2')]);
    const drain: DrainWorkspace = async (context) => {
      if (context.activeWorkspaceId === 'ws-bad') throw new Error('FLOW_ADVANCE_DID_NOT_SETTLE');
    };

    const pass = await new FlowRelayWorker(queue, drain).runOnce();

    expect(completed).toEqual(['ws-ok1', 'ws-ok2']);
    expect(failed).toEqual([
      { workspaceId: 'ws-bad', error: 'FLOW_ADVANCE_DID_NOT_SETTLE' },
    ]);
    expect(pass).toMatchObject({ claimed: 3, drained: 2, failed: 1 });
    expect(pass.failures).toEqual([
      { workspaceId: 'ws-bad', error: 'FLOW_ADVANCE_DID_NOT_SETTLE' },
    ]);
  });

  it('reports a dead-letter when the queue says the cap was reached', async () => {
    const { queue } = fakeQueue([claim('ws-dying', 4)]);
    const drain: DrainWorkspace = async () => {
      throw new Error('still broken');
    };

    const pass = await new FlowRelayWorker(queue, drain).runOnce();

    expect(pass).toMatchObject({ failed: 1, deadLettered: 1 });
  });

  it('survives a failure it cannot even record', async () => {
    // The database is unreachable, so `fail` throws too. The pass must still finish: letting this
    // propagate would strand every other claim it holds until their leases expire.
    const queue = {
      async claim() {
        return [claim('ws-1'), claim('ws-2')];
      },
      async complete() {},
      async fail() {
        throw new Error('PERSISTENCE_UNAVAILABLE');
      },
    } as unknown as DurableFlowRelayQueue;
    const drain: DrainWorkspace = async () => {
      throw new Error('drain failed');
    };

    const pass = await new FlowRelayWorker(queue, drain).runOnce();
    expect(pass).toMatchObject({ claimed: 2, drained: 0, failed: 2, deadLettered: 0 });
  });

  it('reports a drain that succeeded but could not be recorded', async () => {
    // The drain worked and the bookkeeping did not, so the lease will expire and the workspace be
    // drained again. Counted as a failure because the queue row is now wrong — and harmless,
    // because `drain` is idempotent and `signal` dedupes on the event id.
    const queue = {
      async claim() {
        return [claim('ws-1')];
      },
      async complete() {
        throw new Error('PERSISTENCE_UNAVAILABLE');
      },
      async fail() {
        return { deadLettered: false };
      },
    } as unknown as DurableFlowRelayQueue;

    const pass = await new FlowRelayWorker(queue, async () => undefined).runOnce();
    expect(pass).toMatchObject({ drained: 0, failed: 1 });
    expect(pass.failures[0]?.error).toBe('PERSISTENCE_UNAVAILABLE');
  });

  it('turns a thrown non-Error into a named failure rather than "undefined"', async () => {
    const { queue, failed } = fakeQueue([claim('ws-1')]);
    // Rejected rather than thrown, so no lint rule about throwing literals is involved: the point
    // is what the worker does with a rejection carrying no `message`, not how it was produced.
    const drain: DrainWorkspace = () => Promise.reject('not an error object');

    await new FlowRelayWorker(queue, drain).runOnce();
    expect(failed[0]?.error).toBe('FLOW_RELAY_DRAIN_FAILED');
  });
});

describe('the loop starts, stops, and does not overlap itself', () => {
  it('schedules one timer however many times it is started', () => {
    const { queue } = fakeQueue([]);
    const worker = new FlowRelayWorker(queue, async () => undefined);
    worker.start(60_000);
    worker.start(60_000);
    expect(worker.started).toBe(true);
    worker.stop();
    expect(worker.started).toBe(false);
  });

  it('refuses to start again once stopped', () => {
    // Shutdown is final. A worker restarted after the pool began closing would make requests against
    // a dying connection for no benefit.
    const { queue } = fakeQueue([]);
    const worker = new FlowRelayWorker(queue, async () => undefined);
    worker.stop();
    worker.start(60_000);
    expect(worker.started).toBe(false);
  });

  it('gives each instance its own lease identity', () => {
    const { queue } = fakeQueue([]);
    const a = new FlowRelayWorker(queue, async () => undefined);
    const b = new FlowRelayWorker(queue, async () => undefined);
    // Two replicas must be distinguishable, or a lease tells an operator nothing about who holds it.
    expect(a.workerId).not.toBe(b.workerId);
  });
});

describe('the worker cannot decide anything', () => {
  it('acts as the system actor, which holds no membership record', () => {
    const context = systemContext(TENANT, 'ws-1');
    expect(context.actorUserId).toBe(FLOW_RELAY_SYSTEM_ACTOR);
    // `FlowOrchestrator.decide` — the one orchestrator method that authorizes — looks for a
    // `memberships` row naming the actor. A well-known non-user id can never match one, so the
    // worker is structurally unable to approve a human task.
    expect(FLOW_RELAY_SYSTEM_ACTOR).not.toMatch(/^user-/);
  });

  it('claims the lowest assurance level, not a convenient one', () => {
    // IAL2 would let the worker satisfy a gate written for a verified human — the canonical flow's
    // enhanced-approval branch, for one. Nothing on the relay path checks assurance, so the honest
    // level costs nothing and the dishonest one would buy authority.
    expect(systemContext(TENANT, 'ws-1').identityAssuranceLevel).toBe('IAL0_UNVERIFIED');
  });

  it('names the workspace in memberships only to establish scope', () => {
    // `requireActiveWorkspace` reads this field to decide whether a caller is operating inside a
    // workspace at all, so it has to be present. It is a different claim from a membership record:
    // this says "scoped here", a record says "has authority here".
    const context = systemContext(TENANT, 'ws-1');
    expect(context.memberships).toEqual(['ws-1']);
    expect(context.activeWorkspaceId).toBe('ws-1');
    expect(context.tenantId).toBe(TENANT);
  });

  it('calls no approval, release or payment primitive anywhere in the worker', () => {
    // CLAUDE.md requires a non-custody assertion from anything on the money-movement path. This
    // worker advances the flow that tracks settlement, so what it owes is proof that advancing
    // cannot become acting: no decide, no approve, no submit, no release.
    const source = readFileSync(path.join(process.cwd(), 'apps/web/lib/flow-relay-worker.ts'), 'utf8')
      // Comments name these words to explain why they are absent; the assertion is about code.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      '.decide(',
      'approve',
      'submitPayment',
      'releaseReservation',
      'holdFunds',
      'paymentInstructions',
      'releaseRequests',
    ]) {
      expect(source, `the worker must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('shares one advance sequence with the manual route rather than reimplementing it', () => {
    // Two implementations of "advance everything" would drift, and the manual route would stop being
    // a faithful way to reproduce what the worker does.
    const route = readFileSync(
      path.join(process.cwd(), 'apps/web/app/api/v1/flows/[id]/advance/route.ts'),
      'utf8',
    );
    const app = readFileSync(path.join(process.cwd(), 'apps/web/lib/flow-app.ts'), 'utf8');
    expect(app).toContain('export async function advanceWorkspace');
    // The route keeps its own per-flow shape because it reports what it did to one flow; what must
    // not diverge is the drain-then-notify order, which both perform.
    expect(route).toContain('flowSignalRelay.drain');
    expect(route).toContain('flowNotifications.dispatch');
  });
});

describe('the relay status route is governed and scoped', () => {
  it('gates the status read on its own grantable key', () => {
    expect(ROUTE_PERMISSION_REQUIREMENTS['/api/v1/flow-relay/status|GET']).toEqual({
      access: 'permission',
      permissionKey: 'flow-relay:read',
    });
    expect(new Set(catalogueKeys())).toContain('flow-relay:read');
  });

  it('reports one workspace and never a list of tenants', () => {
    // The queue table is unscoped by policy because a worker has to find work before it knows whose
    // it is. That is not a licence to hand the same view to a tenant: the workspaces worth naming in
    // a platform-wide list are precisely the ones the caller is not in. Asserted against the source
    // because it is a disclosure boundary, and a later edit that swapped the call would pass every
    // other test in this file.
    const route = readFileSync(
      path.join(process.cwd(), 'apps/web/app/api/v1/flow-relay/status/route.ts'),
      'utf8',
    );
    expect(route).toContain('queue.forWorkspace(');
    expect(route).not.toContain('queue.deadLettered(');
    expect(route).toContain('workspaceScoped(context)');
  });

  it('says plainly when no worker is running rather than reporting health', () => {
    // "This deployment runs no worker" and "nothing is wrong" are different facts, and reporting the
    // first as the second is the false reassurance the whole dead-letter state exists to prevent.
    const route = readFileSync(
      path.join(process.cwd(), 'apps/web/app/api/v1/flow-relay/status/route.ts'),
      'utf8',
    );
    expect(route).toContain("worker: 'UNAVAILABLE'");
    expect(route).toContain('503');
  });
});
