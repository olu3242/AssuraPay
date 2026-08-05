import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { SqlClient } from './postgres-client';

/**
 * The governed migration runner.
 *
 * `scripts/run-migrations.js` was a single `console.log`, and the only test of the
 * SQL read the files as text and grepped for `CREATE TABLE`. Twenty migrations had
 * therefore never been executed against a database — the schema was a description
 * of intent, not a thing that existed.
 *
 * What this adds beyond "run the files in order":
 *
 *   - a ledger, so a second run is a no-op rather than a failure;
 *   - a checksum per applied migration, so an edited file is refused instead of
 *     silently diverging from every environment that already applied the original;
 *   - an advisory lock, so two processes starting at once do not both apply;
 *   - one transaction per migration, so a failure leaves no half-applied DDL.
 *
 * The runner never runs implicitly. A repository call that could migrate would let
 * a request handler alter the schema, and production migration policy belongs to
 * the runtime, not to a read.
 */

/** Namespace for the advisory lock. Any constant works; it must simply be stable. */
const MIGRATION_LOCK_KEY = 0x41535355; // 'ASSU'

export type MigrationFile = {
  /** Filename without extension — the stable id recorded in the ledger. */
  id: string;
  /** Position in the deterministic order. */
  ordinal: number;
  path: string;
  sql: string;
  checksum: string;
};

export type MigrationOutcome = {
  id: string;
  applied: boolean;
  /** Present when the migration was skipped because the ledger already had it. */
  skippedReason?: 'ALREADY_APPLIED';
  executionMs: number;
};

export type MigrationErrorCode =
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_LEDGER_UNAVAILABLE'
  /**
   * Reserved. The runner now waits on a transaction-scoped lock instead of failing
   * fast on a session-scoped one, so a concurrent runner blocks rather than erroring.
   */
  | 'MIGRATION_LOCK_UNAVAILABLE'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_DIRECTORY_EMPTY'
  | 'MIGRATION_ORDER_AMBIGUOUS';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migrationId?: string;

  constructor(code: MigrationErrorCode, detail: string, migrationId?: string) {
    super(`${code}: ${detail}`);
    this.name = 'MigrationError';
    this.code = code;
    this.migrationId = migrationId;
  }
}

/**
 * Reads the migration set in deterministic order.
 *
 * Sorted by filename because the repository's ids are timestamp-prefixed, and a
 * duplicate prefix is rejected rather than resolved arbitrarily: two migrations
 * claiming the same position would apply in filesystem order, which differs between
 * machines.
 */
export function readMigrations(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (names.length === 0)
    throw new MigrationError('MIGRATION_DIRECTORY_EMPTY', directory);

  const prefixes = new Set<string>();
  return names.map((name, index) => {
    const prefix = name.split('_')[0];
    if (prefixes.has(prefix))
      throw new MigrationError(
        'MIGRATION_ORDER_AMBIGUOUS',
        `two migrations share the prefix ${prefix}`,
        name,
      );
    prefixes.add(prefix);

    const absolute = path.join(directory, name);
    const sql = readFileSync(absolute, 'utf8');
    return {
      id: name.replace(/\.sql$/, ''),
      ordinal: index + 1,
      path: absolute,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

/** The ledger table, created outside the migration set so the first run has one. */
async function ensureLedger(sql: SqlClient): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS trust_migration_ledger (
      migration_id TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by   TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      ordinal      INTEGER NOT NULL
    )
  `;
}

type LedgerRow = { migration_id: string; checksum: string };

async function readLedger(sql: SqlClient): Promise<Map<string, string>> {
  const rows = await sql<LedgerRow[]>`
    SELECT migration_id, checksum FROM trust_migration_ledger
  `;
  return new Map(rows.map((row) => [row.migration_id, row.checksum]));
}

/**
 * Applies every migration the ledger does not already record.
 *
 * Holds a session-level advisory lock for the whole run. Two processes starting
 * together would otherwise both read an empty ledger and both apply, and the second
 * would fail partway through on objects the first had already created — leaving a
 * database that is neither the old schema nor the new one.
 */
export async function applyMigrations(
  sql: SqlClient,
  directory: string,
  options: { appliedBy?: string } = {},
): Promise<MigrationOutcome[]> {
  const migrations = readMigrations(directory);
  const appliedBy = options.appliedBy ?? 'assurapay-migration-runner';

  try {
    // The whole run is one transaction, and the lock is transaction-scoped.
    //
    // `pg_try_advisory_lock` is *session*-scoped, and a session behind a pool is not
    // the same connection from one statement to the next — the lock could be taken on
    // one connection, the migrations run on another, and the unlock issued on a third.
    // Two concurrent runners then both proceeded, which is exactly what the lock was
    // there to prevent. `pg_advisory_xact_lock` binds to the transaction's own
    // connection, blocks the second runner until the first commits, and is released by
    // the commit or rollback with no unlock statement to forget.
    //
    // One transaction for the whole set is also a stronger guarantee than one per
    // migration: PostgreSQL has transactional DDL, so the schema either advances
    // completely or not at all, and a half-migrated database cannot exist.
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      await ensureLedger(tx);
      const ledger = await readLedger(tx);
      const outcomes: MigrationOutcome[] = [];

      for (const migration of migrations) {
        const recorded = ledger.get(migration.id);

        if (recorded !== undefined) {
          // An applied migration whose file has changed. Refused rather than
          // reapplied: the database already has the original's effects, and no
          // sequence of statements here can reconcile the two.
          if (recorded !== migration.checksum)
            throw new MigrationError(
              'MIGRATION_CHECKSUM_MISMATCH',
              `${migration.id} was applied with a different checksum; add a forward corrective migration instead of editing it`,
              migration.id,
            );
          outcomes.push({
            id: migration.id,
            applied: false,
            skippedReason: 'ALREADY_APPLIED',
            executionMs: 0,
          });
          continue;
        }

        const started = Date.now();
        try {
          await tx.unsafe(migration.sql);
          await tx`
            INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
            VALUES (${migration.id}, ${migration.checksum}, ${appliedBy}, ${Date.now() - started}, ${migration.ordinal})
          `;
        } catch (error) {
          if (error instanceof MigrationError) throw error;
          throw new MigrationError(
            'MIGRATION_FAILED',
            `${migration.id}: ${error instanceof Error ? error.message : String(error)}`,
            migration.id,
          );
        }

        outcomes.push({ id: migration.id, applied: true, executionMs: Date.now() - started });
      }

      return outcomes;
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(
      'MIGRATION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Migrations the repository contract cannot work without.
 *
 * Scoped deliberately. `supabase/migrations` also holds twenty migrations describing a
 * per-engine relational model that `TrustPersistence` never reads, and a trust runtime
 * that refused to start until those were applied would be gating on a different bounded
 * context's schema. Divergence in *any* applied migration remains fatal — that means the
 * code and the database disagree about history — but only these must be present.
 */
export const REQUIRED_TRUST_MIGRATIONS: readonly string[] = Object.freeze([
  '202608060001_trust_repository_store',
]);

export type SchemaCompatibility = {
  compatible: boolean;
  /** Migrations the files declare that the database has not applied. */
  pending: string[];
  /**
   * Pending migrations the repository contract requires. A host may start with `pending`
   * entries belonging to another context; it may not start missing one of these.
   */
  pendingRequired: string[];
  /** Ledger entries whose file no longer matches, or no longer exists. */
  divergent: string[];
  /** Required tables the database is missing. */
  missingTables: string[];
};

/**
 * Tables the repository reads and writes. Absent any one of them, the store cannot
 * serve a request, so readiness must be false rather than discovering it per query.
 */
export const REQUIRED_TRUST_TABLES = Object.freeze([
  'trust_audit_records',
  'trust_bootstrap_state',
  'trust_idempotency_keys',
  'trust_memberships',
  'trust_migration_ledger',
  'trust_outbox_events',
  'trust_permission_grants',
  'trust_records',
  'trust_tenants',
  'trust_workspaces',
]);

/**
 * Answers whether the database matches the migration set, without changing it.
 *
 * Separate from `applyMigrations` because a production host must be able to verify
 * compatibility while being forbidden to migrate — those are different authorities,
 * and conflating them is how a web request ends up altering a schema.
 */
export async function verifySchemaCompatibility(
  sql: SqlClient,
  directory: string,
): Promise<SchemaCompatibility> {
  const migrations = readMigrations(directory);

  let ledger: Map<string, string>;
  try {
    ledger = await readLedger(sql);
  } catch {
    // No ledger at all: every migration is pending, and the tables are missing.
    return {
      compatible: false,
      pending: migrations.map((migration) => migration.id),
      pendingRequired: [...REQUIRED_TRUST_MIGRATIONS],
      divergent: [],
      missingTables: [...REQUIRED_TRUST_TABLES],
    };
  }

  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const pending = migrations
    .filter((migration) => !ledger.has(migration.id))
    .map((migration) => migration.id);

  const divergent: string[] = [];
  for (const [id, checksum] of ledger) {
    const migration = byId.get(id);
    if (!migration || migration.checksum !== checksum) divergent.push(id);
  }

  const present = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
  `;
  const names = new Set(present.map((row) => row.table_name));
  const missingTables = REQUIRED_TRUST_TABLES.filter((table) => !names.has(table));

  const pendingRequired = REQUIRED_TRUST_MIGRATIONS.filter((id) => !ledger.has(id));

  return {
    compatible:
      pendingRequired.length === 0 && divergent.length === 0 && missingTables.length === 0,
    pending,
    pendingRequired,
    divergent: divergent.sort(),
    missingTables,
  };
}
