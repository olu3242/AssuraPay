import { describe, expect, it } from 'vitest';
import type { TrustPersistence } from '@assurapay/shared';
import { InMemoryTrustStore } from './trust-store';

/**
 * The asynchronous persistence contract, asserted on the shape callers see.
 *
 * `trust-store.test.ts` proves the in-memory store behaves correctly. This proves
 * something the behavioural checks cannot: that the interface itself is one a
 * network-backed store can implement. Those are different properties, and the
 * second is what `persistence.postgres-repository` was blocked on.
 */

describe('the repository interface can be implemented over a network', () => {
  it('returns a promise from every method, so an adapter may await I/O', async () => {
    // This test previously pinned the opposite: the interface was synchronous in
    // every method, so CLAUDE.md's claim that Postgres "can be swapped without
    // touching engine logic" was false as built. That blocker is what
    // `persistence.async-repository-interface` removed, so the assertion is
    // inverted rather than deleted — the property still needs guarding, in the
    // other direction.
    //
    // Asserted on the un-awaited return value. A method that computed its result
    // synchronously and handed back `Promise.resolve(value)` would satisfy this,
    // which is fine: the caller cannot tell, and the call site is already written
    // to await. What must not compile is a method returning a bare value.
    const store: TrustPersistence = new InMemoryTrustStore();

    const returns = [
      store.list('things'),
      store.append('things', { id: 'thing-1' }),
      store.audit({
        actorId: 'user-1',
        eventType: 'Thing',
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        correlationId: 'corr-1',
        metadata: {},
      }),
      store.emit({
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        eventType: 'Thing',
        eventVersion: 1,
        payload: {},
        correlationId: 'corr-1',
      }),
      store.transaction(async () => undefined),
    ];

    for (const value of returns) {
      expect(typeof (value as { then?: unknown }).then).toBe('function');
    }

    // Awaited so the run leaves no unhandled settlement behind.
    await Promise.all(returns);
  });

  it('exposes no synchronous escape hatch alongside the async contract', async () => {
    // A `listSync` or `auditSync` companion would let a caller keep the old shape
    // and quietly reintroduce a store that cannot be backed by a database. The
    // async contract is only load-bearing if it is the only contract.
    const store = new InMemoryTrustStore() as unknown as Record<string, unknown>;
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
      ...Object.keys(store),
    ];

    expect(surface.filter((name) => /sync$/i.test(name))).toEqual([]);
  });
});
