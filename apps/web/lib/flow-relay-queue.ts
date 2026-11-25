import type { SqlClient } from '@assurapay/database';

/**
 * The durable queue the flow relay worker claims its work from.
 *
 * `202611250002` holds the design: why the queue is per workspace rather than per event, why the
 * outbox is never marked, why `enqueued_seq` is what makes an event arriving mid-drain survive, and
 * why enqueueing is a trigger rather than something an engine has to remember to call.
 *
 * This module is the small amount of SQL that cannot be expressed through `TrustPersistence`. The
 * port has no `FOR UPDATE SKIP LOCKED` and no conditional update, and both are load-bearing here:
 * the first is what stops two replicas claiming one workspace, and the second is what stops a
 * completing worker discarding work that arrived while it ran. `DurableAssertionReplayStore` exists
 * for the same reason and sits beside this one.
 */

/** A workspace claimed for draining, with the sequence the claim observed. */
export type ClaimedWorkspace = {
  tenantId: string;
  workspaceId: string;
  /**
   * `enqueued_seq` at the moment of the claim. Passed back to `complete` so that an event committed
   * during the drain leaves the workspace due instead of being discarded.
   */
  claimedSeq: string;
  attempts: number;
};

export type DeadLetteredWorkspace = {
  tenantId: string;
  workspaceId: string;
  attempts: number;
  lastError: string | undefined;
  deadLetteredAt: string;
};

/**
 * How long a claim is held before another worker may take it.
 *
 * Long enough that an ordinary drain finishes well inside it, short enough that a worker killed
 * mid-drain does not strand its workspace for long. A lease is a liveness device, not a correctness
 * one: `signal` dedupes on the event id, so the worst case of an expired lease overlapping its
 * original holder is duplicated effort, never duplicated state.
 */
export const LEASE_SECONDS = 120;

/**
 * Consecutive failures before a workspace stops being retried automatically.
 *
 * Five rather than unbounded. A drain that has failed five times in a row is failing for a reason a
 * sixth attempt will not discover, and retrying for ever turns a bug into background load that
 * nobody reads. Dead-lettering makes it a visible finding instead — which is the whole point, since
 * the condition this work exists to remove is a journey that stalls silently.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff before the next attempt, in seconds.
 *
 * Exponential from 15 seconds, capped at ten minutes. Pure and exported so the schedule is asserted
 * rather than observed: a backoff computed inline in SQL would be real but untestable, and a
 * monotonicity bug in it is invisible until a workspace is being retried every 50 milliseconds.
 */
export function backoffSeconds(attempts: number): number {
  const base = 15 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 600);
}

export class DurableFlowRelayQueue {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Claims up to `limit` workspaces that are due, are not leased, and are not backing off.
   *
   * `FOR UPDATE SKIP LOCKED` on the inner select is what makes this safe under concurrency: a row
   * another transaction is claiming is skipped rather than waited for, so two workers racing take
   * disjoint sets and neither blocks. The lease is then written in the same statement, so there is no
   * window between selecting a row and owning it.
   *
   * Ordered by `due_at` so the longest-waiting workspace goes first. Without the ordering a busy
   * workspace could keep jumping the queue and starve a quiet one indefinitely.
   */
  async claim(workerId: string, limit = 10): Promise<ClaimedWorkspace[]> {
    const rows = await this.sql<
      { tenant_id: string; workspace_id: string; claimed_seq: string; attempts: number }[]
    >`
      UPDATE flow_relay_queue AS queue
         SET leased_by = ${workerId},
             leased_until = now() + make_interval(secs => ${LEASE_SECONDS}),
             claimed_seq = queue.enqueued_seq,
             state = 'LEASED'
       WHERE (queue.tenant_id, queue.workspace_id) IN (
               SELECT candidate.tenant_id, candidate.workspace_id
                 FROM flow_relay_queue AS candidate
                WHERE candidate.due_at IS NOT NULL
                  AND candidate.state <> 'DEAD_LETTERED'
                  AND (candidate.leased_until IS NULL OR candidate.leased_until < now())
                  AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= now())
                ORDER BY candidate.due_at
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
             )
      RETURNING queue.tenant_id, queue.workspace_id, queue.claimed_seq::text AS claimed_seq,
                queue.attempts
    `;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      claimedSeq: row.claimed_seq,
      attempts: row.attempts,
    }));
  }

  /**
   * Records a successful drain and releases the lease.
   *
   * `due_at` is cleared **only** when `enqueued_seq` still equals what the claim saw. If an engine
   * committed an event while this workspace was being drained, the trigger bumped the sequence and
   * `due_at` survives, so the worker returns to it. Clearing unconditionally is the bug this
   * condition exists to prevent, and it is the kind that only shows up under load.
   */
  async complete(claim: ClaimedWorkspace): Promise<void> {
    await this.sql`
      UPDATE flow_relay_queue
         SET due_at = CASE WHEN enqueued_seq = ${claim.claimedSeq}::bigint THEN NULL ELSE due_at END,
             attempts = 0,
             next_attempt_at = NULL,
             last_error = NULL,
             last_drained_at = now(),
             leased_by = NULL,
             leased_until = NULL,
             claimed_seq = NULL,
             state = 'IDLE'
       WHERE tenant_id = ${claim.tenantId} AND workspace_id = ${claim.workspaceId}
    `;
  }

  /**
   * Records a failed drain: counts the attempt, schedules the next one, and dead-letters at the cap.
   *
   * `due_at` is deliberately left set. A failure means the work is still outstanding, and clearing it
   * would turn a failing workspace into an idle-looking one — the silent stall again, now with a
   * logged error nobody reads as the only trace.
   *
   * The error text is stored so the dead-letter report can say *why*. It is the message only, never
   * a payload: this row is scheduling metadata and must not become a second place business data
   * lives.
   */
  async fail(claim: ClaimedWorkspace, error: string): Promise<{ deadLettered: boolean }> {
    const attempts = claim.attempts + 1;
    const deadLettered = attempts >= MAX_ATTEMPTS;
    await this.sql`
      UPDATE flow_relay_queue
         SET attempts = ${attempts},
             last_error = ${error.slice(0, 2000)},
             next_attempt_at = now() + make_interval(secs => ${backoffSeconds(attempts)}),
             leased_by = NULL,
             leased_until = NULL,
             claimed_seq = NULL,
             state = ${deadLettered ? 'DEAD_LETTERED' : 'IDLE'},
             -- A CASE rather than a conditionally-built fragment: the two columns must agree or the
             -- flow_relay_queue_dead_letter_whole constraint refuses the row, and one statement that
             -- always sets both is easier to keep true than two code paths.
             dead_lettered_at = CASE WHEN ${deadLettered} THEN now() ELSE NULL END
       WHERE tenant_id = ${claim.tenantId} AND workspace_id = ${claim.workspaceId}
    `;
    return { deadLettered };
  }

  /**
   * One workspace's relay health, for the caller who owns it.
   *
   * Separate from `deadLettered` because the two answer different questions for different people.
   * "Is my workspace's chain advancing?" is a tenant's question and is answered here, scoped to the
   * workspace they asked about. "Which workspaces are stuck?" is a platform-operations question that
   * spans tenants, and is deliberately not reachable through the tenant-facing API — a route
   * returning it would let one tenant's analyst learn that other tenants exist and are in trouble.
   *
   * Returns `undefined` when the workspace has no queue row, which means no orchestrated event has
   * ever been committed for it. That is a real answer and a different one from "up to date".
   */
  async forWorkspace(
    tenantId: string,
    workspaceId: string,
  ): Promise<
    | {
        due: boolean;
        attempts: number;
        lastError: string | undefined;
        lastDrainedAt: string | undefined;
        deadLettered: boolean;
        nextAttemptAt: string | undefined;
      }
    | undefined
  > {
    const [row] = await this.sql<
      {
        due_at: Date | null;
        attempts: number;
        last_error: string | null;
        last_drained_at: Date | null;
        state: string;
        next_attempt_at: Date | null;
      }[]
    >`
      SELECT due_at, attempts, last_error, last_drained_at, state, next_attempt_at
        FROM flow_relay_queue
       WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
    `;
    if (!row) return undefined;
    return {
      due: row.due_at !== null,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      lastDrainedAt: row.last_drained_at?.toISOString(),
      deadLettered: row.state === 'DEAD_LETTERED',
      nextAttemptAt: row.next_attempt_at?.toISOString(),
    };
  }

  /**
   * Every workspace the worker has given up on, across tenants.
   *
   * Platform operations only. This is **not** exposed through the tenant-facing API: see
   * `forWorkspace` for why. It exists for the worker's own reporting and for the suites that prove
   * dead-lettering happens.
   */
  async deadLettered(limit = 100): Promise<DeadLetteredWorkspace[]> {
    const rows = await this.sql<
      {
        tenant_id: string;
        workspace_id: string;
        attempts: number;
        last_error: string | null;
        dead_lettered_at: Date;
      }[]
    >`
      SELECT tenant_id, workspace_id, attempts, last_error, dead_lettered_at
        FROM flow_relay_queue
       WHERE state = 'DEAD_LETTERED'
       ORDER BY dead_lettered_at DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      deadLetteredAt: row.dead_lettered_at.toISOString(),
    }));
  }

  /**
   * Returns a dead-lettered workspace to the queue, as a human decision.
   *
   * There is no automatic path out of the dead-letter state, and that is the point: the state means
   * five attempts failed and somebody needs to look. Reviving it on a timer would recreate the
   * endless retry the cap exists to stop.
   */
  async revive(tenantId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.sql<{ workspace_id: string }[]>`
      UPDATE flow_relay_queue
         SET state = 'IDLE',
             dead_lettered_at = NULL,
             attempts = 0,
             next_attempt_at = NULL,
             due_at = COALESCE(due_at, now())
       WHERE tenant_id = ${tenantId}
         AND workspace_id = ${workspaceId}
         AND state = 'DEAD_LETTERED'
      RETURNING workspace_id
    `;
    return rows.length === 1;
  }

  /** How many workspaces are waiting, for the worker's own reporting. */
  async pending(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM flow_relay_queue
       WHERE due_at IS NOT NULL AND state <> 'DEAD_LETTERED'
    `;
    return Number(row?.count ?? 0);
  }
}
