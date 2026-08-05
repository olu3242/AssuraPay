import { createHash } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import { auditIntegrityHash } from '@assurapay/shared';

/**
 * Executable specification for `TrustPersistence`.
 *
 * Every engine in the platform reads and writes through this interface, and the
 * audit hash chain that CLAUDE.md constraint 3 rests on is computed inside it —
 * yet no test exercised it directly. The behaviour every engine depends on was
 * whatever the one implementation happened to do.
 *
 * This states that behaviour as checks any implementation must pass, so a second
 * implementation — the Postgres adapter `persistence.postgres-repository` calls
 * for — has a definition of done that is not "it compiles". A store that stores
 * and returns rows is easy; a store that preserves append-only semantics, hands
 * out copies rather than live references, and continues the hash chain correctly
 * is the actual contract, and each of those is a way an adapter can be subtly
 * wrong while appearing to work.
 *
 * Deliberately free of any test framework. A future integration test running this
 * against a live database imports the same checks rather than a reimplementation
 * of them, which is the only way the two stores are held to one standard.
 */

export type ConformanceCheck = {
  name: string;
  /** Why an implementation getting this wrong matters. */
  rationale: string;
  /**
   * Asynchronous, because the repository contract is. A synchronous signature
   * would still typecheck — TypeScript accepts a Promise where void is expected —
   * while the runner discarded the promise, so a failing check reported success
   * and its rejection escaped as an unhandled one.
   */
  run: (store: TrustPersistence, collections: ConformanceCollections) => Promise<void>;
};

/**
 * Collection names a check may write to.
 *
 * Supplied by the factory rather than hard-coded, because a durable adapter maps
 * collections onto real tables and cannot serve an invented name — `PostgresTrustStore`
 * refuses one outright, which is the correct behaviour and would otherwise make the
 * shared suite unrunnable against it. The contract under test is the store's behaviour,
 * not its vocabulary, so each adapter names three collections it legitimately serves and
 * one it never will.
 */
export type ConformanceCollections = {
  /** Where most checks write. */
  primary: string;
  /** A second collection, for proving the two stay independent. */
  secondary: string;
  /** A third, used only by the independence check. */
  tertiary: string;
  /** A collection that will never have been written to. */
  absent: string;
};

/** The names the in-memory store uses, and the default for any factory that omits them. */
export const DEFAULT_CONFORMANCE_COLLECTIONS: ConformanceCollections = Object.freeze({
  primary: 'things',
  secondary: 'alpha',
  tertiary: 'beta',
  absent: 'nothing-here',
});

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message}: expected ${b}, got ${a}`);
}

function auditInput(overrides: Partial<AuditRecord> = {}) {
  return {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    actorId: 'user-1',
    eventType: 'ThingHappened',
    aggregateType: 'Thing',
    aggregateId: 'thing-1',
    correlationId: 'corr-1',
    metadata: {} as Record<string, unknown>,
    ...overrides,
  };
}

/**
 * The checks, in the order an implementer would most usefully meet them.
 *
 * Each receives a store the caller has just constructed, so no check may depend
 * on another having run.
 */
export const TRUST_PERSISTENCE_CONFORMANCE: readonly ConformanceCheck[] = Object.freeze([
  {
    name: 'returns an empty list for a collection never written to',
    rationale:
      'Engines filter the result immediately. Returning undefined or throwing would make every read site defensive.',
    async run(store, collections) {
      assertEqual(await store.list(collections.absent), [], 'unknown collection');
    },
  },
  {
    name: 'reads back what was appended, in append order',
    rationale:
      'Order is meaning here: the audit chain, the ledger and every history read assume the store preserves it.',
    async run(store, collections) {
      for (const id of ['a', 'b', 'c']) await store.append(collections.primary, { id });
      assertEqual(
        (await store.list<{ id: string }>(collections.primary)).map((thing) => thing.id),
        ['a', 'b', 'c'],
        'append order',
      );
    },
  },
  {
    name: 'keeps collections independent',
    rationale: 'A shared namespace would let one aggregate’s writes appear in another’s history.',
    async run(store, collections) {
      await store.append(collections.secondary, { id: 'a' });
      await store.append(collections.tertiary, { id: 'b' });
      assertEqual((await store.list<{ id: string }>(collections.secondary)).map((x) => x.id), ['a'], 'secondary');
      assertEqual((await store.list<{ id: string }>(collections.tertiary)).map((x) => x.id), ['b'], 'tertiary');
    },
  },
  {
    name: 'hands out a copy, so a reader cannot mutate stored state',
    rationale:
      'Returning live references would let any caller edit history in place — the precise thing CLAUDE.md constraint 3 forbids — with no write call to audit.',
    async run(store, collections) {
      await store.append(collections.primary, { id: 'a', value: 1 });
      const first = await store.list<{ id: string; value: number }>(collections.primary);
      first[0].value = 999;
      first.push({ id: 'injected', value: 0 });

      const second = await store.list<{ id: string; value: number }>(collections.primary);
      assertEqual(second.length, 1, 'reader push must not reach the store');
      assertEqual(second[0].value, 1, 'reader mutation must not reach the store');
    },
  },
  {
    name: 'copies on write, so mutating the argument afterwards changes nothing',
    rationale:
      'A caller reusing a builder object would otherwise retroactively alter records it already wrote.',
    async run(store, collections) {
      const record = { id: 'a', value: 1 };
      await store.append(collections.primary, record);
      record.value = 999;
      assertEqual((await store.list<{ value: number }>(collections.primary))[0].value, 1, 'stored value');
    },
  },
  {
    name: 'replaces a record in place, preserving its position',
    rationale: 'Reordering on update would corrupt every order-dependent read.',
    async run(store, collections) {
      for (const id of ['a', 'b', 'c']) await store.append(collections.primary, { id, value: 0 });
      await store.replace(collections.primary, { id: 'b', value: 7 });

      const things = await store.list<{ id: string; value: number }>(collections.primary);
      assertEqual(things.map((thing) => thing.id), ['a', 'b', 'c'], 'order after replace');
      assertEqual(things[1].value, 7, 'replaced value');
    },
  },
  {
    name: 'refuses to replace a record that does not exist',
    rationale:
      'Silently inserting would turn a failed update into a duplicate, and the caller would never learn the record it meant to change was gone.',
    async run(store, collections) {
      let threw = false;
      try {
        await store.replace(collections.primary, { id: 'missing' });
      } catch {
        threw = true;
      }
      assert(threw, 'replace of an absent id must throw');
      assertEqual(await store.list(collections.primary), [], 'nothing inserted');
    },
  },
  {
    name: 'stamps every audit record with an id, a timestamp and an integrity hash',
    rationale: 'A record missing any of these cannot be located, ordered or verified.',
    async run(store, collections) {
      const record = await store.audit(auditInput());
      assert(record.id.length > 0, 'id');
      assert(!Number.isNaN(Date.parse(record.createdAt)), 'createdAt must parse');
      assert(/^[0-9a-f]{64}$/.test(record.integrityHash), 'integrityHash must be hex sha256');
    },
  },
  {
    name: 'leaves the first audit record unlinked',
    rationale:
      'A genesis record pointing at a predecessor would mean records are missing, so it must not be the normal state.',
    async run(store, collections) {
      assertEqual((await store.audit(auditInput())).previousHash, undefined, 'genesis previousHash');
    },
  },
  {
    name: 'chains each audit record to the one before it',
    rationale:
      'The link is what makes deletion and reordering detectable. Without it the records are a list, not a ledger.',
    async run(store, collections) {
      const first = await store.audit(auditInput());
      const second = await store.audit(auditInput({ aggregateId: 'thing-2' }));
      const third = await store.audit(auditInput({ aggregateId: 'thing-3' }));

      assertEqual(second.previousHash, first.integrityHash, 'second link');
      assertEqual(third.previousHash, second.integrityHash, 'third link');
    },
  },
  {
    name: 'chains across aggregates and workspaces, not per stream',
    rationale:
      'A per-stream chain lets an entire stream be dropped without breaking any link that remains.',
    async run(store, collections) {
      const first = await store.audit(auditInput({ workspaceId: 'workspace-1' }));
      const second = await store.audit(
        auditInput({ workspaceId: 'workspace-2', aggregateType: 'Other' }),
      );
      assertEqual(second.previousHash, first.integrityHash, 'cross-stream link');
    },
  },
  {
    name: 'gives different content different hashes',
    rationale:
      'A hash that ignores part of the record leaves that part editable without detection.',
    async run(store, collections) {
      const first = await store.audit(auditInput({ metadata: { value: 1 } }));
      const second = await store.audit(auditInput({ metadata: { value: 2 } }));
      assert(first.integrityHash !== second.integrityHash, 'hashes must differ');
    },
  },
  {
    name: 'redacts secret-shaped metadata keys before storing or hashing',
    rationale:
      'The audit log is append-only and can never be redacted afterwards, so a secret written into it is permanent.',
    async run(store, collections) {
      const record = await store.audit(
        auditInput({
          metadata: {
            password: 'hunter2',
            token: 'abc',
            otp: '123456',
            secret: 's',
            accountNumber: '1234',
            identityNumber: 'x',
            reason: 'kept',
          },
        }),
      );

      assertEqual(record.metadata, { reason: 'kept' }, 'redacted metadata');
      const serialised = JSON.stringify(await store.list('auditRecords'));
      for (const secret of ['hunter2', '123456']) {
        assert(!serialised.includes(secret), `stored trail must not contain ${secret}`);
      }
    },
  },
  {
    name: 'stores the audit record it returns',
    rationale:
      'A caller recording the returned id must be able to find that record later; returning one thing and storing another breaks every evidence link.',
    async run(store, collections) {
      const returned = await store.audit(auditInput());
      const stored = await store.list<AuditRecord>('auditRecords');
      assertEqual(stored.length, 1, 'one record stored');
      assertEqual(stored[0].id, returned.id, 'same id');
      assertEqual(stored[0].integrityHash, returned.integrityHash, 'same hash');
    },
  },
  {
    name: 'hashes over the redacted record, so the chain verifies as stored',
    rationale:
      'Hashing pre-redaction input would make every record with a secret-shaped key fail verification forever.',
    async run(store, collections) {
      await store.audit(auditInput({ metadata: { token: 'abc', reason: 'kept' } }));
      const record = (await store.list<AuditRecord>('auditRecords'))[0];

      // Recomputed through the canonical function every store writes through. This
      // previously rebuilt the hashed payload by walking the record's own keys in
      // stored order, which only worked for a store that keeps the writer's object
      // literal intact — a relational adapter rebuilds a record from columns and
      // cannot reproduce an order it never saw.
      assertEqual(
        auditIntegrityHash(record, (value) =>
          createHash('sha256').update(value).digest('hex'),
        ),
        record.integrityHash,
        'recomputed hash',
      );
    },
  },
  {
    name: 'emits an outbox event with an id and an occurrence time',
    rationale: 'A publisher needs both to deduplicate and to order what it delivers.',
    async run(store, collections) {
      const event = await store.emit({
        tenantId: 'tenant-1',
        workspaceId: 'workspace-1',
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        eventType: 'ThingHappened',
        eventVersion: 1,
        payload: {},
        correlationId: 'corr-1',
      });

      assert(event.id.length > 0, 'id');
      assert(!Number.isNaN(Date.parse(event.occurredAt)), 'occurredAt must parse');
      assertEqual((await store.list<OutboxEvent>('outboxEvents')).length, 1, 'stored');
      assertEqual(event.publishedAt, undefined, 'a new event is unpublished');
    },
  },
  {
    name: 'keeps audit records and outbox events in separate collections',
    rationale:
      'The outbox is drained and marked published; the audit trail never is. Mixing them would put a mutable workflow inside append-only history.',
    async run(store, collections) {
      await store.audit(auditInput());
      await store.emit({
        aggregateType: 'Thing',
        aggregateId: 'thing-1',
        eventType: 'ThingHappened',
        eventVersion: 1,
        payload: {},
        correlationId: 'corr-1',
      });

      assertEqual((await store.list('auditRecords')).length, 1, 'audit');
      assertEqual((await store.list('outboxEvents')).length, 1, 'outbox');
    },
  },
]);

export type ConformanceResult = {
  name: string;
  passed: boolean;
  failure?: string;
};

/**
 * Supplies the store under test, with the lifecycle a durable adapter needs.
 *
 * `create` is asynchronous because a real adapter has to connect and provision
 * before it can answer a read, and a synchronous factory would force that work
 * into a constructor that cannot await it — the same shape that made the previous
 * interface impossible to implement over a network.
 *
 * There is deliberately no `reset` hook. Resetting one shared store would make
 * per-check isolation depend on the adapter's own truncation being correct, and
 * cross-check state leakage is one of the things this suite exists to catch. A
 * Postgres adapter that finds construction too slow should reuse a pool across
 * `create` calls and give each store its own schema, rather than share state and
 * clean up after itself.
 */
export type TrustPersistenceFactory = {
  /** A store with no prior state. Called once per check. */
  create(): Promise<TrustPersistence>;
  /**
   * Collections the checks may write to. Omitted by an adapter that accepts any name;
   * required by one that maps collections onto tables and refuses the rest.
   */
  collections?: ConformanceCollections;
  /**
   * Releases what `create` acquired — a connection, a temporary schema. Called
   * after every check including a failing one, so a rejected check cannot leak a
   * connection and exhaust the pool partway through the run.
   */
  dispose?(store: TrustPersistence): Promise<void>;
};

/**
 * Runs every check against a freshly constructed store and reports each outcome.
 *
 * Takes a factory rather than an instance so no check can observe another's
 * writes — an implementation that passed only in a particular order would be
 * hiding exactly the state leakage worth catching.
 *
 * A failure is recorded, never thrown: an adapter under development fails several
 * checks at once, and stopping at the first would hide the rest. A failure inside
 * `create` or `dispose` is recorded against the check too, since an adapter that
 * cannot construct is failing the contract as surely as one that returns wrong
 * data.
 */
export async function runTrustPersistenceConformance(
  factory: TrustPersistenceFactory,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  // Sequential rather than Promise.all: each check gets its own store, and running
  // them concurrently would make a failure report depend on scheduling order.
  for (const check of TRUST_PERSISTENCE_CONFORMANCE) {
    let store: TrustPersistence | undefined;
    try {
      store = await factory.create();
      await check.run(store, factory.collections ?? DEFAULT_CONFORMANCE_COLLECTIONS);
      results.push({ name: check.name, passed: true });
    } catch (error) {
      results.push({
        name: check.name,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (store && factory.dispose) {
        try {
          await factory.dispose(store);
        } catch (error) {
          // Reported rather than swallowed: a store that cannot be released is a
          // resource leak, and silence here is how a run exhausts a pool and then
          // blames the checks.
          results.push({
            name: `${check.name} (dispose)`,
            passed: false,
            failure: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return results;
}
