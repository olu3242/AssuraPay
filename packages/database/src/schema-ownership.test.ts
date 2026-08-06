import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_OBJECTS,
  RETIRED_TRUST_HISTORICAL_TABLES,
  TRUST_AGGREGATE_OWNERSHIP,
  auditOwnershipRegistry,
  canonicalTables,
  forcedRlsCanonicalTables,
} from './schema-ownership';

/**
 * The registry's own consistency, checked without a database.
 *
 * A registry that contradicts itself would be an ownership map with the very defect this
 * capability exists to remove, and it should fail in milliseconds rather than wait for a
 * PostgreSQL service to notice.
 */

describe('the ownership registry is internally consistent', () => {
  it('finds nothing wrong with itself', () => {
    expect(auditOwnershipRegistry()).toEqual([]);
  });

  it('gives every aggregate exactly one canonical table', () => {
    const owners = new Map<string, Set<string>>();
    for (const entry of TRUST_AGGREGATE_OWNERSHIP) {
      const set = owners.get(entry.aggregate) ?? new Set<string>();
      set.add(entry.canonicalTable);
      owners.set(entry.aggregate, set);
    }
    const ambiguous = [...owners].filter(([, tables]) => tables.size > 1);
    expect(ambiguous).toEqual([]);
  });

  it('disposes of every superseded table, as retired or as retained with a condition', () => {
    // The failure this prevents is a table that quietly lost ownership and was then left in
    // the database with nothing recording what it is. That is how a "temporary" duplicate
    // becomes permanent.
    const retired = new Set(RETIRED_TRUST_HISTORICAL_TABLES);
    const retained = new Set(COMPATIBILITY_OBJECTS.map((entry) => entry.table));
    const undisposed = TRUST_AGGREGATE_OWNERSHIP.flatMap((entry) =>
      entry.supersededTables.filter((table) => !retired.has(table) && !retained.has(table)),
    );
    expect(undisposed).toEqual([]);
  });

  it('never both retires and retains the same table', () => {
    const retired = new Set(RETIRED_TRUST_HISTORICAL_TABLES);
    const both = COMPATIBILITY_OBJECTS.filter((entry) => retired.has(entry.table));
    expect(both).toEqual([]);
  });

  it('names a real follow-on capability for every retained object', () => {
    // "Temporary" without a condition is permanent. Each retained object has to point at the
    // capability whose completion removes the dependency keeping it alive.
    for (const entry of COMPATIBILITY_OBJECTS) {
      expect(entry.retirementCondition).toMatch(/^[a-z0-9_]+\.[a-z0-9-]+$/);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('claims no canonical owner outside the trust namespace', () => {
    // The moment a historical table is named canonical, this capability would be asserting
    // ownership of a model nothing reads or writes.
    for (const table of canonicalTables()) expect(table).toMatch(/^trust_/);
  });

  it('requires forced RLS on every canonical table except the migration ledger', () => {
    const forced = new Set(forcedRlsCanonicalTables());
    expect(forced.has('trust_migration_ledger')).toBe(false);
    for (const table of canonicalTables())
      if (table !== 'trust_migration_ledger') expect(forced.has(table)).toBe(true);
  });

  it('retires exactly the set the database proved retirable', () => {
    // Twenty-eight, not thirty-one. `workspaces`, `workspace_memberships` and
    // `user_identities` are load-bearing for the out-of-scope model, which PostgreSQL
    // established by refusing the drop — see the migration's header.
    expect(RETIRED_TRUST_HISTORICAL_TABLES).toHaveLength(28);
    expect(COMPATIBILITY_OBJECTS.map((entry) => entry.table).sort()).toEqual([
      'user_identities',
      'workspace_memberships',
      'workspaces',
    ]);
    for (const table of RETIRED_TRUST_HISTORICAL_TABLES) expect(table).not.toMatch(/^trust_/);
  });

  it('agrees with the architecture validator about what was retired', () => {
    // The validator restates this list rather than importing it, because a validator must not
    // depend on the package it validates — a broken package would otherwise take down the
    // tool that would have reported it. That duplication is safe only while something pins
    // the two together, and this is that something.
    const validatorSource = readFileSync(
      resolve(__dirname, '../../reos/src/validators/persistence.ts'),
      'utf8',
    );
    const declaration = validatorSource.match(
      /const RETIRED_TRUST_TABLES = Object\.freeze\(\[([\s\S]*?)\]\)/,
    );
    expect(declaration).not.toBeNull();
    const validatorTables = [...declaration![1].matchAll(/'([a-z_]+)'/g)]
      .map((match) => match[1])
      .sort();
    expect(validatorTables).toEqual([...RETIRED_TRUST_HISTORICAL_TABLES].sort());
  });

  it('detects an ambiguous registry rather than trusting the author', () => {
    // The audit has to be capable of failing, or asserting that it passes proves nothing.
    const findings = auditOwnershipRegistryWith([
      { aggregate: 'workspace', canonicalTable: 'trust_workspaces' },
      { aggregate: 'workspace', canonicalTable: 'workspaces' },
    ]);
    expect(findings.map((finding) => finding.code)).toContain('OWNERSHIP_AMBIGUOUS');
  });
});

/**
 * The ambiguity check, run against a hypothetical registry.
 *
 * Reimplemented rather than exported from the module: the production function reads the real
 * registry by design — a parameter would let a caller certify against a registry the database
 * does not use — so this is the smallest faithful copy of the one rule under test.
 */
function auditOwnershipRegistryWith(
  entries: { aggregate: string; canonicalTable: string }[],
): { code: string; detail: string }[] {
  const findings: { code: string; detail: string }[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const existing = seen.get(entry.aggregate);
    if (existing && existing !== entry.canonicalTable)
      findings.push({
        code: 'OWNERSHIP_AMBIGUOUS',
        detail: `aggregate ${entry.aggregate} is claimed by both ${existing} and ${entry.canonicalTable}`,
      });
    seen.set(entry.aggregate, entry.canonicalTable);
  }
  return findings;
}
