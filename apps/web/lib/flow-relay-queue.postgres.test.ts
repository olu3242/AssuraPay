import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import {
  DurableFlowRelayQueue,
  MAX_ATTEMPTS,
  backoffSeconds,
  type ClaimedWorkspace,
} from './flow-relay-queue';

/**
 * integration: one workspace is drained by one worker, and nothing is lost when it is not.
 *
 * The queue's whole purpose is to be correct when more than one process is running, so almost
 * nothing here can be proved in memory. Three properties need a real database:
 *
 * 1. **Two workers never claim one workspace.** `FOR UPDATE SKIP LOCKED` is the mechanism; a map
 *    with a boolean would "prove" it while testing nothing. Two independent queue instances stand in
 *    for two replicas, exactly as the assertion-replay suite does for identity nonces.
 * 2. **An event committed during a drain is not discarded.** This is the bug a simpler design ships:
 *    the worker clears `due_at` on success, and without the sequence check that clear throws away
 *    work that arrived while it ran. Reproduced by bumping the sequence between claim and complete.
 * 3. **The enqueue cannot be forgotten**, because it is a trigger. Asserted by writing an outbox
 *    event and finding the workspace due, with nothing in between.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

const TENANT = 'tenant-relay';

/**
 * Makes a workspace due, the way the queue is meant to be filled: by writing to the outbox.
 *
 * Written inside a bound tenant scope, because `trust_outbox_events` is under forced row-level
 * security and an unscoped insert is refused. That refusal is correct and worth noting here rather
 * than working around quietly: it means the enqueue trigger only ever fires for an event some
 * scoped caller was entitled to write, so the queue cannot be filled by an unscoped process.
 */
async function emit(
  database: TestDatabase,
  workspaceId: string,
  eventId = `evt-${Math.random().toString(36).slice(2)}`,
): Promise<void> {
  await database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`
      INSERT INTO trust_outbox_events
        (event_id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type,
         event_version, payload, correlation_id)
      VALUES (${eventId}, ${TENANT}, ${workspaceId}, 'Invoice', 'inv-1', 'InvoiceSubmitted',
              1, '{}'::jsonb, 'corr-1')
    `;
  });
}

/** The queue row as stored, for assertions about scheduling state. */
async function row(database: TestDatabase, workspaceId: string) {
  const [found] = await database.sql<
    {
      due_at: Date | null;
      enqueued_seq: string;
      attempts: number;
      state: string;
      leased_by: string | null;
      next_attempt_at: Date | null;
      last_error: string | null;
    }[]
  >`
    SELECT due_at, enqueued_seq::text AS enqueued_seq, attempts, state, leased_by,
           next_attempt_at, last_error
      FROM flow_relay_queue
     WHERE tenant_id = ${TENANT} AND workspace_id = ${workspaceId}
  `;
  return found;
}

describe('the queue fills itself from the outbox', () => {
  it('makes a workspace due when a domain event is committed, with no application code involved', async () => {
    const database = await migratedDatabase();
    // Nothing exists for this workspace yet.
    expect(await row(database, 'ws-trigger')).toBeUndefined();

    await emit(database, 'ws-trigger');

    const enqueued = await row(database, 'ws-trigger');
    expect(enqueued?.due_at).not.toBeNull();
    expect(enqueued?.state).toBe('IDLE');
    expect(enqueued?.enqueued_seq).toBe('1');
  }, 120_000);

  it('keeps the earliest due time and counts every event, so a burst cannot push a workspace later', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-burst', 'evt-first');
    const first = await row(database, 'ws-burst');

    await emit(database, 'ws-burst', 'evt-second');
    await emit(database, 'ws-burst', 'evt-third');
    const after = await row(database, 'ws-burst');

    // The due time did not move forward. If it took the latest event's time instead, a workspace
    // receiving a steady stream would keep deferring its own turn and never be drained.
    expect(after?.due_at?.toISOString()).toBe(first?.due_at?.toISOString());
    expect(after?.enqueued_seq).toBe('3');
  }, 120_000);

  it('ignores an event that belongs to no workspace', async () => {
    const database = await migratedDatabase();
    // The identity plane emits unscoped events; they are not orchestrated and there is no workspace
    // to make due. A queue row keyed on a null workspace could not be claimed at all.
    await database.sql`
      INSERT INTO trust_outbox_events
        (event_id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type,
         event_version, payload, correlation_id)
      VALUES ('evt-unscoped', NULL, NULL, 'UserIdentity', 'user-1', 'UserRegistered',
              1, '{}'::jsonb, 'corr-1')
    `;
    const [{ count }] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM flow_relay_queue
    `;
    expect(count).toBe('0');
  }, 120_000);
});

describe('one workspace is claimed by one worker', () => {
  it('gives a claimed workspace to exactly one of two racing workers', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-race');

    // Two instances standing in for two replicas. They share nothing but the database, which is the
    // only thing two replicas do share.
    const workerA = new DurableFlowRelayQueue(database.sql);
    const workerB = new DurableFlowRelayQueue(database.sql);

    const [claimsA, claimsB] = await Promise.all([workerA.claim('worker-a'), workerB.claim('worker-b')]);
    const all = [...claimsA, ...claimsB].filter((claim) => claim.workspaceId === 'ws-race');

    // Exactly one. Not "at most one" — the work must actually be handed to somebody, or a lease that
    // nobody can take is just a stall with extra steps.
    expect(all).toHaveLength(1);
  }, 120_000);

  it('passes over a workspace another worker already holds', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-held');
    const queue = new DurableFlowRelayQueue(database.sql);

    const first = await queue.claim('worker-a');
    expect(first.map((claim) => claim.workspaceId)).toEqual(['ws-held']);

    // Sequentially now, so this is about the lease rather than about row locking.
    const second = await queue.claim('worker-b');
    expect(second).toEqual([]);
  }, 120_000);

  it('lets another worker take over once a lease has expired', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-expired');
    const queue = new DurableFlowRelayQueue(database.sql);

    const held = await queue.claim('worker-a');
    expect(held).toHaveLength(1);

    // A worker killed mid-drain leaves its lease behind. Expiring it by hand rather than waiting two
    // minutes: the property is that an expired lease is claimable, not that time passes.
    await database.sql`
      UPDATE flow_relay_queue SET leased_until = now() - interval '1 second'
       WHERE tenant_id = ${TENANT} AND workspace_id = 'ws-expired'
    `;

    const taken = await queue.claim('worker-b');
    expect(taken.map((claim) => claim.workspaceId)).toEqual(['ws-expired']);
  }, 120_000);

  it('claims nothing when every workspace is up to date', async () => {
    const database = await migratedDatabase();
    const queue = new DurableFlowRelayQueue(database.sql);
    expect(await queue.claim('worker-a')).toEqual([]);
    expect(await queue.pending()).toBe(0);
  }, 120_000);
});

describe('completing a drain does not discard work that arrived during it', () => {
  it('clears the workspace when nothing happened while it was draining', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-quiet');
    const queue = new DurableFlowRelayQueue(database.sql);

    const [claim] = await queue.claim('worker-a');
    await queue.complete(claim);

    const settled = await row(database, 'ws-quiet');
    expect(settled?.due_at).toBeNull();
    expect(settled?.state).toBe('IDLE');
    expect(settled?.leased_by).toBeNull();
    expect(settled?.attempts).toBe(0);
    expect(await queue.pending()).toBe(0);
  }, 120_000);

  it('leaves the workspace due when an event was committed mid-drain', async () => {
    // The property the whole `enqueued_seq` design exists for, and the one a unit test with a fake
    // clock cannot reach: the trigger fires inside another transaction while this worker holds the
    // claim.
    const database = await migratedDatabase();
    await emit(database, 'ws-midflight', 'evt-before');
    const queue = new DurableFlowRelayQueue(database.sql);

    const [claim] = await queue.claim('worker-a');

    // An engine commits an event while the drain is in progress.
    await emit(database, 'ws-midflight', 'evt-during');

    await queue.complete(claim);

    const after = await row(database, 'ws-midflight');
    // Still due. Clearing it here would strand the journey until some unrelated later event
    // happened to re-arm the workspace.
    expect(after?.due_at).not.toBeNull();
    expect(await queue.pending()).toBe(1);

    // And it is claimable again, so the work is genuinely recoverable rather than merely marked.
    const again = await queue.claim('worker-b');
    expect(again.map((entry) => entry.workspaceId)).toEqual(['ws-midflight']);
  }, 120_000);
});

describe('a failing drain backs off and is eventually dead-lettered', () => {
  it('counts the attempt, schedules a later one, and keeps the work outstanding', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-failing');
    const queue = new DurableFlowRelayQueue(database.sql);

    const [claim] = await queue.claim('worker-a');
    const { deadLettered } = await queue.fail(claim, 'FLOW_ADVANCE_DID_NOT_SETTLE');
    expect(deadLettered).toBe(false);

    const after = await row(database, 'ws-failing');
    expect(after?.attempts).toBe(1);
    expect(after?.last_error).toBe('FLOW_ADVANCE_DID_NOT_SETTLE');
    expect(after?.state).toBe('IDLE');
    expect(after?.leased_by).toBeNull();
    // Still due: the work did not happen, and an idle-looking failing workspace is the silent stall
    // this table exists to remove.
    expect(after?.due_at).not.toBeNull();
    // And not claimable yet, because it is backing off.
    expect(await queue.claim('worker-b')).toEqual([]);
  }, 120_000);

  it('dead-letters after the cap, and stops offering the workspace', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-dead');
    const queue = new DurableFlowRelayQueue(database.sql);

    let lastDeadLettered = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Clear the backoff so the loop does not have to wait out the schedule it is not testing.
      await database.sql`
        UPDATE flow_relay_queue SET next_attempt_at = NULL
         WHERE tenant_id = ${TENANT} AND workspace_id = 'ws-dead'
      `;
      const claims = await queue.claim('worker-a');
      expect(claims, `attempt ${attempt} should still be offered`).toHaveLength(1);
      lastDeadLettered = (await queue.fail(claims[0]!, `failure ${attempt}`)).deadLettered;
    }

    expect(lastDeadLettered).toBe(true);
    const dead = await row(database, 'ws-dead');
    expect(dead?.state).toBe('DEAD_LETTERED');
    expect(dead?.attempts).toBe(MAX_ATTEMPTS);

    // Never offered again, even with the backoff cleared. An endless retry is what the cap removes.
    await database.sql`
      UPDATE flow_relay_queue SET next_attempt_at = NULL
       WHERE tenant_id = ${TENANT} AND workspace_id = 'ws-dead'
    `;
    expect(await queue.claim('worker-a')).toEqual([]);

    // And it is reportable, which is the point of a state rather than a deletion.
    const reported = await queue.deadLettered();
    expect(reported.map((entry) => entry.workspaceId)).toContain('ws-dead');
    expect(reported.find((entry) => entry.workspaceId === 'ws-dead')?.lastError).toBe(
      `failure ${MAX_ATTEMPTS}`,
    );
  }, 300_000);

  it('returns a dead-lettered workspace to the queue only when asked', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-revive');
    const queue = new DurableFlowRelayQueue(database.sql);
    await database.sql`
      UPDATE flow_relay_queue
         SET state = 'DEAD_LETTERED', dead_lettered_at = now(), attempts = ${MAX_ATTEMPTS}
       WHERE tenant_id = ${TENANT} AND workspace_id = 'ws-revive'
    `;

    expect(await queue.claim('worker-a')).toEqual([]);
    expect(await queue.revive(TENANT, 'ws-revive')).toBe(true);

    const revived = await queue.claim('worker-a');
    expect(revived.map((entry) => entry.workspaceId)).toEqual(['ws-revive']);

    // Reviving something that is not dead-lettered changes nothing and says so, rather than
    // silently resetting a healthy row's attempt count.
    expect(await queue.revive(TENANT, 'ws-revive')).toBe(false);
    expect(await queue.revive(TENANT, 'ws-never-existed')).toBe(false);
  }, 120_000);

  it('forgets the failures once a drain succeeds', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-recovered');
    const queue = new DurableFlowRelayQueue(database.sql);

    const [failing] = await queue.claim('worker-a');
    await queue.fail(failing, 'transient');
    await database.sql`
      UPDATE flow_relay_queue SET next_attempt_at = NULL
       WHERE tenant_id = ${TENANT} AND workspace_id = 'ws-recovered'
    `;

    const [retry] = await queue.claim('worker-a');
    expect(retry.attempts).toBe(1);
    await queue.complete(retry);

    const after = await row(database, 'ws-recovered');
    // A workspace that fails once and then succeeds must not carry the failure toward the cap, or a
    // flaky dependency would dead-letter a workspace that is working.
    expect(after?.attempts).toBe(0);
    expect(after?.last_error).toBeNull();
    expect(after?.next_attempt_at).toBeNull();
  }, 120_000);
});

describe('the backoff schedule', () => {
  it('grows and then stops growing', () => {
    expect(backoffSeconds(1)).toBe(15);
    expect(backoffSeconds(2)).toBe(30);
    expect(backoffSeconds(3)).toBe(60);
    // Capped, so a long-dead workspace is not retried once a century.
    expect(backoffSeconds(50)).toBe(600);
  });

  it('never returns zero or a decreasing interval', () => {
    // A zero or non-monotonic backoff turns a failing workspace into a hot loop, which is invisible
    // until it is the only thing the database is doing.
    let previous = 0;
    for (let attempts = 1; attempts <= 20; attempts += 1) {
      const seconds = backoffSeconds(attempts);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeGreaterThanOrEqual(previous);
      previous = seconds;
    }
  });

  it('treats a nonsense attempt count as a first attempt rather than throwing', () => {
    // `attempts` comes from the database and should never be below one here, but a backoff that
    // throws would turn a bad row into a worker that cannot run at all.
    expect(backoffSeconds(0)).toBe(15);
    expect(backoffSeconds(-5)).toBe(15);
  });
});

describe('the queue holds no business data', () => {
  it('stores only scheduling metadata, by column', async () => {
    // The table is unscoped by policy, so what it may hold is a security property rather than a
    // style preference: an unscoped table containing an amount, a party or a payload would disclose
    // business data across tenants. Asserted against the live schema so a later column addition has
    // to be considered rather than merely merged.
    const database = await migratedDatabase();
    const columns = (
      await database.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'flow_relay_queue' ORDER BY column_name
      `
    ).map((entry) => entry.column_name);

    expect(columns).toEqual([
      'attempts',
      'claimed_seq',
      'dead_lettered_at',
      'due_at',
      'enqueued_seq',
      'last_drained_at',
      'last_error',
      'leased_by',
      'leased_until',
      'next_attempt_at',
      'state',
      'tenant_id',
      'workspace_id',
    ]);
  }, 120_000);

  it('moves no money and instructs no provider', async () => {
    // CLAUDE.md requires a non-custody assertion from anything touching the money-movement path.
    // This worker advances the flow that *tracks* settlement, so the assertion it owes is that it
    // cannot itself release, hold or instruct: the queue speaks only to its own table.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(
      path.join(process.cwd(), 'apps/web/lib/flow-relay-queue.ts'),
      'utf8',
    );
    for (const forbidden of [
      'release_requests',
      'payment_instructions',
      'fund_reservations',
      'holdFunds',
      'submitPayment',
      'trust_records',
    ]) {
      expect(source, `the relay queue must not touch ${forbidden}`).not.toContain(forbidden);
    }
    // Every statement in the module names this one table and no other.
    const tables = [...source.matchAll(/(?:FROM|UPDATE|INSERT INTO)\s+([a-z_]+)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(tables)]).toEqual(['flow_relay_queue']);
  });
});

describe('a claim is not a promise about the work', () => {
  it('reports the sequence it observed, so the caller can complete honestly', async () => {
    const database = await migratedDatabase();
    await emit(database, 'ws-seq');
    const queue = new DurableFlowRelayQueue(database.sql);
    const [claim] = await queue.claim('worker-a');

    const expected: ClaimedWorkspace = {
      tenantId: TENANT,
      workspaceId: 'ws-seq',
      claimedSeq: '1',
      attempts: 0,
    };
    expect(claim).toEqual(expected);
  }, 120_000);
});
