import { createHash } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';

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
  run: (store: TrustPersistence) => void;
};

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
    async run(store) {
      assertEqual(await store.list('nothing-here'), [], 'unknown collection');
    },
  },
  {
    name: 'reads back what was appended, in append order',
    rationale:
      'Order is meaning here: the audit chain, the ledger and every history read assume the store preserves it.',
    async run(store) {
      for (const id of ['a', 'b', 'c']) await store.append('things', { id });
      assertEqual(
        (await store.list<{ id: string }>('things')).map((thing) => thing.id),
        ['a', 'b', 'c'],
        'append order',
      );
    },
  },
  {
    name: 'keeps collections independent',
    rationale: 'A shared namespace would let one aggregate’s writes appear in another’s history.',
    async run(store) {
      await store.append('alpha', { id: 'a' });
      await store.append('beta', { id: 'b' });
      assertEqual((await store.list<{ id: string }>('alpha')).map((x) => x.id), ['a'], 'alpha');
      assertEqual((await store.list<{ id: string }>('beta')).map((x) => x.id), ['b'], 'beta');
    },
  },
  {
    name: 'hands out a copy, so a reader cannot mutate stored state',
    rationale:
      'Returning live references would let any caller edit history in place — the precise thing CLAUDE.md constraint 3 forbids — with no write call to audit.',
    async run(store) {
      await store.append('things', { id: 'a', value: 1 });
      const first = await store.list<{ id: string; value: number }>('things');
      first[0].value = 999;
      first.push({ id: 'injected', value: 0 });

      const second = await store.list<{ id: string; value: number }>('things');
      assertEqual(second.length, 1, 'reader push must not reach the store');
      assertEqual(second[0].value, 1, 'reader mutation must not reach the store');
    },
  },
  {
    name: 'copies on write, so mutating the argument afterwards changes nothing',
    rationale:
      'A caller reusing a builder object would otherwise retroactively alter records it already wrote.',
    async run(store) {
      const record = { id: 'a', value: 1 };
      await store.append('things', record);
      record.value = 999;
      assertEqual((await store.list<{ value: number }>('things'))[0].value, 1, 'stored value');
    },
  },
  {
    name: 'replaces a record in place, preserving its position',
    rationale: 'Reordering on update would corrupt every order-dependent read.',
    async run(store) {
      for (const id of ['a', 'b', 'c']) await store.append('things', { id, value: 0 });
      await store.replace('things', { id: 'b', value: 7 });

      const things = await store.list<{ id: string; value: number }>('things');
      assertEqual(things.map((thing) => thing.id), ['a', 'b', 'c'], 'order after replace');
      assertEqual(things[1].value, 7, 'replaced value');
    },
  },
  {
    name: 'refuses to replace a record that does not exist',
    rationale:
      'Silently inserting would turn a failed update into a duplicate, and the caller would never learn the record it meant to change was gone.',
    async run(store) {
      let threw = false;
      try {
        await store.replace('things', { id: 'missing' });
      } catch {
        threw = true;
      }
      assert(threw, 'replace of an absent id must throw');
      assertEqual(await store.list('things'), [], 'nothing inserted');
    },
  },
  {
    name: 'stamps every audit record with an id, a timestamp and an integrity hash',
    rationale: 'A record missing any of these cannot be located, ordered or verified.',
    async run(store) {
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
    async run(store) {
      assertEqual((await store.audit(auditInput())).previousHash, undefined, 'genesis previousHash');
    },
  },
  {
    name: 'chains each audit record to the one before it',
    rationale:
      'The link is what makes deletion and reordering detectable. Without it the records are a list, not a ledger.',
    async run(store) {
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
    async run(store) {
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
    async run(store) {
      const first = await store.audit(auditInput({ metadata: { value: 1 } }));
      const second = await store.audit(auditInput({ metadata: { value: 2 } }));
      assert(first.integrityHash !== second.integrityHash, 'hashes must differ');
    },
  },
  {
    name: 'redacts secret-shaped metadata keys before storing or hashing',
    rationale:
      'The audit log is append-only and can never be redacted afterwards, so a secret written into it is permanent.',
    async run(store) {
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
    async run(store) {
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
    async run(store) {
      await store.audit(auditInput({ metadata: { token: 'abc', reason: 'kept' } }));
      const record = (await store.list<AuditRecord>('auditRecords'))[0];

      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === 'id' || key === 'integrityHash' || key === 'previousHash') continue;
        payload[key] = value;
      }
      payload.previousHash = record.previousHash;

      assertEqual(
        createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        record.integrityHash,
        'recomputed hash',
      );
    },
  },
  {
    name: 'emits an outbox event with an id and an occurrence time',
    rationale: 'A publisher needs both to deduplicate and to order what it delivers.',
    async run(store) {
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
    async run(store) {
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
 * Runs every check against a freshly constructed store.
 *
 * Takes a factory rather than an instance so no check can observe another's
 * writes — an implementation that passed only in a particular order would be
 * hiding exactly the state leakage worth catching.
 */
export function runTrustPersistenceConformance(
  factory: () => TrustPersistence,
): ConformanceResult[] {
  return TRUST_PERSISTENCE_CONFORMANCE.map((check) => {
    try {
      check.run(factory());
      return { name: check.name, passed: true };
    } catch (error) {
      return {
        name: check.name,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
