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
      await runTrustPersistenceConformance(inMemoryFactory())
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
    await runTrustPersistenceConformance({
      async create() {
        built += 1;
        return new InMemoryTrustStore();
      },
    });
    expect(built).toBe(TRUST_PERSISTENCE_CONFORMANCE.length);
  });

  it('releases every store it constructed, including after a failing check', async () => {
    // A durable adapter's `create` takes a connection. If a rejected check skipped
    // disposal, a run against Postgres would exhaust the pool partway through and
    // report connection errors in place of the real contract failures.
    const disposed: TrustPersistence[] = [];
    class FailsEverything extends InMemoryTrustStore {
      async list<T>(): Promise<T[]> {
        throw new Error('READ_UNAVAILABLE');
      }
    }

    await runTrustPersistenceConformance({
      async create() {
        return new FailsEverything();
      },
      async dispose(store) {
        disposed.push(store);
      },
    });

    expect(disposed.length).toBe(TRUST_PERSISTENCE_CONFORMANCE.length);
  });

  it('reports a failing disposal rather than letting the leak pass silently', async () => {
    const results = await runTrustPersistenceConformance({
      async create() {
        return new InMemoryTrustStore();
      },
      async dispose() {
        throw new Error('POOL_RELEASE_FAILED');
      },
    });

    const disposalFailures = results.filter(
      (result) => !result.passed && result.failure === 'POOL_RELEASE_FAILED',
    );
    expect(disposalFailures.length).toBe(TRUST_PERSISTENCE_CONFORMANCE.length);
  });

  it('records a construction failure as a failed check, not a thrown run', async () => {
    // An adapter that cannot connect is failing the contract. Throwing out of the
    // runner would make that indistinguishable from a broken harness.
    const results = await runTrustPersistenceConformance({
      async create(): Promise<TrustPersistence> {
        throw new Error('CONNECTION_REFUSED');
      },
    });

    expect(results.length).toBe(TRUST_PERSISTENCE_CONFORMANCE.length);
    expect(results.every((result) => result.failure === 'CONNECTION_REFUSED')).toBe(true);
  });

  it('reports a failing implementation rather than throwing', async () => {
    // The suite must be usable as a report — an adapter under development will
    // fail several checks, and stopping at the first would hide the rest.
    class Broken extends InMemoryTrustStore {
      async list<T>(): Promise<T[]> {
        return [];
      }
    }

    const results = await runTrustPersistenceConformance({
      async create() {
        return new Broken();
      },
    });
    const failures = results.filter((result) => !result.passed);
    expect(failures.length).toBeGreaterThan(3);
    for (const failure of failures) {
      expect(failure.failure?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/** The in-memory store as a conformance factory. No lifecycle to release. */
function inMemoryFactory() {
  return {
    async create(): Promise<TrustPersistence> {
      return new InMemoryTrustStore();
    },
  };
}
