import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyMigrations, createPostgresPool, readMigrations } from '@assurapay/database';
import type { PostgresPool, SqlClient } from '@assurapay/database';

export const TEST_DATABASE_URL_VARIABLE = 'ASSURAPAY_TEST_DATABASE_URL';

export function migrationsDirectory(): string {
  return path.resolve(process.cwd(), 'supabase/migrations');
}

export type TestDatabase = {
  readonly sql: SqlClient;
  readonly schema: string;
  readonly url: string;
  readonly probeRole?: string;
  provisionProbeRole?(): Promise<string>;
  dispose(): Promise<void>;
};

export function testDatabaseUrl(): string | undefined {
  const url = process.env[TEST_DATABASE_URL_VARIABLE];
  return url?.trim() ? url : undefined;
}

export function hasTestDatabase(): boolean {
  return testDatabaseUrl() !== undefined;
}

export function requireTestDatabaseUrl(): string {
  const url = testDatabaseUrl();
  if (!url)
    throw new Error(
      `${TEST_DATABASE_URL_VARIABLE} is not set. The PostgreSQL certification suites ` +
        'require a real database; they do not fall back to an in-memory store, because ' +
        'a green run against memory is not evidence of durability.',
    );
  return url;
}

export async function createTestDatabase(
  options: { applyAllMigrations?: boolean; applyRls?: boolean } = {},
): Promise<TestDatabase> {
  const databaseUrl = requireTestDatabaseUrl();
  const schema = `trust_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const bootstrap = createPostgresPool({ databaseUrl, max: 1, applicationName: 'assurapay-test-setup' });
  try {
    await bootstrap.sql.unsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await bootstrap.dispose();
  }

  const pool: PostgresPool = createPostgresPool({
    databaseUrl: withSearchPath(databaseUrl, schema),
    max: 8,
    applicationName: 'assurapay-test',
  });

  let disposed = false;
  let probeRole: string | undefined;
  const database: TestDatabase = {
    sql: pool.sql,
    schema,
    url: withSearchPath(databaseUrl, schema),
    get probeRole() {
      return probeRole;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await pool.dispose();
      const teardown = createPostgresPool({ databaseUrl, max: 1, applicationName: 'assurapay-test-teardown' });
      try {
        await teardown.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        if (probeRole) await dropProbeRole(teardown.sql, probeRole);
      } finally {
        await teardown.dispose();
      }
    },
  };

  try {
    if (options.applyAllMigrations) {
      await applyMigrations(pool.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
    } else {
      await applyTrustStoreMigration(pool.sql);
      if (options.applyRls !== false) {
        await assertConnectionCannotBypassRls(pool.sql);
        await applyRlsMigration(pool.sql);
        probeRole = await createProbeRole(pool.sql, schema);
      }
    }
  } catch (error) {
    await database.dispose().catch(() => undefined);
    throw error;
  }
  return database;
}

async function relationExists(sql: SqlClient, relation: string): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${relation}) IS NOT NULL AS present
  `;
  return row?.present ?? false;
}

async function grantPersonaProbePrivileges(sql: SqlClient, role: string): Promise<void> {
  if (!(await relationExists(sql, 'persona_agent_profiles'))) return;
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE ON persona_agent_profiles TO "${role}"`);
}

async function provisionInstanceProbeRole(sql: SqlClient): Promise<string> {
  const role = `probe_db_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
  await sql.unsafe(`GRANT "${role}" TO CURRENT_USER`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE ON
       trust_tenants, trust_workspaces, trust_memberships, trust_permission_grants,
       trust_bootstrap_state, trust_outbox_events, trust_idempotency_keys, trust_records
     TO "${role}"`,
  );
  await grantPersonaProbePrivileges(sql, role);
  await sql.unsafe(`GRANT SELECT, INSERT ON trust_audit_records TO "${role}"`);
  return role;
}

async function createProbeRole(sql: SqlClient, schema: string): Promise<string> {
  const role = `probe_${schema.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`;
  await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
  await sql.unsafe(`GRANT "${role}" TO CURRENT_USER`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE ON
       trust_tenants, trust_workspaces, trust_memberships, trust_permission_grants,
       trust_bootstrap_state, trust_outbox_events, trust_idempotency_keys, trust_records
     TO "${role}"`,
  );
  await grantPersonaProbePrivileges(sql, role);
  await sql.unsafe(`GRANT SELECT, INSERT ON trust_audit_records TO "${role}"`);
  return role;
}

async function dropProbeRole(sql: SqlClient, role: string): Promise<void> {
  await sql.unsafe(`DROP OWNED BY "${role}"`);
  await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
}

export async function findBypassingRole(sql: SqlClient): Promise<string> {
  const [role] = await sql<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles
    WHERE rolsuper OR rolbypassrls
    ORDER BY rolsuper DESC, rolname
    LIMIT 1
  `;
  if (!role)
    throw new Error(
      'this cluster has no superuser and no BYPASSRLS role, so there is nothing to assert ' +
        'bypass detection against.',
    );
  return role.rolname;
}

async function assertConnectionCannotBypassRls(sql: SqlClient): Promise<void> {
  const [role] = await sql<{ who: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user AS who, r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (role?.rolsuper || role?.rolbypassrls)
    throw new Error(
      `${role.who} can bypass row-level security (${role.rolsuper ? 'superuser' : 'BYPASSRLS'}), ` +
        'so a tenancy suite run as it would prove nothing.',
    );
}

export async function applyRlsMigration(sql: SqlClient): Promise<void> {
  const migrations = readMigrations(migrationsDirectory()).filter(
    (entry) =>
      entry.id.endsWith('trust_row_level_security') ||
      entry.id.endsWith('trust_audit_chain_per_tenant') ||
      entry.id.endsWith('trust_schema_ownership_reconciliation') ||
      entry.id.endsWith('identity_plane_is_reachable_without_a_tenant') ||
      entry.id.endsWith('membership_discovery_precedes_tenant_scope'),
  );
  if (migrations.length !== 5)
    throw new Error('a row-level-security, reconciliation, identity-plane or membership migration is missing');
  await sql.begin(async (tx) => {
    for (const migration of migrations) {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
        VALUES (${migration.id}, ${migration.checksum}, 'integration-test', 0, ${migration.ordinal})
        ON CONFLICT (migration_id) DO NOTHING
      `;
    }
  });
}

export async function applyTrustStoreMigration(sql: SqlClient): Promise<void> {
  const wanted = ['trust_repository_store', 'trust_memberships_carry_their_tenant'];
  const migrations = readMigrations(migrationsDirectory()).filter((entry) =>
    wanted.some((suffix) => entry.id.endsWith(suffix)),
  );
  if (migrations.length !== wanted.length)
    throw new Error('the trust repository or membership-tenant migration is missing');
  await sql.begin(async (tx) => {
    for (const migration of migrations) {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
        VALUES (${migration.id}, ${migration.checksum}, 'integration-test', 0, ${migration.ordinal})
        ON CONFLICT (migration_id) DO NOTHING
      `;
    }
  });
}

async function dropDatabase(sql: SqlClient, name: string): Promise<void> {
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    return;
  } catch (plain) {
    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch {
      throw plain;
    }
  }
}

export async function createTestDatabaseInstance(): Promise<TestDatabase> {
  const databaseUrl = requireTestDatabaseUrl();
  const name = `trust_db_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const admin = createPostgresPool({ databaseUrl, max: 1, applicationName: 'assurapay-test-setup' });
  try {
    await admin.sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.dispose();
  }

  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const pool = createPostgresPool({ databaseUrl: url.toString(), max: 4, applicationName: 'assurapay-test' });

  let disposed = false;
  let probeRole: string | undefined;
  return {
    sql: pool.sql,
    schema: 'public',
    url: url.toString(),
    get probeRole() {
      return probeRole;
    },
    async provisionProbeRole() {
      probeRole ??= await provisionInstanceProbeRole(pool.sql);
      return probeRole;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await pool.dispose();
      const teardown = createPostgresPool({ databaseUrl, max: 1, applicationName: 'assurapay-test-teardown' });
      try {
        await dropDatabase(teardown.sql, name);
        if (probeRole) await dropProbeRole(teardown.sql, probeRole);
      } finally {
        await teardown.dispose();
      }
    },
  };
}

function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
