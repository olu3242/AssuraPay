import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresPool } from '@assurapay/database';
import type { PostgresPool } from '@assurapay/database';
import {
  MigrationError,
  REQUIRED_TRUST_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
} from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';

/**
 * integration: the migration runner, against real PostgreSQL.
 *
 * Before this capability the runner was a single `console.log` line and the only test
 * read the SQL as text and grepped it for `CREATE TABLE`. Twenty migrations
 * had therefore never been executed anywhere — the schema was a description of intent.
 *
 * Each case gets its own schema, because a migration run is a whole-database operation
 * and two of them sharing one would be testing each other.
 */

const databaseUrl = requireTestDatabaseUrl();

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An empty schema with a pool pointed at it. */
async function emptySchema(): Promise<{ pool: PostgresPool; schema: string }> {
  const schema = `mig_${Math.random().toString(36).slice(2, 12)}`;
  const admin = createPostgresPool({ databaseUrl, max: 1 });
  await admin.sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.dispose();

  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPostgresPool({ databaseUrl: url.toString(), max: 4 });

  cleanups.push(async () => {
    await pool.dispose();
    const teardown = createPostgresPool({ databaseUrl, max: 1 });
    await teardown.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await teardown.dispose();
  });

  return { pool, schema };
}

/** A directory holding a chosen subset of the repository's migrations, plus extras. */
function migrationSet(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'assurapay-migrations-'));
  for (const [name, sql] of Object.entries(files))
    writeFileSync(path.join(directory, name), sql, 'utf8');
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The real trust-store migration, so fixtures test the runner against actual DDL. */
function trustStoreMigration(): { name: string; sql: string } {
  const migration = readMigrations(migrationsDirectory()).find((entry) =>
    entry.id.endsWith('trust_repository_store'),
  );
  if (!migration) throw new Error('the trust repository migration is missing');
  return { name: `${migration.id}.sql`, sql: readFileSync(migration.path, 'utf8') };
}

describe('integration: the repository’s migration set applies to a clean database', () => {
  it('applies all twenty-one migrations in order, on vanilla PostgreSQL', async () => {
    // The 20 historical migrations had never been run anywhere. They need nothing
    // Supabase-specific — `current_setting('app.*')` session variables and pgcrypto,
    // both of which vanilla PostgreSQL 16 provides — but they are not
    // schema-relocatable, so this runs against its own database rather than a schema.
    const database = await createTestDatabaseInstance();
    cleanups.push(() => database.dispose());

    const outcomes = await applyMigrations(database.sql, migrationsDirectory());

    expect(outcomes.length).toBeGreaterThanOrEqual(21);
    expect(outcomes.every((outcome) => outcome.applied)).toBe(true);

    const tables = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const names = new Set(tables.map((row) => row.table_name));
    for (const table of REQUIRED_TRUST_TABLES) expect(names.has(table), table).toBe(true);
    expect(names.size).toBeGreaterThan(100);
  });

  it('is a no-op on a second run rather than a failure', async () => {
    const { pool } = await emptySchema();
    const directory = migrationSet({ [trustStoreMigration().name]: trustStoreMigration().sql });

    const first = await applyMigrations(pool.sql, directory);
    const second = await applyMigrations(pool.sql, directory);

    expect(first.every((outcome) => outcome.applied)).toBe(true);
    expect(second.every((outcome) => outcome.applied)).toBe(false);
    expect(second[0].skippedReason).toBe('ALREADY_APPLIED');
  });

  it('records each applied migration with a checksum', async () => {
    const { pool } = await emptySchema();
    const migration = trustStoreMigration();
    await applyMigrations(pool.sql, migrationSet({ [migration.name]: migration.sql }), {
      appliedBy: 'test-operator',
    });

    const [row] = await pool.sql<
      { migration_id: string; checksum: string; applied_by: string }[]
    >`SELECT migration_id, checksum, applied_by FROM trust_migration_ledger`;
    expect(row.migration_id).toBe(migration.name.replace('.sql', ''));
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row.applied_by).toBe('test-operator');
  });
});

describe('integration: an edited migration is refused, not reapplied', () => {
  it('rejects a migration whose file changed after it was applied', async () => {
    // The database already has the original's effects. No sequence of statements here
    // can reconcile the two, so the honest answer is to refuse and demand a forward
    // corrective migration.
    const { pool } = await emptySchema();
    const migration = trustStoreMigration();

    const directory = migrationSet({ [migration.name]: migration.sql });
    await applyMigrations(pool.sql, directory);

    writeFileSync(
      path.join(directory, migration.name),
      `${migration.sql}\n-- an innocuous-looking edit\n`,
      'utf8',
    );

    const error = await applyMigrations(pool.sql, directory).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe('MIGRATION_CHECKSUM_MISMATCH');
    expect((error as MigrationError).message).toContain('forward corrective migration');
  });

  it('reports a divergent ledger entry through the compatibility check', async () => {
    const { pool } = await emptySchema();
    const migration = trustStoreMigration();
    const directory = migrationSet({ [migration.name]: migration.sql });
    await applyMigrations(pool.sql, directory);

    writeFileSync(path.join(directory, migration.name), `${migration.sql}\n-- edited\n`, 'utf8');

    const compatibility = await verifySchemaCompatibility(pool.sql, directory);
    expect(compatibility.compatible).toBe(false);
    expect(compatibility.divergent).toEqual([migration.name.replace('.sql', '')]);
  });
});

describe('integration: a failing migration leaves nothing behind', () => {
  it('rolls back the whole migration, including its ledger row', async () => {
    // Transactional DDL is why this is possible. A runner that committed statement by
    // statement would leave a schema that is neither the old one nor the new one, and a
    // ledger claiming success.
    const { pool, schema } = await emptySchema();
    const directory = migrationSet({
      '202700000001_partly_valid.sql':
        'CREATE TABLE will_not_survive (id TEXT PRIMARY KEY);\nSELECT nonexistent_function();\n',
    });

    const error = await applyMigrations(pool.sql, directory).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe('MIGRATION_FAILED');

    const tables = await pool.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'will_not_survive'
    `;
    expect(tables).toEqual([]);

    // The ledger itself is gone too: the runner creates it inside the same transaction
    // as the migrations, so a failed run leaves the database exactly as it was rather
    // than with an empty ledger implying an attempt that half-happened.
    const ledger = await pool.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'trust_migration_ledger'
    `;
    expect(ledger).toEqual([]);
  });

  it('releases the advisory lock after a failure, so the next attempt is not blocked', async () => {
    const { pool } = await emptySchema();
    const broken = migrationSet({ '202700000001_broken.sql': 'THIS IS NOT SQL;\n' });

    await expect(applyMigrations(pool.sql, broken)).rejects.toBeInstanceOf(MigrationError);

    // A lock still held would make this second call fail with MIGRATION_LOCK_UNAVAILABLE
    // rather than with the migration's own error.
    const second = await applyMigrations(pool.sql, broken).catch((caught: unknown) => caught);
    expect((second as MigrationError).code).toBe('MIGRATION_FAILED');
  });
});

describe('integration: order is deterministic and unambiguous', () => {
  it('refuses two migrations that claim the same position', async () => {
    // Filename order is only deterministic while prefixes are unique. Two migrations
    // sharing one would apply in whatever order the filesystem returned, which differs
    // between machines — and a schema that depends on the machine is not a schema.
    const directory = migrationSet({
      '202700000001_first.sql': 'SELECT 1;\n',
      '202700000001_second.sql': 'SELECT 1;\n',
    });
    expect(() => readMigrations(directory)).toThrow('MIGRATION_ORDER_AMBIGUOUS');
  });

  it('numbers migrations by their sorted position', () => {
    const migrations = readMigrations(migrationsDirectory());
    expect(migrations.map((migration) => migration.ordinal)).toEqual(
      migrations.map((_migration, index) => index + 1),
    );
    expect(migrations[0].id).toContain('202608010001');
  });

  it('refuses an empty directory rather than reporting success', async () => {
    const directory = migrationSet({});
    expect(() => readMigrations(directory)).toThrow('MIGRATION_DIRECTORY_EMPTY');
  });
});

describe('integration: concurrent runners do not both apply', () => {
  it('lets one runner apply while the other reports the lock', async () => {
    // Two processes starting together would otherwise both read an empty ledger and
    // both apply, and the second would fail partway through on objects the first had
    // already created.
    const { pool } = await emptySchema();
    const migration = trustStoreMigration();
    const directory = migrationSet({ [migration.name]: migration.sql });

    const [first, second] = await Promise.allSettled([
      applyMigrations(pool.sql, directory),
      applyMigrations(pool.sql, directory),
    ]);

    // Both succeed: the second waits on the transaction-scoped lock, then finds the
    // migration already in the ledger and applies nothing. A session-scoped lock taken
    // through a pool could be held by one connection while the migrations ran on
    // another, and both runners proceeded.
    expect([first.status, second.status]).toEqual(['fulfilled', 'fulfilled']);
    const applied = [first, second]
      .flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []))
      .filter((outcome) => outcome.applied);
    expect(applied).toHaveLength(1);

    // Whatever the interleaving, the schema is applied exactly once.
    const ledger = await pool.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM trust_migration_ledger
    `;
    expect(ledger[0].count).toBe('1');
  });
});

describe('integration: compatibility is reported without changing anything', () => {
  it('reports every migration pending against an empty database', async () => {
    const { pool } = await emptySchema();
    const compatibility = await verifySchemaCompatibility(pool.sql, migrationsDirectory());

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.pending.length).toBeGreaterThanOrEqual(21);
    expect(compatibility.missingTables).toEqual([...REQUIRED_TRUST_TABLES]);
  });

  it('reports compatible once the set has been applied', async () => {
    const database = await createTestDatabaseInstance();
    cleanups.push(() => database.dispose());
    await applyMigrations(database.sql, migrationsDirectory());

    const compatibility = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatibility).toEqual({
      compatible: true,
      pending: [],
      // Empty for the same reason `pending` is — everything is applied here. The two differ
      // when a host's database is missing a migration belonging to another bounded context:
      // that is reported as pending but does not block a trust runtime from starting.
      pendingRequired: [],
      divergent: [],
      missingTables: [],
    });
  });

  it('creates nothing while verifying, so a read-only host may call it', async () => {
    const { pool, schema } = await emptySchema();
    await verifySchemaCompatibility(pool.sql, migrationsDirectory());

    const tables = await pool.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema}
    `;
    expect(tables).toEqual([]);
  });
});
