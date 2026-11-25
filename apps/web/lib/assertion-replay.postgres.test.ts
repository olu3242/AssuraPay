import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import { DurableAssertionReplayStore } from './assertion-replay';

/**
 * integration: an assertion nonce is spent once, across replicas.
 *
 * Replay protection is the one control whose whole value is in being shared. The in-memory store is
 * correct within a process and worth nothing across two, so for a deployment behind a load balancer
 * the same assertion authorised one action per instance — and because `loadGatewayConfig` demands
 * distributed protection under production, every deployment had to set
 * `IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY` and declare itself single-instance.
 *
 * The property under test is therefore not "the same object refuses twice" — a map does that — but
 * that two *independent* stores, standing in for two replicas that share nothing but the database,
 * cannot both spend one nonce. That can only be proved against a real database, and it is why this
 * suite exists rather than a unit test with a fake.
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

const NOW = new Date('2026-11-25T09:00:00.000Z');
const soon = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('integration: the durable replay store', () => {
  it('declares a distributed guarantee, which is the point of it existing', async () => {
    const database = await migratedDatabase();
    // Asserted because the gateway reads exactly this to decide whether a production deployment may
    // start. A store that lied here would let a scaled deployment boot with no real protection.
    expect(new DurableAssertionReplayStore(database.sql).guarantee).toBe('distributed');
  }, 300_000);

  it('spends a nonce once, and refuses the second caller', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    expect(await store.consumeIfAbsent('nonce-once', soon(60_000), NOW)).toBe(true);
    expect(await store.consumeIfAbsent('nonce-once', soon(60_000), NOW)).toBe(false);
  }, 300_000);

  it('refuses a replay presented to a different replica', async () => {
    const database = await migratedDatabase();
    // Two stores over one database: what two application instances are. Neither shares memory with
    // the other, so anything that refuses the second call here is the database doing it.
    const replicaA = new DurableAssertionReplayStore(database.sql);
    const replicaB = new DurableAssertionReplayStore(database.sql);

    expect(await replicaA.consumeIfAbsent('nonce-shared', soon(60_000), NOW)).toBe(true);
    expect(await replicaB.consumeIfAbsent('nonce-shared', soon(60_000), NOW)).toBe(false);
  }, 300_000);

  it('lets exactly one of two concurrent callers win', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    // The race the contract forbids losing. A check-then-insert implementation passes the
    // sequential tests above and fails this one, which is why it is here: both calls start before
    // either finishes, so only `INSERT ... ON CONFLICT DO NOTHING` resolving inside one statement
    // produces a single winner.
    const outcomes = await Promise.all([
      store.consumeIfAbsent('nonce-raced', soon(60_000), NOW),
      store.consumeIfAbsent('nonce-raced', soon(60_000), NOW),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  }, 300_000);

  it('treats two different nonces as independent', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    expect(await store.consumeIfAbsent('nonce-a', soon(60_000), NOW)).toBe(true);
    expect(await store.consumeIfAbsent('nonce-b', soon(60_000), NOW)).toBe(true);
  }, 300_000);

  it('prunes spent nonces the verifier would no longer accept, so the table stays bounded', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    await store.consumeIfAbsent('nonce-live', soon(600_000), NOW);
    await store.consumeIfAbsent('nonce-stale', soon(-600_000), NOW);
    expect(await store.liveCount(NOW)).toBe(1);

    // Pruning happens on the next consume, because this platform has no worker to run it. The call
    // below both spends its own nonce and clears the expired one.
    await store.consumeIfAbsent('nonce-trigger', soon(600_000), NOW);
    const [remaining] = await database.sql<{ total: string }[]>`
      SELECT count(*)::text AS total FROM trust_assertion_nonces
    `;
    // Two live, and the stale one gone — not merely hidden from a filtered count.
    expect(Number(remaining.total)).toBe(2);
  }, 300_000);

  it('prunes on the verifier’s clock, never on its own', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    // A nonce that expired against wall-clock but is still live against the instant the verifier
    // judged. Pruning on the database's `now()` would delete it and silently re-admit the replay the
    // guard exists to stop, so the deletion predicate has to use the caller's instant.
    const past = new Date(Date.now() - 600_000);
    await store.consumeIfAbsent('nonce-verifier-clock', new Date(Date.now() - 300_000).toISOString(), past);
    expect(await store.consumeIfAbsent('nonce-verifier-clock', new Date(Date.now() - 300_000).toISOString(), past)).toBe(
      false,
    );
  }, 300_000);

  it('keeps a nonce readable and writable with no tenant scope', async () => {
    const database = await migratedDatabase();
    const store = new DurableAssertionReplayStore(database.sql);

    // The condition registration and tenant founding run under. An assertion is consumed before the
    // caller's tenant is known — establishing that the assertion presenting the tenant is unspent is
    // the reason to consume it — so a tenant-scoped policy here would refuse exactly the requests
    // that most need replay protection. No scope is set anywhere in this suite, which is the proof.
    expect(await store.consumeIfAbsent('nonce-unscoped', soon(60_000), NOW)).toBe(true);
    expect(await store.liveCount(NOW)).toBeGreaterThan(0);
  }, 300_000);
});
