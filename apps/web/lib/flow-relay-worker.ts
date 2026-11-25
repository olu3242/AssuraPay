import { withTrustScope } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import type { ClaimedWorkspace, DurableFlowRelayQueue } from './flow-relay-queue';

/**
 * The worker that makes the canonical chain advance without anyone asking it to.
 *
 * ## What this replaces
 *
 * `FlowSignalRelay.drain` was complete and had one production caller:
 * `POST /api/v1/flows/{id}/advance`, a human action on one flow. So the platform's state was that
 * every engine committed its authoritative event and the flow tracking the journey stayed where it
 * was until somebody remembered. That is not a stalled journey anyone can see — it looks exactly
 * like a journey with nothing to do.
 *
 * `202611250002` holds the queue's design. This is the loop over it.
 *
 * ## The worker's identity, and what it deliberately cannot do
 *
 * A worker has no human behind it, so it acts as `FLOW_RELAY_SYSTEM_ACTOR`. Two properties of that
 * identity matter more than anything else in this file:
 *
 * **It holds no membership record.** `FlowOrchestrator.decide` — the one orchestrator method that
 * authorizes, and the one that approves a human task — checks the `memberships` collection for a row
 * naming the actor. The system actor has none in any workspace, so `decide` refuses it. The worker
 * can therefore evaluate, dispatch and signal, which are the mechanical transitions the domain has
 * already committed to, and cannot make the decision a person is supposed to make. That separation
 * is structural rather than a rule this file follows: there is no code path here that could approve
 * anything, and if one were added it would be refused by the orchestrator.
 *
 * The context does list the workspace in `memberships`, because `requireActiveWorkspace` reads that
 * field to decide whether a caller is operating inside a workspace at all. That is a different claim
 * from a membership *record*: the field says "this request is scoped to this workspace", the record
 * says "this principal has authority here". The worker has the first and not the second.
 *
 * **It is `IAL0_UNVERIFIED`.** Nothing on the relay path checks assurance, so the honest level is the
 * lowest one. Claiming `IAL2_VERIFIED` would be a convenient lie that let a worker satisfy a gate
 * written for a verified human — the enhanced-approval branch of the canonical flow, for one. With
 * IAL0 such a gate refuses the worker loudly, which is the correct outcome.
 *
 * ## Scope
 *
 * `withTrustScope` wraps each workspace's drain, so the scope is established before any read and
 * discarded after. Per workspace rather than per batch, so work on one tenant cannot read or write
 * another's rows even if a bug tried to: row-level security is evaluated against whatever scope is
 * bound, and the bound scope only ever names the workspace currently being drained.
 *
 * ## Failure is per workspace, never per batch
 *
 * One workspace whose drain throws must not stop the others. Each is claimed, drained and settled
 * independently, and a failure is recorded against that workspace alone — counted, backed off and
 * eventually dead-lettered. A batch that aborted on the first error would let one broken tenant hold
 * up every other tenant's settlement, which is the worst available failure mode.
 */

/**
 * The principal the relay acts as.
 *
 * A single well-known id rather than one per workspace, so an audit record written during a relayed
 * transition says plainly that the platform advanced it rather than naming a person who did not.
 */
export const FLOW_RELAY_SYSTEM_ACTOR = 'assurapay-flow-relay';

/**
 * A correlation id, from the platform-neutral `crypto` rather than `node:crypto`.
 *
 * This module is reached from `instrumentation.ts`, which Next compiles for every runtime it builds
 * — including the edge runtime, where a `node:` import is a build error rather than a missing
 * feature at run time. The global is present in Node 18+ and on the edge, so one import works
 * everywhere and the worker stays loadable from the only place it can be started.
 */
function correlation(): string {
  return globalThis.crypto.randomUUID();
}

/** What one drain of one workspace does, injected so the loop can be tested without a flow engine. */
export type DrainWorkspace = (context: RequestContext) => Promise<void>;

export type WorkerPass = {
  claimed: number;
  drained: number;
  failed: number;
  deadLettered: number;
  /** Workspace ids that failed this pass, with why, for the log line and for tests. */
  failures: { workspaceId: string; error: string }[];
};

/**
 * How often the loop looks for work.
 *
 * The queue is event-driven — a workspace becomes due the moment an engine commits an event — so
 * this interval is the worst-case latency between a committed transition and the flow reflecting it,
 * not a polling rate for something that changes slowly. Five seconds keeps that latency human-
 * imperceptible while leaving the claim query, which is a partial-index lookup over the backlog,
 * cheap enough to run indefinitely.
 */
export const DEFAULT_INTERVAL_MS = 5_000;

/** How many workspaces one pass claims. Bounded so a large backlog is drained steadily, not at once. */
export const DEFAULT_BATCH = 10;

export class FlowRelayWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  /** The id this worker leases under. Distinct per instance, so two replicas are distinguishable. */
  readonly workerId: string;

  constructor(
    private readonly queue: DurableFlowRelayQueue,
    private readonly drain: DrainWorkspace,
    options: { workerId?: string; batch?: number } = {},
  ) {
    this.workerId = options.workerId ?? `flow-relay-${correlation()}`;
    this.batch = options.batch ?? DEFAULT_BATCH;
  }

  private readonly batch: number;

  /**
   * One pass: claim what is due, drain each workspace, settle each outcome.
   *
   * Exposed and awaited rather than hidden inside the loop, so a test can assert what one pass does
   * without racing a timer, and so the route that triggers a drain by hand can share the exact code
   * path the worker uses. Two implementations of "advance everything" would drift.
   */
  async runOnce(): Promise<WorkerPass> {
    const claims = await this.queue.claim(this.workerId, this.batch);
    const pass: WorkerPass = {
      claimed: claims.length,
      drained: 0,
      failed: 0,
      deadLettered: 0,
      failures: [],
    };

    for (const claim of claims) {
      // Sequential on purpose. Draining two workspaces at once would double the connection demand
      // for no gain: each drain is a short series of small statements, and the batch is bounded
      // precisely so a backlog is worked steadily rather than all at once.
      const outcome = await this.drainOne(claim);
      if (outcome.ok) {
        pass.drained += 1;
      } else {
        pass.failed += 1;
        pass.failures.push({
          workspaceId: claim.workspaceId,
          error: outcome.error ?? 'FLOW_RELAY_DRAIN_FAILED',
        });
        if (outcome.deadLettered) pass.deadLettered += 1;
      }
    }

    return pass;
  }

  /**
   * Drains one claimed workspace inside its own scope, and settles the queue row either way.
   *
   * One shape for both outcomes rather than a discriminated union. The union read better and did not
   * narrow under the application's own build, and a result type that compiles in two places and not
   * a third is not worth the elegance.
   */
  private async drainOne(
    claim: ClaimedWorkspace,
  ): Promise<{ ok: boolean; error?: string; deadLettered?: boolean }> {
    const context = systemContext(claim.tenantId, claim.workspaceId);
    try {
      await withTrustScope(
        { tenantId: claim.tenantId, workspaceId: claim.workspaceId, actorId: FLOW_RELAY_SYSTEM_ACTOR },
        () => this.drain(context),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'FLOW_RELAY_DRAIN_FAILED';
      // Settling the failure must not itself throw out of the loop, or one unreachable database
      // would strand every claim this pass holds until their leases expire.
      const settled = await this.queue
        .fail(claim, message)
        .catch(() => ({ deadLettered: false }));
      return { ok: false, error: message, deadLettered: settled.deadLettered };
    }

    try {
      await this.queue.complete(claim);
    } catch (error) {
      // The drain succeeded and the bookkeeping did not. Reported as a failure because the queue row
      // is now wrong, and the lease will expire and the workspace be drained again — which is safe,
      // since `signal` dedupes on the event id and `drain` is idempotent by construction.
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'FLOW_RELAY_COMPLETE_FAILED',
        deadLettered: false,
      };
    }
    return { ok: true };
  }

  /**
   * Starts the loop. Idempotent: calling it twice does not create two timers.
   *
   * `unref` so the timer never holds the process open. A worker is not a reason for a server to
   * refuse to exit, and a test that forgot to stop one should not hang the suite.
   */
  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer || this.stopped) return;
    const tick = async () => {
      // Overlapping passes would claim each other's leases and double the work for no benefit. A
      // pass that runs long simply means the next tick does nothing.
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch {
        // A claim query that throws is an infrastructure problem, not a workspace's. Swallowed here
        // because the alternative is an unhandled rejection that takes the process down, and the
        // next tick retries. Per-workspace failures are recorded durably in the queue; this path is
        // only reached when the queue itself is unreachable.
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  /** Stops the loop. Does not cancel a pass already in flight; its leases expire on their own. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether the loop is scheduled, for the readiness surface and for tests. */
  get started(): boolean {
    return this.timer !== undefined;
  }
}

/**
 * The context the relay runs under for one workspace.
 *
 * Exported so the properties the module comment claims can be asserted rather than trusted: that the
 * actor is the system actor, that the assurance level is the lowest one, and that the workspace
 * appears in `memberships` only because `requireActiveWorkspace` reads that field.
 */
export function systemContext(tenantId: string, workspaceId: string): RequestContext {
  const correlationId = correlation();
  return {
    actorUserId: FLOW_RELAY_SYSTEM_ACTOR,
    sessionId: `flow-relay:${correlationId}`,
    // The honest level. See the module comment: IAL2 would let the worker satisfy a gate written for
    // a verified human.
    identityAssuranceLevel: 'IAL0_UNVERIFIED',
    activeWorkspaceId: workspaceId,
    tenantId,
    memberships: [workspaceId],
    correlationId,
  };
}
