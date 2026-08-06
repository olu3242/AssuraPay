import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, withTrustScope } from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch A answers to the trust runtime.
 *
 * The sixteen execution-and-evidence tables for canonical Engines 31-40 previously scoped on
 * `workspace_id UUID REFERENCES workspaces(id)` — the deprecated compatibility table — carried no
 * tenant column, keyed identity as UUID while the trust runtime is TEXT, and enforced policies
 * through the historical `has_active_workspace_membership()` helper reading another deprecated
 * table.
 *
 * `202608090001` converges all four onto one authority per concern. These tests prove the
 * convergence against a live instance rather than by reading the migration, and they prove the
 * boundary *denies* rather than merely that it exists — a policy that admits everything would
 * satisfy every structural assertion below.
 */

requireTestDatabaseUrl();

const BATCH_A = [
  'execution_workspaces', 'work_items', 'progress_records', 'evidence_requirements',
  'evidence_packages', 'validation_tests', 'quality_plans', 'quality_gate_results', 'defects',
  'inspections', 'issue_records', 'corrective_action_plans', 'change_requests',
  'change_approvals', 'acceptance_decisions', 'completion_certificates',
] as const;

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

describe('integration: Batch A converges on the trust runtime', () => {
  it('keys every identity column as TEXT, eliminating the UUID split', async () => {
    // Not only the primary keys. An actor column typed UUID cannot hold a trust principal id, so
    // leaving any UUID behind would preserve the split this migration exists to remove.
    const database = await migratedDatabase();
    const rows = await database.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${[...BATCH_A]}) AND data_type = 'uuid'
    `;
    expect(rows).toEqual([]);
  }, 300_000);

  it('references trust_workspaces and trust_tenants, and never the deprecated table', async () => {
    const database = await migratedDatabase();
    for (const table of BATCH_A) {
      const fks = await database.sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = ${`public.${table}`}::regclass AND contype = 'f'
      `;
      const definitions = fks.map((entry) => entry.definition);
      expect(definitions.filter((entry) => /REFERENCES workspaces\(/.test(entry)), table).toEqual([]);
      expect(definitions.some((entry) => /REFERENCES trust_workspaces\(/.test(entry)), table).toBe(true);
      expect(definitions.some((entry) => /REFERENCES trust_tenants\(/.test(entry)), table).toBe(true);
    }
  }, 300_000);

  it('introduces no second workspace authority', async () => {
    // A `trust_workspace_id` alongside `workspace_id` would be a second workspace authority, which
    // is the condition this capability removes rather than creates.
    //
    // `execution_workspace_id` is deliberately not a violation: it references
    // `execution_workspaces`, an Engine 31 aggregate, not a workspace. The test therefore asks the
    // precise question — which columns reference `trust_workspaces` — rather than matching on the
    // word, which would flag a legitimate aggregate foreign key.
    const database = await migratedDatabase();
    const named = await database.sql<{ column_name: string }[]>`
      SELECT DISTINCT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${[...BATCH_A]})
        AND column_name LIKE '%trust_workspace%'
    `;
    expect(named).toEqual([]);

    for (const table of BATCH_A) {
      const referencing = await database.sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = ${`public.${table}`}::regclass AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%REFERENCES trust_workspaces%'
      `;
      // The single-column key and the composite tenant/workspace key, both on `workspace_id`.
      for (const entry of referencing)
        expect(entry.definition, `${table}: ${entry.definition}`).toMatch(/\(([a-z_]+, )?workspace_id\)/);
    }
  }, 300_000);

  it('carries tenant scope, concurrency and schema versioning on every table', async () => {
    const database = await migratedDatabase();
    for (const table of BATCH_A) {
      const rows = await database.sql<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
      `;
      const byName = new Map(rows.map((row) => [row.column_name, row.is_nullable]));
      expect(byName.get('tenant_id'), `${table}.tenant_id`).toBe('NO');
      expect(byName.has('version'), `${table}.version`).toBe(true);
      expect(byName.has('schema_version'), `${table}.schema_version`).toBe(true);
    }
  }, 300_000);

  it('forces row-level security with exactly one trust-scoped policy', async () => {
    const database = await migratedDatabase();
    for (const table of BATCH_A) {
      const [flags] = await database.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}
      `;
      expect(flags.enabled, table).toBe(true);
      expect(flags.forced, table).toBe(true);

      const policies = await database.sql<{ qual: string; with_check: string }[]>`
        SELECT qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `;
      expect(policies, table).toHaveLength(1);
      // Both clauses. A USING-only policy hides other tenants' rows while letting a caller insert
      // into their own scope, which plants data the owning tenant cannot see the origin of.
      for (const clause of [policies[0].qual, policies[0].with_check]) {
        expect(clause, table).toContain('trust_current_tenant()');
        expect(clause, table).toContain('trust_current_workspace()');
      }
      // The historical helpers are gone from these tables' boundary.
      expect(policies[0].qual, table).not.toContain('has_active_workspace_membership');
      expect(policies[0].qual, table).not.toContain('current_workspace_id');
    }
  }, 300_000);

  it('preserves the append-only triggers rather than recreating them', async () => {
    // They already protect progress, evidence, validation, quality and acceptance state from
    // mutation. Dropping and recreating them would risk losing that behaviour silently.
    const database = await migratedDatabase();
    const rows = await database.sql<{ table_name: string }[]>`
      SELECT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = ANY(${[...BATCH_A]})
        AND t.tgname LIKE '%append_only'
    `;
    expect(rows.length).toBeGreaterThan(0);
  }, 300_000);
});

describe('integration: the Batch A boundary denies', () => {
  /** Founds two tenants and a workspace each, as the owner with FORCE temporarily lifted. */
  async function seeded(database: TestDatabase): Promise<void> {
    await database.sql.unsafe(
      'ALTER TABLE trust_tenants NO FORCE ROW LEVEL SECURITY; ' +
        'ALTER TABLE trust_workspaces NO FORCE ROW LEVEL SECURITY; ' +
        'ALTER TABLE execution_workspaces NO FORCE ROW LEVEL SECURITY',
    );
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant})`;
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${`workspace-${tenant}`}, ${tenant}, 'ACTIVE', '{}', 'digest')
      `;
      await database.sql`
        INSERT INTO execution_workspaces
          (id, tenant_id, workspace_id, blueprint_id, milestone_id, status)
        VALUES (${`exec-${tenant}`}, ${tenant}, ${`workspace-${tenant}`},
                ${`bp-${tenant}`}, ${`ms-${tenant}`}, 'ACTIVE')
      `;
    }
    await database.sql.unsafe(
      'ALTER TABLE trust_tenants FORCE ROW LEVEL SECURITY; ' +
        'ALTER TABLE trust_workspaces FORCE ROW LEVEL SECURITY; ' +
        'ALTER TABLE execution_workspaces FORCE ROW LEVEL SECURITY',
    );
  }

  it('shows a scoped caller only its own tenant, and nothing unscoped', async () => {
    const database = await migratedDatabase();
    await seeded(database);

    const forA = await database.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', 'tenant-a', true)`;
      await tx`SELECT set_config('app.workspace_id', 'workspace-tenant-a', true)`;
      return tx<{ id: string }[]>`SELECT id FROM execution_workspaces`;
    });
    expect(forA.map((row) => row.id)).toEqual(['exec-tenant-a']);

    // Unscoped reads nothing rather than everything. Before FORCE the same read returned both.
    const unscoped = await database.sql<{ id: string }[]>`SELECT id FROM execution_workspaces`;
    expect(unscoped).toEqual([]);
  }, 300_000);

  it('refuses a write naming another tenant, through WITH CHECK', async () => {
    const database = await migratedDatabase();
    await seeded(database);

    await expect(
      database.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', 'tenant-a', true)`;
        await tx`SELECT set_config('app.workspace_id', 'workspace-tenant-a', true)`;
        await tx`
          INSERT INTO execution_workspaces
            (id, tenant_id, workspace_id, blueprint_id, milestone_id, status)
          VALUES ('smuggled', 'tenant-b', 'workspace-tenant-b', 'bp-x', 'ms-x', 'ACTIVE')
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  }, 300_000);

  it('refuses a row whose tenant and workspace disagree', async () => {
    // The composite foreign key. Without it a caller scoped to tenant A could write a row naming
    // tenant A and a workspace owned by tenant B, and the policy would admit it.
    const database = await migratedDatabase();
    await seeded(database);

    await expect(
      database.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', 'tenant-a', true)`;
        await tx`SELECT set_config('app.workspace_id', 'workspace-tenant-a', true)`;
        await tx`
          INSERT INTO execution_workspaces
            (id, tenant_id, workspace_id, blueprint_id, milestone_id, status)
          VALUES ('mismatched', 'tenant-a', 'workspace-tenant-b', 'bp-y', 'ms-y', 'ACTIVE')
        `;
      }),
    ).rejects.toThrow();
  }, 300_000);

  it('refuses the migration when a Batch A table holds rows', async () => {
    // The whole safety argument for converting identity types in place. A populated table makes
    // the conversion a data migration, and this one refuses rather than performing it.
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const { readMigrations } = await import('@assurapay/database');
    const earlier = readMigrations(migrationsDirectory()).filter(
      (entry) => !entry.id.startsWith('202608090001'),
    );
    await database.sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS trust_migration_ledger (
          migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT NOT NULL,
          execution_ms INTEGER NOT NULL, ordinal INTEGER NOT NULL)`;
      for (const migration of earlier) {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
          VALUES (${migration.id}, ${migration.checksum}, 'test', 0, ${migration.ordinal})
          ON CONFLICT (migration_id) DO NOTHING`;
      }
    });
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'legacy', 'organization')
    `;
    const [workspace] = await database.sql<{ id: string }[]>`SELECT id FROM workspaces LIMIT 1`;
    await database.sql`
      INSERT INTO execution_workspaces (workspace_id, blueprint_id, milestone_id, status)
      VALUES (${workspace.id}::uuid, gen_random_uuid(), gen_random_uuid(), 'ACTIVE')
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('WAVE4_TRUST_AUTHORITY_REFUSED');
    expect(message).toContain('execution_workspaces=1');
    expect(message).toContain('Nothing has been changed');
  }, 300_000);
});
