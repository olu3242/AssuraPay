import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAssuraStore } from './index';

/**
 * The domain persistence contract, held to the same shape as the trust one.
 *
 * `AssuraRepository` carried the defect `TrustPersistence` was fixed for one capability
 * earlier: `getSnapshot(): Snapshot` and `setSnapshot(...): void`, synchronous, across 115
 * production and test call sites. A relational adapter cannot implement either — JavaScript
 * cannot block on I/O — so the only way to satisfy the old signature was to hold the whole
 * database in memory and return the cache. That is arrays behind a PostgreSQL adapter, not
 * durability, and it is what made `persistence.domain-store-durability` unimplementable rather
 * than merely unstarted.
 *
 * These tests pin the contract shape rather than any implementation, because it is the
 * interface that decides whether a Postgres adapter is possible. A class may be `async` while
 * the interface it satisfies is not, and then a caller typed against the interface still cannot
 * await.
 */

const SOURCE = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');

function declaredMembers(): { name: string; returnType: string }[] {
  const declaration = SOURCE.match(/export interface AssuraRepository\s*\{([\s\S]*?)\n\}/);
  if (!declaration) throw new Error('AssuraRepository is not declared as an interface');
  return declaration[1]
    .split('\n')
    .map((line) => line.match(/^\s{2}(\w+)(<[^>]*>)?\(.*\)\s*:\s*(.+);\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ name: match[1], returnType: match[3].trim() }));
}

describe('AssuraRepository is asynchronous in every method', () => {
  it('declares every member returning a Promise', () => {
    const synchronous = declaredMembers().filter(
      (member) => !/\bPromise</.test(member.returnType),
    );
    expect(synchronous).toEqual([]);
  });

  it('covers the two methods that carried all the state', () => {
    // Named explicitly. The other 36 members were already `Promise<void>`; these two were the
    // reason no network-backed store could implement the contract at all.
    const byName = new Map(declaredMembers().map((member) => [member.name, member.returnType]));
    expect(byName.get('getSnapshot')).toBe('Promise<Snapshot>');
    expect(byName.get('setSnapshot')).toBe('Promise<void>');
  });

  it('declares no parallel synchronous variant', () => {
    // Two interfaces would let call sites keep the synchronous one, which is how a migration
    // stalls half-done. A `MaybePromise` union would let a caller forget to await and compile.
    expect(SOURCE).not.toMatch(/interface\s+SyncAssuraRepository/);
    // A union type, not the word — this module's own commentary explains why one is not used.
    expect(SOURCE).not.toMatch(/type\s+MaybePromise\s*[<=]/);
  });
});

describe('the store does not hand out its own state', () => {
  it('returns a snapshot a caller cannot mutate into persistence', async () => {
    // It previously returned `this.snapshot` directly, so a caller could push onto a collection
    // and have it persist on the next unrelated save — a write with no write method, no
    // validation and nothing in the audit trail to attribute it to.
    const store = new FileAssuraStore();

    const first = await store.getSnapshot();
    first.contracts.push({ id: 'smuggled' });

    const second = await store.getSnapshot();
    expect(second.contracts).toEqual([]);
  });

  it('gives two readers separate objects', async () => {
    const store = new FileAssuraStore();
    const a = await store.getSnapshot();
    const b = await store.getSnapshot();

    expect(a).not.toBe(b);
    expect(a.contracts).not.toBe(b.contracts);
  });

  it('does not retain a reference to what a writer passed in', async () => {
    // The mirror of the read case. A caller that kept its argument could otherwise keep editing
    // the store's state after handing it over.
    const store = new FileAssuraStore();
    const incoming = { contracts: [{ id: 'c-1' }] };

    await store.setSnapshot(incoming);
    incoming.contracts.push({ id: 'c-2' });

    const stored = await store.getSnapshot();
    expect(stored.contracts.map((entry: { id: string }) => entry.id)).toEqual(['c-1']);
  });

  it('records what it was given rather than only accepting it', async () => {
    const store = new FileAssuraStore();
    await store.setSnapshot({ contracts: [{ id: 'c-1' }] });
    expect((await store.getSnapshot()).contracts).toHaveLength(1);
  });
});
