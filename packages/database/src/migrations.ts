import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  BATCH_A_TABLES,
  BATCH_B_TABLES,
  BATCH_C_TABLES,
  BATCH_D_TABLES,
  BATCH_E_TABLES,
  BATCH_F_TABLES,
  BATCH_G_TABLES,
  BATCH_H_TABLES,
  BATCH_I_TABLES,
  BATCH_K_TABLES,
  BATCH_L_TABLES,
  BATCH_M_TABLES,
} from '@assurapay/domain-contracts';
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

/**
 * Checksums an earlier revision of a migration file was applied under.
 *
 * The ledger refuses an applied migration whose file has changed, and it is right to: the database
 * already holds the original's effects and no statement here can reconcile the two. This map is the
 * narrow exception, and every entry has to earn it by argument, not convenience.
 *
 * An entry is only sound when the edited file leaves a host that applied the original in exactly the
 * state the new file would have produced. That is a claim about the two revisions being
 * indistinguishable in outcome for the hosts that got through the original — not a claim that editing
 * migrations is acceptable. Anything else is still a forward corrective migration.
 */
const SUPERSEDED_CHECKSUMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    // `202608110003` refused to run at all when `payment_instructions` held any row, and told the
    // operator to backfill `payload_digest` and re-run — an instruction that could not be followed,
    // because the refusal fired before the column existed. Every host that had created a single payment
    // instruction was permanently unable to upgrade, and a forward migration could not rescue them: the
    // set is ordered and runs in one transaction, so nothing after the refusal is ever reached. The file
    // had to stop refusing.
    //
    // A host only recorded this migration if it got through it, which only happened when the table was
    // empty, and on an empty table the revised file adds the same nullable column, the same NOT NULL,
    // the same length check and the same trigger — the unresolved-digest count is zero, so the new
    // refusal cannot fire. The end state is identical, which is what makes accepting the old checksum
    // sound rather than expedient.
    '202608110003_wave5_close_batch_c_gaps',
    new Set(['559945007a0218166da75d1e5dcca9b75f4f55a44188591055d37f37bbd1430e']),
  ],
]);

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
          if (recorded !== migration.checksum) {
            if (!SUPERSEDED_CHECKSUMS.get(migration.id)?.has(recorded))
              throw new MigrationError(
                'MIGRATION_CHECKSUM_MISMATCH',
                `${migration.id} was applied with a different checksum; add a forward corrective migration instead of editing it`,
                migration.id,
              );
            // Converge the ledger on the current file so the exception is needed once. Left unwritten,
            // every later startup would re-derive the same allowance from a table that still disagrees
            // with the file, and the map could never be emptied.
            await tx`
              UPDATE trust_migration_ledger SET checksum = ${migration.checksum}
              WHERE migration_id = ${migration.id}
            `;
          }
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
  '202608070001_trust_row_level_security',
  '202608070002_trust_audit_chain_per_tenant',
  // Required, not optional. Until it is applied the database holds two relational models for
  // the same trust aggregates, and a host that started anyway would be one console session
  // away from writing the wrong one.
  '202608080001_trust_schema_ownership_reconciliation',
  // Batch A. The store routes sixteen Engine 31-40 collections to the tables these four
  // migrations create, converge and govern, so a host missing any of them would start and then
  // fail the first execution-workspace write with an undefined-table error. Requiring them has
  // a deployment consequence worth stating: `202608030006` and `202608030007` belong to the
  // historical per-engine set, and one of that set's functions is `SECURITY DEFINER` with
  // `SET search_path=public`, so the set is not schema-relocatable. A trust runtime that serves
  // Batch A therefore runs in `public`. That was already true of the ninety-three out-of-scope
  // tables; it is now true of the runtime contract, and stated rather than discovered.
  '202608030006_execution_orchestration',
  '202608030007_completion_assurance',
  '202608090001_wave4_trust_authority',
  '202608100001_wave4_batch_a_governed_transitions',
  // Batch B, for the same reason: the store routes seven Engine 41-46 collections to tables these
  // three migrations create, converge and govern. `202608030008` and `202608030009` belong to the
  // same non-schema-relocatable historical set as Batch A's, so this adds no new deployment
  // constraint beyond the one already stated.
  '202608030008_settlement_assurance',
  '202608030009_settlement_execution',
  '202608100002_wave5_batch_b_settlement_authority',
  // Batch C, and the last of the settlement path: the store routes seven Engine 44 and 47-50
  // collections to tables `202608030008`, `202608030009` and `202608110001` create, converge and
  // govern. The first two are already required for Batch B, so `202608110001` is the only addition.
  '202608110001_wave5_batch_c_settlement_ledger',
  // Batch D, and the last of the wave 4-5 plan: the store routes five Engine 49 collections to
  // tables `202608030009` and `202608110002` create, converge and govern, and `202608110002` is also
  // what makes an active dispute hold block a release. A host missing it would start with hold
  // enforcement absent, which is the one gap that must never be silent.
  '202608110002_wave5_batch_d_dispute_linkage',
  // Closes the two gaps Batch C recorded. Required rather than optional because both are columns the
  // repositories now read and write: a host without it fails the first reconciliation and the first
  // payment instruction with an undefined-column error.
  '202608110003_wave5_close_batch_c_gaps',
  // Batch E. The store routes six Engine 21-25 collections to tables `202608030004` created and
  // `202608110004` converges and governs. `202608110004` also generalises the shared
  // governed-transition function, so a host missing it would have triggers configured for a
  // concurrency column the function does not know how to read.
  '202608110004_wave6_batch_e_performance_blueprint',
  // Batch F. The store routes fifteen Engine 11-15 collections to tables `202608030002` created and
  // `202608110005` converges and governs — plus two tables `202608110005` *creates*, because
  // `contract_comments` and `signature_callbacks` had no relation anywhere. A host missing it would
  // fail the first contract comment and the first provider callback with an undefined-table error, and
  // would carry no digest chain between an approved document, the package that signs it and the
  // certificate that attests it.
  '202608110005_wave6_batch_f_agreement_creation',
  // Narrows the invoice-number key to live invoices. Required rather than optional because the
  // constraint it replaces is *stricter* than the engine: a host without it can reject an invoice and
  // then refuse the corrected resubmission that carries the same counterparty document reference,
  // leaving a confirmed entitlement with no route to an invoice.
  '202608110006_close_batch_b_invoice_number_gap',
  // Puts two settlement-closure rules in the schema. Required rather than optional because the second
  // adds a generated column the certificate's foreign key is built on: a host without it would accept a
  // closure certificate for an account that is not closed, and one with it would refuse the same write,
  // so the two disagree about what a final settlement is.
  '202608110007_close_settlement_closure_gaps',
  // Puts `workspace_id` in every cross-aggregate foreign key. Required rather than optional because a
  // host without it accepts a child row citing a parent in another workspace of the same tenant — a
  // reference no policy refuses, since foreign keys are checked by the system rather than through RLS.
  '202608110008_workspace_scoped_references',
  // Batch G. The store routes six Engine 26-30 collections to tables `202608030005` created and this
  // migration converges and governs. Required rather than optional for two reasons: the columns the
  // repositories read and write do not exist without it, and it is what makes a payment trigger rule
  // activatable at all — a host missing it cannot move a rule out of DRAFT, so no rule can ever be
  // evaluated and every eligibility record cites an authority that is permanently inert.
  '202608110009_wave6_batch_g_performance_readiness',
  // Scopes six unique keys that still partitioned the whole platform. Required rather than optional
  // because a host without it refuses ordinary writes from a second tenant — whichever tenant reaches a
  // `(contract_id, version)` pair first holds it against every other one, permanently.
  '202608110010_tenant_scoped_unique_keys',
  // Batch H. The store routes eleven Engine 06-10 collections to tables `202608030006` and `202608030007`
  // created and this migration converges and governs. Required rather than optional, and the most
  // consequential of the set: without it eight of the eleven tables have no mutation boundary at all, and a
  // BLOCKED payment authorization proposal is one UPDATE away from authorising a release for uncertified
  // work.
  '202608110011_wave6_batch_h_governance_core',
  // Batch I. The store routes six Engine 16-20 collections; five of the tables `202608030004` created and
  // this migration converges, and `analysis_reviews` it creates — a reviewer's decision on a finding had no
  // table at all. Required rather than optional: without it a published intelligence version can contain
  // unreviewed items, which is the human-in-the-loop rule for machine-extracted contract terms.
  '202608110012_wave6_batch_i_agreement_intelligence',
  // Batch J. A workspace slug had no unique index on the table that has a reader — the only one was on the
  // deprecated `workspaces` this batch retires. Required rather than optional: without it two concurrent
  // registrations claiming the same slug both succeed, and the engine's read-then-write check cannot see
  // the other transaction. Safe on an existing database because until this batch every workspace carried a
  // tenant of its own, so no `(tenant_id, slug)` pair can already be duplicated.
  '202608110013_workspace_slug_is_tenant_scoped',
  // Batch K. The store routes six Engine 51-55 collections to tables `202608030008` created and this
  // migration converges and governs. Required rather than optional, and consequential for two engines: a
  // blanket append-only trigger refused `EnterpriseKpiEngine.retire` and
  // `PredictiveExecutionIntelligenceEngine.review`, so a KPI definition could never leave ACTIVE and a
  // forecast could never be reviewed — the human-in-the-loop step that package's AI-governance contract is
  // built on was unperformable on the durable store.
  '202608110014_wave6_batch_k_enterprise_intelligence',
  // Batch L. The store routes nine Engine 56-60 collections to tables `202608030009` created and this
  // migration converges and governs. Required rather than optional, and the most consequential mutation
  // boundary in the programme: three of its four transitioning aggregates were refused by a blanket
  // append-only trigger — a financial forecast could not be reviewed, a drifting model could not be
  // deprecated, an AI recommendation could not be accepted or dismissed — while `drift_alerts`, the evidence
  // that a model had gone wrong, had no boundary at all.
  '202608110015_wave6_batch_l_enterprise_analytics',
  // The retirement `202608080001` named its condition for and could not perform. Required rather than
  // optional: leaving three deprecated tables and a function that reads one of them is how the next policy
  // gets written against the superseded model. Refuses rather than discards if any holds rows.
  '202608110016_retire_trust_compatibility_tables',
  // Batch M, and the last entry in the register. The store routes nine Engine 61-70 collections to tables this
  // migration *creates* — the only batch since Batch A that does. Required rather than optional for two
  // reasons: a host missing it fails the first agent write with an undefined-table error, and it is what
  // retires `agent_runtime.records`, the untyped envelope in which a capability could be edited into executing
  // a protected-state change and an execution could not transition at all.
  '202608110017_wave6_batch_m_agent_runtime',
  // Makes every money column refuse a fractional amount rather than rounding it. Required rather than optional
  // because the two disagree about what a valid amount is, and the looser one corrupts silently: a host without
  // it stores 100.5 kobo as 101, and in `reconciliation_records` two amounts differing by less than a kobo round
  // equal — which inverts `matched`, refusing the truthful row and accepting a clean match for a real
  // discrepancy. Safe on populated tables: BIGINT to NUMERIC is a widening conversion.
  '202608110018_money_columns_refuse_fractional_amounts',
  // Retires `contracts` and `milestones`. Required rather than optional for the reason `202608110016` was: they
  // are superseded legacy tables with no reader, no writer and no row-level security at all, and leaving a
  // superseded model in place is how the next policy gets written against it. After it, the only table in the
  // schema with no boundary is `trust_migration_ledger` — a table about the database rather than about a tenant.
  '202608110019_retire_dead_legacy_tables',
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
 * Domain aggregate tables the store owns outside the trust set.
 *
 * Taken from the contract registries rather than restated, so an aggregate cannot be given a repository
 * without becoming a readiness requirement. Batch A's sixteen, Batch B's seven, Batch C's seven, Batch
 * D's five, Batch E's six and Batch F's fifteen.
 *
 * `fund_reservations` and `funding_commitments` are now here, and were deliberately absent until
 * Batch C. `202608100002` converged their schema — Batch B's foreign-key closure forced it, because
 * the closure could not be converted in parts — but they had no repository and no route, and
 * requiring a table the store never reads would have made readiness assert something it did not
 * depend on. `202608110001` activates them, so the requirement follows the route rather than the
 * conversion.
 *
 * Kept as its own constant because it answers a different question. The trust tables are what
 * authentication, authorization, membership and the audit chain need; these are what Engines
 * 31-50 need. A deployment could be missing the second set and still serve a login, which is
 * why the readiness report names which tables are absent rather than only that some are.
 */
export const REQUIRED_DOMAIN_AGGREGATE_TABLES = Object.freeze(
  [
    ...BATCH_A_TABLES,
    ...BATCH_B_TABLES,
    ...BATCH_C_TABLES,
    ...BATCH_D_TABLES,
    ...BATCH_E_TABLES,
    ...BATCH_F_TABLES,
    ...BATCH_G_TABLES,
    ...BATCH_H_TABLES,
    ...BATCH_I_TABLES,
    ...BATCH_K_TABLES,
    ...BATCH_L_TABLES,
    ...BATCH_M_TABLES,
  ].sort(),
);

/**
 * Every table `PostgresTrustStore` reads or writes.
 *
 * The union, and the set `verifySchemaCompatibility` actually checks. A store that routes a
 * collection to a table it does not require at startup discovers the absence on the first
 * write, having already told the caller the host was ready.
 */
export const REQUIRED_STORE_TABLES = Object.freeze(
  [...REQUIRED_TRUST_TABLES, ...REQUIRED_DOMAIN_AGGREGATE_TABLES].sort(),
);

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
      missingTables: [...REQUIRED_STORE_TABLES],
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
  const missingTables = REQUIRED_STORE_TABLES.filter((table) => !names.has(table));

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
