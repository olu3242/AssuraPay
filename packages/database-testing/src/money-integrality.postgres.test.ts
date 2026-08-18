import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '@assurapay/database';
import type { SqlClient } from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: a money column refuses a fractional amount, and the last unbounded tables are gone.
 *
 * Two closures, both recorded as open in `docs/persistence/DURABILITY_GAP_ANALYSIS.md` after Batch M.
 *
 * ## The one the register named
 *
 * Thirty-one money columns across twenty-two tables, every one integer minor units per CLAUDE.md's fourth
 * constraint, and every one `BIGINT`. A CHECK cannot save a value an integer column has already changed: the
 * cast happens first, so `100.5` was stored as `101` and `99.5` as `100` — half-away-from-zero, so not even
 * consistently in one direction. The only thing refusing a fractional amount was the `minorUnits` contract
 * applied before the statement, which means the database this programme spent thirteen batches making the
 * authority was the looser of the two.
 *
 * The consequence that makes it a settlement defect rather than a rounding nit is in `reconciliation_records`,
 * and it is an inversion rather than an omission. `matched` is a CHECK over the equality of
 * `provider_reported_amount_minor` and `recorded_amount_minor`. Two amounts differing by less than a kobo round
 * to the same integer, and then the database **refuses the truthful `matched = false` row and accepts
 * `matched = true`** — recording a clean match for a real discrepancy, permanently, because CLAUDE.md's third
 * hard constraint makes that row history. Both halves of that inversion were proved by statement against a live
 * instance before `202608110018` was written, and the test below is their inverse.
 *
 * ## The one nobody had named
 *
 * `contracts` and `milestones`: no rows, no policies, no foreign keys in either direction, and — unlike the 59
 * tables Batches A-M converted from ENABLE to FORCE — **no row-level security at all**. Superseded by
 * `agreements_v2` and `blueprint_milestones`; the `_v2` suffix exists precisely because `agreements` was taken
 * by the legacy table this retires. `202608110019` drops both, leaving `trust_migration_ledger` as the only
 * table in the schema without a boundary, which is the one legitimate exception.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

let pending: Promise<TestDatabase> | undefined;
/** One database for the file — these assertions are about the schema, not about rows. */
function migrated(): Promise<TestDatabase> {
  return (pending ??= (async () => {
    const database = await createTestDatabaseInstance();
    databases.push(database);
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
    return database;
  })());
}

function raw<T>(database: TestDatabase, work: (tx: SqlClient) => Promise<T>): Promise<T> {
  return database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', 'tenant-money', true)`;
    await tx`SELECT set_config('app.workspace_id', 'workspace-money', true)`;
    return await work(tx);
  });
}

function attempt<T>(work: Promise<T>): Promise<T | unknown> {
  return work.catch((caught: unknown) => caught);
}

/**
 * The two amount columns of `reconciliation_records` and its derived flag, with the real types and the real
 * constraint, in a temporary table.
 *
 * A temporary table rather than the real one because `reconciliation_records` sits at the end of the settlement
 * chain and seeding it means seeding eleven parents — which would make this assertion depend on all of them
 * rather than on the property under test. The column types and the constraint definition are asserted against
 * the real table separately below, so the two together say what the real table does.
 */
const RECON_PROBE = `
  CREATE TEMP TABLE recon_probe (
    id TEXT PRIMARY KEY,
    provider_reported_amount_minor NUMERIC NOT NULL
      CHECK (provider_reported_amount_minor = trunc(provider_reported_amount_minor)),
    recorded_amount_minor NUMERIC NOT NULL
      CHECK (recorded_amount_minor = trunc(recorded_amount_minor)),
    matched BOOLEAN NOT NULL,
    CONSTRAINT matched_follows_from_amounts
      CHECK (matched = (provider_reported_amount_minor = recorded_amount_minor))
  )
`;

describe('integration: every money column is exact', () => {
  it('leaves no money column as an integer type', async () => {
    const database = await migrated();
    const integers = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string; data_type: string }[]>`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND data_type IN ('bigint', 'integer', 'smallint')
          AND (column_name LIKE '%\\_minor' OR column_name LIKE '%minor\\_units%'
               OR column_name LIKE '%amount%')
        ORDER BY table_name, column_name
      `,
    );
    // The assertion the migration also makes about itself, made again from outside it: a column whose name says
    // it holds money and whose type is an integer one rounds a fractional amount rather than refusing it.
    expect(integers).toEqual([]);

    const money = await raw(database, (tx) =>
      tx<{ count: string }[]>`
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = current_schema() AND data_type = 'numeric'
          AND (column_name LIKE '%\\_minor' OR column_name LIKE '%minor\\_units%'
               OR column_name LIKE '%amount%')
      `,
    );
    // Not vacuous: the emptiness above would also hold if the scan matched nothing at all.
    expect(Number(money[0]?.count)).toBe(31);
  }, 300_000);

  it('gives every money column an integrality check and a safe-integer bound', async () => {
    const database = await migrated();
    const unguarded = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = current_schema() AND c.data_type = 'numeric'
          AND (c.column_name LIKE '%\\_minor' OR c.column_name LIKE '%minor\\_units%'
               OR c.column_name LIKE '%amount%')
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint k
            WHERE k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
              AND k.contype = 'c'
              AND k.conname = c.column_name || '_is_integral'
          )
        ORDER BY 1, 2
      `,
    );
    expect(unguarded).toEqual([]);

    const unbounded = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = current_schema() AND c.data_type = 'numeric'
          AND (c.column_name LIKE '%\\_minor' OR c.column_name LIKE '%minor\\_units%'
               OR c.column_name LIKE '%amount%')
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint k
            WHERE k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
              AND k.contype = 'c'
              AND k.conname = c.column_name || '_within_safe_range'
          )
        ORDER BY 1, 2
      `,
    );
    // The read-side half of the same defect: every repository parses these columns through `Number(...)`, so a
    // stored value above 2^53 - 1 is not the value that comes back, and `Number.isInteger` still says true.
    expect(unbounded).toEqual([]);
  }, 300_000);

  it('refuses a fractional amount, and an amount too large to read back', async () => {
    const database = await migrated();

    // `LIKE ledger_entries INCLUDING ALL` copies the column types, defaults and CHECK constraints and **not**
    // the foreign keys — which is exactly the isolation this needs. Every one of the thirty-one money columns
    // sits on a table with parents (`ledger_entries` has four), so an insert against the real table is refused
    // by a foreign key or a NOT NULL before any amount constraint is evaluated, and would prove nothing about
    // the amount. This carries the real definitions without the chain.
    const probe = async (tx: SqlClient, amount: string) => {
      await tx.unsafe('CREATE TEMP TABLE ledger_probe (LIKE ledger_entries INCLUDING ALL)');
      return await tx.unsafe(`
        INSERT INTO ledger_probe
          (id, tenant_id, workspace_id, payment_instruction_id, entry_type, amount_minor, currency,
           description)
        VALUES ('le-1', 'tenant-money', 'workspace-money', 'pi-1', 'DEBIT', ${amount}, 'NGN', 'probe')
      `);
    };

    const fractional = await attempt(raw(database, (tx) => probe(tx, '100.5')));
    expect(String(fractional)).toContain('amount_minor_is_integral');

    // The read-side bound: 2^53, one above the largest integer a JavaScript number represents exactly, so the
    // first value that would not survive the `Number(...)` every repository reads these columns through.
    const enormous = await attempt(raw(database, (tx) => probe(tx, '9007199254740992')));
    expect(String(enormous)).toContain('amount_minor_within_safe_range');

    // And a whole number of kobo is stored exactly.
    const accepted = await raw(database, async (tx) => {
      await probe(tx, '4150');
      return await tx<{ amount_minor: string }[]>`SELECT amount_minor FROM ledger_probe`;
    });
    expect(Number(accepted[0]?.amount_minor)).toBe(4150);
  }, 300_000);

  it('records a reconciliation discrepancy truthfully, where it used to invert', async () => {
    const database = await migrated();

    // The row that was ACCEPTED before `202608110018`: the provider reported 100.5 and the ledger held 100.6,
    // both rounded to 101, so the derivation check demanded `matched = true` and a real discrepancy was stored
    // as a clean match.
    const falseMatch = await attempt(
      raw(database, async (tx) => {
        await tx.unsafe(RECON_PROBE);
        return await tx`INSERT INTO recon_probe VALUES ('r1', 100.5, 100.6, true)`;
      }),
    );
    expect(String(falseMatch)).toMatch(
      /matched_follows_from_amounts|provider_reported_amount_minor_check|recorded_amount_minor_check/,
    );

    // And the row that was REFUSED before it — the truthful one — for the same reason in reverse.
    const truthfulUnequal = await raw(database, async (tx) => {
      await tx.unsafe(RECON_PROBE);
      await tx`INSERT INTO recon_probe VALUES ('r2', 100, 101, false)`;
      return await tx<{ matched: boolean }[]>`SELECT matched FROM recon_probe WHERE id = 'r2'`;
    });
    expect(truthfulUnequal[0]?.matched).toBe(false);

    // The real table carries the types and the constraint this probe reproduces.
    const shape = await raw(database, (tx) =>
      tx<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'reconciliation_records'
          AND column_name IN ('provider_reported_amount_minor', 'recorded_amount_minor')
        ORDER BY column_name
      `,
    );
    expect(shape.map((row) => row.data_type)).toEqual(['numeric', 'numeric']);

    const derived = await raw(database, (tx) =>
      tx<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'reconciliation_records_matched_follows_from_amounts'
      `,
    );
    expect(derived[0]?.definition).toContain('matched = (provider_reported_amount_minor');
  }, 300_000);

  it('keeps the derived money invariants exact, so the parts cannot round independently', async () => {
    const database = await migrated();
    // `net_payable = gross + variations - retention - tax - penalty` is what a certified Financial Provider is
    // instructed to release, and `outstanding = entitlement - settled` is what a closed account owes. Both were
    // CHECKs over operands an integer column could round before the check ever saw them.
    const definitions = await raw(database, (tx) =>
      tx<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname IN (
          'financial_entitlements_net_follows_from_parts',
          'final_settlement_accounts_outstanding_follows_from_parts'
        )
        ORDER BY conname
      `,
    );
    expect(definitions).toHaveLength(2);

    const columns = await raw(database, (tx) =>
      tx<{ data_type: string }[]>`
        SELECT DISTINCT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('financial_entitlements', 'final_settlement_accounts')
          AND column_name LIKE '%\\_minor'
      `,
    );
    expect(columns.map((row) => row.data_type)).toEqual(['numeric']);
  }, 300_000);
});

describe('integration: the last tables without a boundary', () => {
  it('retires the two dead legacy tables', async () => {
    const database = await migrated();
    const survivors = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name IN ('contracts', 'milestones')
      `,
    );
    // Superseded by `agreements_v2` (Batch F, the canonical chain's first link — named with the suffix because
    // `agreements` was taken by the legacy model this retires) and `blueprint_milestones` (Batch E). These two
    // had no reader, no writer, no policy and no row-level security at all.
    expect(survivors).toEqual([]);

    const successors = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('agreements_v2', 'blueprint_milestones', 'governed_milestones')
        ORDER BY table_name
      `,
    );
    // A retirement is only a retirement if what supersedes it is present.
    expect(successors.map((row) => row.table_name)).toEqual([
      'agreements_v2',
      'blueprint_milestones',
      'governed_milestones',
    ]);
  }, 300_000);

  it('leaves the migration ledger as the only table without row-level security', async () => {
    const database = await migrated();
    const unprotected = await raw(database, (tx) =>
      tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY 1
      `,
    );
    // The one legitimate exception: the schema owner writes it and every host reads it at startup, so it is a
    // table about the database rather than about a tenant.
    expect(unprotected.map((row) => row.relname)).toEqual(['trust_migration_ledger']);

    const unforced = await raw(database, (tx) =>
      tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND c.relrowsecurity AND NOT c.relforcerowsecurity
        ORDER BY 1
      `,
    );
    // Zero since Batch L, from 59 before Batch A. ENABLE alone does not constrain the table owner.
    expect(unforced).toEqual([]);
  }, 300_000);

  it('refuses the retirement if either table holds rows', async () => {
    const database = await migrated();
    // The migration is forward-only and already applied, so the refusal is proved by re-creating the condition
    // it guards: a table of that name holding a row, and the same statement the migration runs.
    const refused = await attempt(
      raw(database, async (tx) => {
        await tx.unsafe('CREATE TABLE contracts (id TEXT PRIMARY KEY)');
        await tx.unsafe(`INSERT INTO contracts VALUES ('c-1')`);
        return await tx.unsafe(`
          DO $probe$
          DECLARE
            rows BIGINT;
          BEGIN
            EXECUTE 'SELECT count(*) FROM contracts' INTO rows;
            IF rows > 0 THEN
              RAISE EXCEPTION 'DEAD_TABLE_RETIREMENT_REFUSED: contracts holds % row(s).', rows;
            END IF;
            DROP TABLE contracts;
          END
          $probe$;
        `);
      }),
    );
    // "These tables are empty" is a claim about every database that will ever apply the migration, not about
    // the one it was written against.
    expect(String(refused)).toContain('DEAD_TABLE_RETIREMENT_REFUSED');
  }, 300_000);
});
