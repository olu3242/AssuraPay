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
  options: { applyAllMigrations?: boolean } = {},
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
  const database: TestDatabase = {
    sql: pool.sql,
    schema,
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
        await teardown.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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
    }
  } catch (error) {
    await database.dispose();
    throw error;
  }

  return database;
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
