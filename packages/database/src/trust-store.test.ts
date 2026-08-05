import { describe, expect, it } from 'vitest';
import type { TrustPersistence } from '@assurapay/shared';
import { InMemoryTrustStore } from './trust-store';
import {
  TRUST_PERSISTENCE_CONFORMANCE,
  runTrustPersistenceConformance,
} from './conformance';

/**
 * The conformance suite applied to the only implementation that exists today.
 *
 * A Postgres adapter runs the identical checks by importing the same module, so
 * the two stores are held to one standard rather than to two descriptions of the
 * same intent.
 */

describe('TrustPersistence conformance — InMemoryTrustStore', () => {
  for (const check of TRUST_PERSISTENCE_CONFORMANCE) {
    it(check.name, async () => {
      // Reported through expect so a failure shows the assertion message rather
      // than an opaque thrown error.
      await expect(check.run(new InMemoryTrustStore())).resolves.not.toThrow();
    });
  }
});

describe('TrustPersistence conformance — the suite itself', () => {
  it('passes every check against the in-memory store', async () => {
    const failures = (
      await runTrustPersistenceConformance(() => new InMemoryTrustStore())
    ).filter((result) => !result.passed);
    expect(failures).toEqual([]);
  });

  it('states a rationale for every check', () => {
    // A check without a reason invites deletion the first time it is inconvenient.
    for (const check of TRUST_PERSISTENCE_CONFORMANCE) {
      expect(check.rationale.length, check.name).toBeGreaterThan(40);
      expect(check.name.length, check.name).toBeGreaterThan(10);
    }
  });

  it('names each check uniquely', () => {
    const names = TRUST_PERSISTENCE_CONFORMANCE.map((check) => check.name);
    expect(names).toEqual([...new Set(names)]);
  });

  it('covers the whole interface, not only reads and writes', () => {
    expect(TRUST_PERSISTENCE_CONFORMANCE.length).toBeGreaterThanOrEqual(15);
  });

  it('constructs a fresh store per check, so none can depend on another', async () => {
    // If checks shared a store, one that wrote three records would make a later
    // "one record stored" assertion fail for a correct implementation.
    let built = 0;
    await runTrustPersistenceConformance(() => {
      built += 1;
      return new InMemoryTrustStore();
    });
    expect(built).toBe(TRUST_PERSISTENCE_CONFORMANCE.length);
  });

  it('reports a failing implementation rather than throwing', async () => {
    // The suite must be usable as a report — an adapter under development will
    // fail several checks, and stopping at the first would hide the rest.
    class Broken extends InMemoryTrustStore {
      async list<T>(): Promise<T[]> {
        return [];
      }
    }

    const results = await runTrustPersistenceConformance(() => new Broken());
    const failures = results.filter((result) => !result.passed);
    expect(failures.length).toBeGreaterThan(3);
    for (const failure of failures) {
      expect(failure.failure?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('the repository interface cannot be implemented over a network', () => {
  it('is synchronous in every method, which no network-backed store can satisfy', async () => {
    // CLAUDE.md says Postgres "can be swapped without touching engine logic". That
    // is not true as built: every method returns a value rather than a promise, so
    // a Postgres adapter would have to block on I/O, and making it async would
    // change every engine call site.
    //
    // This is pinned as a test rather than left as a comment so the constraint is
    // discovered by whoever attempts the adapter, at the moment they attempt it.
    const store: TrustPersistence = new InMemoryTrustStore();

    for (const result of [
      await store.list('things'),
      await store.audit({
        actorId: 'user-1',
        eventType: 'Thing',
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        correlationId: 'corr-1',
        metadata: {},
      }),
      await store.emit({
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        eventType: 'Thing',
        eventVersion: 1,
        payload: {},
        correlationId: 'corr-1',
      }),
    ]) {
      expect(result).not.toBeInstanceOf(Promise);
    }
  });
});
