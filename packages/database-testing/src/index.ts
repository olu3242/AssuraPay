import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyMigrations, createPostgresPool, readMigrations } from '@assurapay/database';
import type { PostgresPool, SqlClient } from '@assurapay/database';

/**
 * Isolated PostgreSQL databases for integration tests.
 *
 * A package of its own rather than a module inside `@assurapay/database`, so production
 * code cannot reach it through the barrel it would otherwise share with the store. These
 * helpers create and drop databases and skip every check production configuration
 * performs; `persistence/test-helper-in-production` fails certification on any non-test
 * file that imports this package.
 *
 * Each caller gets its own schema inside the configured database, created and dropped
 * per test. A shared schema would make the concurrency and isolation suites depend on
 * each other's rows, and those are precisely the suites whose value comes from being
 * the only writer.
 *
 * The address comes from `ASSURAPAY_TEST_DATABASE_URL`. When it is unset the helper
 * reports that rather than substituting anything: a suite that silently ran against an
 * in-memory stand-in would report durability it never observed.
 */

export const TEST_DATABASE_URL_VARIABLE = 'ASSURAPAY_TEST_DATABASE_URL';

/** Where this capability's migration set lives. */
export function migrationsDirectory(): string {
  return path.resolve(process.cwd(), 'supabase/migrations');
}

export type TestDatabase = {
  readonly sql: SqlClient;
  readonly schema: string;
  /**
   * A non-owning role the tenancy probes may assume, present when the policies were applied.
   *
   * Run-scoped rather than the shared `assurapay_app`. A cluster-wide role belongs to whichever
   * credential created it, and a later credential holds no ADMIN OPTION on it — so `SET ROLE`
   * is refused with a bare "permission denied to grant role" that says nothing about why. A role
   * this connection just created is one it can always assume.
   */
  readonly probeRole?: string;
  /** Drops the schema and closes the pool. Safe to call twice. */
  dispose(): Promise<void>;
};

export function testDatabaseUrl(): string | undefined {
  const url = process.env[TEST_DATABASE_URL_VARIABLE];
  return url?.trim() ? url : undefined;
}

/**
 * Whether real-PostgreSQL suites can run here.
 *
 * Callers must branch on this and *fail* rather than skip when a required suite has no
 * database — see `requireTestDatabaseUrl`. This exists so the reason is reported once,
 * in words, rather than as a silently-green empty run.
 */
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

/**
 * Creates an isolated schema with the trust tables applied.
 *
 * Migrations run inside the new schema by setting `search_path` on every connection in
 * the pool, so the DDL in `supabase/migrations` lands there without being rewritten.
 */
export async function createTestDatabase(
  options: { applyAllMigrations?: boolean; applyRls?: boolean } = {},
): Promise<TestDatabase> {
  const databaseUrl = requireTestDatabaseUrl();
  const schema = `trust_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  // A short-lived pool on the default schema, only to create the new one.
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
    get probeRole() {
      return probeRole;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await pool.dispose();
      const teardown = createPostgresPool({
        databaseUrl,
        max: 1,
        applicationName: 'assurapay-test-teardown',
      });
      try {
        // The schema first, then the role. A role cannot be dropped while anything
        // depends on it, and the probe role's privileges on this schema and its tables
        // are exactly such dependencies — dropping the role first failed with
        // "cannot be dropped because some objects depend on it" on every single test,
        // silently, and the roles accumulated in the cluster. `DROP SCHEMA CASCADE`
        // takes the grants with the objects they are grants on, which leaves nothing
        // for `DROP ROLE` to trip over.
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
      // Only this capability's migration by default. The 20 historical migrations
      // describe a per-engine model the repository contract does not read, and applying
      // them would make every suite pay for 126 tables it never touches.
      await applyTrustStoreMigration(pool.sql);
      // Applied by default, because this is the set a host requires: the runtime refuses to
      // start without it. A suite testing store behaviour rather than the tenancy boundary
      // opts out, and says so — an unscoped caller reads nothing once the policies are forced,
      // which is correct and would make those suites test the boundary by accident.
      if (options.applyRls !== false) {
        await assertConnectionCannotBypassRls(pool.sql);
        await applyRlsMigration(pool.sql);
        probeRole = await createProbeRole(pool.sql, schema);
      }
    }
  } catch (error) {
    // Teardown must not displace the reason setup failed. `dispose` now reports its own
    // failures rather than swallowing them, which is right everywhere except here: a
    // half-created schema can fail to tear down *because* of the error being reported,
    // and that error is the one the caller needs to read.
    await database.dispose().catch(() => undefined);
    throw error;
  }

  return database;
}

/**
 * Provisions the application role the denial probes run as.
 *
 * Here rather than in the migration, because creating a role needs CREATEROLE and granting
 * membership needs ADMIN OPTION — privileges a migration credential may not hold and should not
 * need. A role created by one credential also cannot be granted by another, so a migration that
 * did this succeeded on the machine that first ran it and failed with a bare "permission denied"
 * everywhere else. Provisioning is an operator action; a test harness is the operator here.
 *
 * Membership in the role is what makes certification possible: proving a cross-tenant read fails
 * requires attempting one *as the application*, and `SET ROLE` needs membership. A probe running
 * as the owner would prove only that FORCE works.
 */
async function createProbeRole(sql: SqlClient, schema: string): Promise<string> {
  // Named for the schema, so it is unique to this database and cannot collide with a role
  // another run or another credential created.
  const role = `probe_${schema.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`;
  await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
  await sql.unsafe(`GRANT "${role}" TO CURRENT_USER`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);

  // The full DML the application holds, granted directly rather than relying on the migration
  // having granted it to `assurapay_app`. The property under test is that the *policies* deny a
  // cross-tenant read, and a probe that was denied by a missing table grant would look identical
  // while proving nothing about the policies.
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE ON
       trust_tenants, trust_workspaces, trust_memberships, trust_permission_grants,
       trust_bootstrap_state, trust_outbox_events, trust_idempotency_keys, trust_records
     TO "${role}"`,
  );
  await sql.unsafe(`GRANT SELECT, INSERT ON trust_audit_records TO "${role}"`);
  return role;
}

/**
 * Drops a probe role and everything that depends on it.
 *
 * Called after the schema is gone, so the table and schema grants have already been dropped
 * with the objects they applied to. `DROP OWNED BY` still runs, because it is what removes
 * any privilege *outside* that schema — a grant added later in this database would otherwise
 * reintroduce the accumulating-roles defect, and it would do so silently.
 *
 * A failure here is not swallowed. A role that cannot be dropped is a leak in the cluster
 * running the suite, and a teardown that hides its own failure is how ninety-nine of them
 * accumulated unnoticed.
 */
async function dropProbeRole(sql: SqlClient, role: string): Promise<void> {
  await sql.unsafe(`DROP OWNED BY "${role}"`);
  await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
}

/**
 * The name of a role in this cluster that bypasses Row Level Security.
 *
 * A suite asserting that certification *reports* a bypassing role needs one to point at, and
 * cannot create it: `BYPASSRLS` and `SUPERUSER` are attributes only a superuser may grant, and
 * these suites deliberately connect as a role that is neither. So the role has to be found.
 *
 * Finding it rather than assuming `postgres` is the fix for a real CI failure. Every cluster has
 * a bootstrap superuser, but its *name* is a deployment detail — the `postgres:16` service
 * container names it after `POSTGRES_USER`, which here is `assurapay`. The hardcoded name simply
 * did not exist, so certification correctly reported `RLS_PROBE_ROLE_UNAVAILABLE` and the test
 * expecting `RLS_ROLE_BYPASSES` failed on the fixture rather than on the behaviour.
 */
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
        'bypass detection against. A cluster always has a bootstrap superuser; if this fires, ' +
        'the connected role cannot read pg_roles rather than the cluster being unusual.',
    );
  return role.rolname;
}

/**
 * Refuses to hand back a policy-governed database to a connection that can ignore the policies.
 *
 * A superuser is exempt from every Row Level Security policy, `FORCE` included, and so is any
 * role holding `BYPASSRLS`. Run as one, the tenancy suites pass or fail on what the data
 * happens to be rather than on what the policies enforce — which is how a CI run reported four
 * unrelated-looking assertion failures whose single cause was that its `POSTGRES_USER` had been
 * created as a superuser.
 *
 * Failing here turns that into one sentence naming the reason. `certifyRowLevelSecurity` reports
 * the same condition as an `RLS_ROLE_BYPASSES` finding for a caller that wants a report rather
 * than an exception.
 */
async function assertConnectionCannotBypassRls(sql: SqlClient): Promise<void> {
  const [role] = await sql<{ who: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user AS who,
           r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (role?.rolsuper || role?.rolbypassrls)
    throw new Error(
      `${role.who} can bypass row-level security (${role.rolsuper ? 'superuser' : 'BYPASSRLS'}), ` +
        'so a tenancy suite run as it would prove nothing: every policy is ignored for this role, ' +
        'forced or not. Connect as a role that owns nothing and holds neither attribute.',
    );
}

/**
 * Applies the row-level-security migration.
 *
 * Separate from the trust-store migration so a suite chooses whether the tenancy boundary is
 * in force. It is not optional in a deployment — the migration runner applies both — but a
 * store test that had to establish a tenant scope for every read would be testing two things
 * and reporting one.
 */
export async function applyRlsMigration(sql: SqlClient): Promise<void> {
  // Both, in order. The per-tenant chain migration is inseparable from RLS: forcing the
  // policies without it makes every second tenant's first audited action collide on a chain
  // position it cannot see.
  const migrations = readMigrations(migrationsDirectory()).filter(
    (entry) =>
      entry.id.endsWith('trust_row_level_security') ||
      entry.id.endsWith('trust_audit_chain_per_tenant') ||
      // Reconciliation too, because the runtime requires it and a harness whose schemas were
      // missing a required migration would produce a database no host would start against.
      // It is existence-conditional, so on a trust-only schema it marks nothing and drops
      // nothing — which is the correct outcome when the historical model was never created.
      entry.id.endsWith('trust_schema_ownership_reconciliation'),
  );
  if (migrations.length !== 3)
    throw new Error('a row-level-security or reconciliation migration is missing');
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

/** Applies the trust-store migration alone, through the same governed runner. */
export async function applyTrustStoreMigration(sql: SqlClient): Promise<void> {
  const migration = readMigrations(migrationsDirectory()).find((entry) =>
    entry.id.endsWith('trust_repository_store'),
  );
  if (!migration) throw new Error('the trust repository migration is missing');
  await sql.begin(async (tx) => {
    // The migration creates the ledger, so its own row is written afterwards inside
    // the same transaction — the two can never disagree.
    await tx.unsafe(migration.sql);
    await tx`
      INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
      VALUES (${migration.id}, ${migration.checksum}, 'integration-test', 0, ${migration.ordinal})
      ON CONFLICT (migration_id) DO NOTHING
    `;
  });
}

/**
 * Creates a throwaway *database*, not a schema, with its own `public`.
 *
 * The 20 historical migrations can only be applied this way. One of them creates
 * `has_active_workspace_membership` as a `LANGUAGE sql` `SECURITY DEFINER` function with
 * `SET search_path=public` — correct, since pinning the path is what stops a
 * search-path attack on a definer function — and PostgreSQL validates a SQL function's
 * body at creation time using that path. The tables it references live in whatever
 * schema the migration just created them in, so the function fails to compile unless
 * that schema is `public`.
 *
 * A deployment constraint worth knowing: the historical set is not schema-relocatable.
 * The trust-store migration this capability adds has no such pin and applies anywhere.
 */
export async function createTestDatabaseInstance(): Promise<TestDatabase> {
  const databaseUrl = requireTestDatabaseUrl();
  const name = `trust_db_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  const admin = createPostgresPool({ databaseUrl, max: 1, applicationName: 'assurapay-test-setup' });
  try {
    // CREATE DATABASE cannot run inside a transaction, so it goes through `unsafe`
    // directly rather than through the migration runner's transactional path.
    await admin.sql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.dispose();
  }

  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const pool = createPostgresPool({ databaseUrl: url.toString(), max: 4, applicationName: 'assurapay-test' });

  let disposed = false;
  return {
    sql: pool.sql,
    schema: 'public',
    async dispose() {
      if (disposed) return;
      disposed = true;
      await pool.dispose();
      const teardown = createPostgresPool({
        databaseUrl,
        max: 1,
        applicationName: 'assurapay-test-teardown',
      });
      try {
        await teardown.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await teardown.dispose();
      }
    },
  };
}

/**
 * Appends a schema to the connection URL's `options` parameter.
 *
 * `search_path` is set per connection rather than per statement so a pooled connection
 * cannot serve one query in the test schema and the next in `public`.
 */
function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
