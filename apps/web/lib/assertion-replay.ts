import type { AssertionReplayStore, ReplayProtectionGuarantee } from '@assurapay/identity';
import type { SqlClient } from '@assurapay/database';

/**
 * Assertion replay protection that holds across replicas.
 *
 * `InMemoryAssertionReplayStore` is correct within one Node process and worth nothing across two:
 * replicas share no map, so the same assertion authorises one action per instance. That was
 * harmless while nothing consumed an assertion and became the live guarantee the moment acting
 * routes did, which is why this exists.
 *
 * ## Why it lives in the composition root
 *
 * It binds two packages that must not depend on each other: the `AssertionReplayStore` contract
 * belongs to `@assurapay/identity`, and `SqlClient` to `@assurapay/database`. Identity has no
 * business knowing about SQL and the database package has no business knowing about assertions, so
 * the adapter belongs where both are already in scope — the same reasoning that put
 * `governed-analysis.ts` here.
 *
 * ## One statement, because two would be a race
 *
 * The contract is explicit that `consumeIfAbsent` must decide in a single atomic step, and that
 * returning a promise is not licence to check, await, then insert. `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING nonce` satisfies it by construction: PostgreSQL resolves the conflict against
 * the primary key inside one statement, so of two concurrent callers presenting the same nonce
 * exactly one gets a row back. No advisory lock, no transaction, no read-modify-write.
 */
export class DurableAssertionReplayStore implements AssertionReplayStore {
  readonly guarantee: ReplayProtectionGuarantee = 'distributed';

  /**
   * How many expired nonces one call may delete.
   *
   * Pruning happens here rather than in a background job because this platform has no worker to run
   * one, and a table written once per acting request must not grow forever. The bound is what keeps
   * it honest: an unbounded `DELETE ... WHERE expires_at <= now()` would put an arbitrarily long
   * statement on an ordinary request's critical path the first time a backlog built up. A small
   * batch per request drains steadily and costs a predictable amount.
   */
  private static readonly PRUNE_BATCH = 50;

  constructor(private readonly sql: SqlClient) {}

  async consumeIfAbsent(nonce: string, expiresAt: string, now: Date = new Date()): Promise<boolean> {
    // Pruned before the insert and deliberately not awaited together with it: a failed prune must
    // never fail a request. Losing a prune leaves garbage; refusing the insert refuses a legitimate
    // action, which is the worse outcome by far.
    await this.prune(now).catch(() => undefined);

    // `expiresAt` is the verifier's own window, so pruning later agrees with what the verifier
    // judged rather than with this process's clock.
    const won = await this.sql<{ nonce: string }[]>`
      INSERT INTO trust_assertion_nonces (nonce, expires_at, consumed_at)
      VALUES (${nonce}, ${expiresAt}, ${now.toISOString()})
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce
    `;
    return won.length > 0;
  }

  /**
   * Deletes a bounded batch of nonces the verifier would no longer accept anyway.
   *
   * Keyed on the caller's `now` rather than the database's, for the same reason the in-memory store
   * prunes on the verifier clock: a guard pruning on a clock the verifier did not use could drop a
   * nonce an assertion still considers live and silently re-admit the replay it exists to stop.
   */
  private async prune(now: Date): Promise<void> {
    await this.sql`
      DELETE FROM trust_assertion_nonces
       WHERE nonce IN (
         SELECT nonce FROM trust_assertion_nonces
          WHERE expires_at <= ${now.toISOString()}
          LIMIT ${DurableAssertionReplayStore.PRUNE_BATCH}
       )
    `;
  }

  /** Spent nonces the verifier would still honour, for evidence and for tests. */
  async liveCount(now: Date = new Date()): Promise<number> {
    const [row] = await this.sql<{ live: string }[]>`
      SELECT count(*)::text AS live FROM trust_assertion_nonces WHERE expires_at > ${now.toISOString()}
    `;
    return Number(row?.live ?? 0);
  }
}
