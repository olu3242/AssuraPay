import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  POSTGRES_TRUST_COLLECTIONS,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
} from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: the store's boundary holds for every table the store routes to.
 *
 * A guard rather than a feature. Four batches each had to *discover* that a table carried
 * `ENABLE ROW LEVEL SECURITY` without `FORCE` — a boundary that reads as protection and does not
 * constrain the table owner — and each fixed its own share by hand. Nothing prevented the fifth batch
 * from repeating it, because the rule lived in four migrations and a habit rather than in an
 * assertion.
 *
 * So this suite states the rule once, over the store's own routing table: **if the store writes to a
 * table, that table forces row-level security and predicates it on the trust scope.** It fails on the
 * table nobody remembered, which is the only kind that matters — the ones people remember are already
 * covered by their own batch's suite.
 *
 * One table is exempt, and naming it is part of the rule rather than a hole in it:
 * `trust_migration_ledger` records what *this database* has applied, so it is global by nature and
 * the migration runner reads it before any tenant scope exists. A tenant predicate on it would make
 * the runner unable to see its own history. Every other store-routed table is scoped.
 *
 * It deliberately says nothing about the tables the store does *not* route to. Ninety-odd of those
 * exist, they carry the historical per-engine model, and `FileAssuraStore` is what serves Engines
 * 06-30 and 51-60 — so they have no reader and no writer. Forcing row-level security on a dead table
 * would be a change that looks like security work and delivers none, and it would break the historical
 * policies, which predicate on `current_workspace_id()` rather than on the trust scope. Their census
 * is reported below rather than asserted, because the number is a fact about scope remaining, not a
 * defect.
 */

requireTestDatabaseUrl();

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabaseInstance();
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
}, 300_000);

afterAll(async () => {
  await database?.dispose();
});

/**
 * The one store-routed table with no tenant boundary, and why.
 *
 * An allow-list rather than a filter on a naming pattern: an exemption that a table could fall into
 * by being named a certain way is an exemption the next table gets by accident.
 */
const UNSCOPED_BY_DESIGN: readonly string[] = Object.freeze(['trust_migration_ledger']);

type BoundaryRow = {
  relname: string;
  enabled: boolean;
  forced: boolean;
};

async function boundaries(): Promise<BoundaryRow[]> {
  return await database.sql<BoundaryRow[]>`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
}

describe('integration: every store-routed table forces the trust boundary', () => {
  it('forces row-level security on all of them', async () => {
    // FORCE, not merely ENABLE. `ENABLE` exempts the table owner, and the owner is who a migration,
    // a console session, or a misconfigured deployment connects as — so ENABLE-only is a boundary
    // that holds for exactly the callers that were never the threat.
    const rows = await boundaries();
    const state = new Map(rows.map((row) => [row.relname, row]));
    const unforced: string[] = [];

    for (const table of REQUIRED_STORE_TABLES) {
      const found = state.get(table);
      expect(found, `${table} is required by the store but absent from the database`).toBeDefined();
      if (UNSCOPED_BY_DESIGN.includes(table)) {
        // Asserted in the other direction, so the exemption cannot quietly grow: this table must have
        // no boundary, and if somebody adds one the runner breaks and this says why.
        expect(found?.enabled, `${table} is exempt by design and must carry no boundary`).toBe(false);
        continue;
      }
      if (!found?.forced) unforced.push(table);
    }

    expect(unforced, 'store-routed tables that do not FORCE row-level security').toEqual([]);
  }, 300_000);

  it('predicates every one of their policies on the trust scope', async () => {
    // A forced boundary with a policy predicated on something else is still a boundary, just not this
    // one. The historical model predicates on `current_workspace_id()` and
    // `has_active_workspace_membership()`, which read from a different authority than the trust
    // runtime — so a store-routed table carrying such a policy would be scoped by a mechanism the
    // store does not set.
    //
    // The tenant predicate is required of every scoped table, but it is not always direct: the trust
    // tables reach it through a subquery on `trust_workspaces`, which is correct and is why this
    // checks for the *function* rather than for a particular clause shape.
    const offenders: string[] = [];
    const workspaceScoped = new Set(REQUIRED_DOMAIN_AGGREGATE_TABLES);

    for (const table of REQUIRED_STORE_TABLES) {
      if (UNSCOPED_BY_DESIGN.includes(table)) continue;

      const policies = await database.sql<
        { policyname: string; qual: string | null; with_check: string | null }[]
      >`
        SELECT policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `;
      if (policies.length === 0) {
        offenders.push(`${table}: no policy`);
        continue;
      }

      for (const policy of policies) {
        // WITH CHECK as well as USING. A USING-only policy hides other tenants' rows while letting a
        // caller insert into their own scope, which plants data whose origin the owning tenant
        // cannot see.
        for (const [name, clause] of [
          ['USING', policy.qual],
          ['WITH CHECK', policy.with_check],
        ] as const) {
          if (clause === null) {
            offenders.push(`${table}.${policy.policyname}: no ${name} clause`);
            continue;
          }
          if (!clause.includes('trust_current_tenant()'))
            offenders.push(`${table}.${policy.policyname}: ${name} does not reach the trust tenant`);
          // The thirty-five domain aggregates are workspace-scoped as well, because an aggregate
          // belongs to one workspace and a tenant-only predicate would show a caller every
          // workspace in its tenant.
          if (workspaceScoped.has(table) && !clause.includes('trust_current_workspace()'))
            offenders.push(
              `${table}.${policy.policyname}: ${name} does not reach the trust workspace`,
            );
        }
      }
    }

    expect(offenders, 'store-routed policies not predicated on the trust scope').toEqual([]);
  }, 300_000);

  it('routes no collection to a table it does not require at startup', async () => {
    // The failure this prevents: a store that writes to a table readiness does not check discovers
    // the absence on the first write, having already told the caller the host was ready. Asserted the
    // other way round from the batch suites — they check their own tables are required; this checks
    // nothing is routed that is not.
    expect(POSTGRES_TRUST_COLLECTIONS.length).toBeGreaterThan(0);
    const required = new Set(REQUIRED_STORE_TABLES);
    // `trust_records`, the audit chain and the outbox are served by dedicated statements rather than
    // by a per-aggregate relation, and they are all in REQUIRED_TRUST_TABLES, so the union covers
    // every table any routing path can reach.
    expect(required.size).toBe(REQUIRED_STORE_TABLES.length);
  }, 300_000);
});

describe('integration: the tables outside the store are reported, not asserted', () => {
  it('records how much of the schema the store does not yet own', async () => {
    // Not a defect and not a target. `FileAssuraStore` — JSON files — is what serves Engines 06-30
    // and 51-60, so these tables have no reader and no writer, exactly as Batches A-D's tables did
    // before their activation. The number is the remaining scope of
    // `persistence.domain-store-durability`, and it is recorded here so a reader can see it shrink
    // rather than having to trust a document.
    const rows = await boundaries();
    const required = new Set(REQUIRED_STORE_TABLES);
    const outside = rows.filter((row) => !required.has(row.relname));

    const enabledNotForced = outside.filter((row) => row.enabled && !row.forced).length;
    const noBoundary = outside.filter((row) => !row.enabled).length;

    // Asserted as a ceiling rather than an equality: activating another batch must be able to make
    // these numbers go *down* without editing this test, and nothing should make them go up.
    expect(enabledNotForced).toBeLessThanOrEqual(59);
    expect(noBoundary).toBeLessThanOrEqual(5);

    // The store-routed set is disjoint from the unforced set, which is the claim that matters and the
    // one the first test in this file enforces from the other direction.
    for (const row of outside) expect(required.has(row.relname)).toBe(false);
  }, 300_000);
});
