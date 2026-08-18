import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_C_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_B_CONVERGED_NOT_ACTIVATED,
  BATCH_C_AGGREGATES,
  BATCH_C_APPEND_ONLY_COLLECTIONS,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch C persists to its own tables, and the database enforces double entry.
 *
 * Batch C is where money moves, so this suite proves what `docs/finance/MONETARY_INVARIANTS.md`
 * requires *of the database* at its strongest: a journal that balances per currency, posted facts
 * that cannot be edited, reconciliation uniqueness, tenant-scoped idempotency, settlement arithmetic
 * and a retry path that survives.
 *
 * The balance proof is the reason this file exists. It is the one invariant in the whole programme
 * that no schema and no repository can express — it is a property of a *set* of postings — so it is
 * enforced by a deferred constraint trigger and can only be proved against a real database with a
 * real COMMIT. Each refusal below is exercised through a direct statement as well as, or instead of,
 * the store, because the point of moving an invariant into PostgreSQL is that it holds for a caller
 * the application never mediated.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-c';
const OTHER_TENANT = 'tenant-c-other';
const WORKSPACE = 'workspace-c';
const OTHER_WORKSPACE = 'workspace-c-other';
const ACTOR = 'user-treasury';

const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

const stamp = '2026-08-11T09:00:00.000Z';

/** Work inside a tenant scope through the production store. */
function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/**
 * Raw SQL under a tenant scope.
 *
 * Every Batch C table forces row-level security, so an unscoped verification query reads nothing —
 * correct, and not a useful assertion.
 */
function raw<T>(
  database: TestDatabase,
  work: (tx: SqlClient) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  return database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return await work(tx);
  });
}

/**
 * The Batch A/B chain a Batch C aggregate hangs from, written through the production store.
 *
 * Long because the foreign keys are real: a payment instruction references a release request, which
 * references an invoice and an entitlement, which reference an eligibility. Every link is a
 * tenant-composite key this migration or its predecessor added, so none of it can be skipped.
 */
async function foundSettlementChain(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    // `id` alone is still the primary key — tenancy adds `UNIQUE (tenant_id, id)` on top, which
    // makes cross-tenant references impossible but does not partition the key space. So a second
    // tenant's chain needs its own ids rather than the same ones.
    const k = (base: string) => `${base}${suffix}`;
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('paymentEligibilities', {
      id: k('pe-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      completionCertificateId: k('cert-1'),
      paymentTriggerRuleId: k('ptr-1'),
      eligible: true,
      blockers: [],
      evaluatedBy: ACTOR,
      evaluatedAt: stamp,
    });
    await store.append('financialEntitlements', {
      id: k('fe-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      paymentEligibilityId: k('pe-1'),
      currency: 'NGN',
      grossEarnedAmountMinor: 1_000_000,
      variationsAmountMinor: 0,
      retentionAmountMinor: 50_000,
      taxAmountMinor: 25_000,
      penaltyAmountMinor: 0,
      netPayableAmountMinor: 925_000,
      status: 'DRAFT',
      calculatedAt: stamp,
    });
    await store.append('invoices', {
      id: k('inv-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      financialEntitlementId: k('fe-1'),
      invoiceNumber: k('INV-000001'),
      amountMinor: 925_000,
      currency: 'NGN',
      status: 'SUBMITTED',
      submittedBy: ACTOR,
      createdAt: stamp,
    });
    // Batch C's own aggregates now, through their new repositories.
    await store.append('fundingCommitments', {
      id: k('fc-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      providerKey: 'partner-bank',
      externalCustodyReference: k('CUSTODY-99001'),
      committedAmountMinor: 2_000_000,
      currency: 'NGN',
      status: 'PENDING_CONFIRMATION',
      createdAt: stamp,
    });
    await store.append('fundReservations', {
      id: k('fr-1'),
      workspaceId,
      fundingCommitmentId: k('fc-1'),
      invoiceId: k('inv-1'),
      reservedAmountMinor: 925_000,
      status: 'RESERVED',
      createdAt: stamp,
    });
    await store.append('releaseRequests', {
      id: k('rr-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      financialEntitlementId: k('fe-1'),
      invoiceId: k('inv-1'),
      fundReservationId: k('fr-1'),
      releaseType: 'FULL',
      requestedAmountMinor: 925_000,
      currency: 'NGN',
      status: 'DRAFT',
      blockers: [],
      requestedBy: ACTOR,
      createdAt: stamp,
    });
  });
}

function instruction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi-1',
    workspaceId: WORKSPACE,
    releaseRequestId: 'rr-1',
    providerKey: 'partner-bank',
    idempotencyKey: 'idem-0001',
    payloadDigest: 'digest-pi-1',
    beneficiaryReference: 'BENEF-77',
    amountMinor: 925_000,
    currency: 'NGN',
    status: 'DRAFT',
    attempts: 0,
    createdAt: stamp,
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fsa-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    totalEntitlementAmountMinor: 1_000_000,
    totalSettledAmountMinor: 400_000,
    outstandingAmountMinor: 600_000,
    currency: 'NGN',
    status: 'DRAFT',
    createdAt: stamp,
    ...overrides,
  };
}

/** One leg of a journal. Balanced pairs are built from two of these. */
function leg(id: string, entryType: 'DEBIT' | 'CREDIT', overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE,
    paymentInstructionId: 'pi-1',
    entryType,
    amountMinor: 925_000,
    currency: 'NGN',
    description: entryType === 'DEBIT' ? 'escrow release' : 'beneficiary settlement',
    recordedAt: stamp,
    ...overrides,
  };
}

describe('integration: Batch C activates the seven, including the two Batch B converged', () => {
  it('pairs all seven contracts with a relational repository', () => {
    expect(Object.keys(BATCH_C_RELATIONS)).toHaveLength(7);
    expect(BATCH_C_AGGREGATES).toHaveLength(7);
    for (const aggregate of BATCH_C_AGGREGATES) {
      const relation = BATCH_C_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('finally requires the two tables Batch B converged and would not activate', async () => {
    // The other half of "converging a table is not activating it". Batch B named these two and
    // deliberately kept them out of readiness because nothing routed to them. Now something does.
    for (const table of BATCH_B_CONVERGED_NOT_ACTIVATED)
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, table).toContain(table);
    for (const aggregate of BATCH_C_AGGREGATES)
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, aggregate.table).toContain(aggregate.table);

    const routed = Object.values(BATCH_C_RELATIONS).map((relation) => relation.table);
    for (const table of BATCH_B_CONVERGED_NOT_ACTIVATED) expect(routed, table).toContain(table);

    const database = await migratedDatabase();
    const compatible = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);

    await database.sql.unsafe('DROP TABLE ledger_entries CASCADE');
    const degraded = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(degraded.missingTables).toEqual(['ledger_entries']);
    expect(degraded.compatible).toBe(false);
  }, 300_000);

  it('keys every Batch C table as TEXT, forces row-level security, and defers the balance check', async () => {
    const database = await migratedDatabase();
    const tables = BATCH_C_AGGREGATES.map((aggregate) => aggregate.table);
    const uuid = await database.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${tables}) AND data_type = 'uuid'
    `;
    expect(uuid).toEqual([]);

    for (const table of tables) {
      const [flags] = await database.sql<{ forced: boolean }[]>`
        SELECT c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}
      `;
      expect(flags.forced, table).toBe(true);

      const policies = await database.sql<{ qual: string; with_check: string }[]>`
        SELECT qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `;
      expect(policies, table).toHaveLength(1);
      for (const clause of [policies[0].qual, policies[0].with_check]) {
        expect(clause, table).toContain('trust_current_tenant()');
        expect(clause, table).toContain('trust_current_workspace()');
      }
    }

    // Deferred, and initially deferred. Either flag missing and the trigger would fire between the
    // legs, refusing the first half of every correct posting.
    const [balance] = await database.sql<{ deferrable: boolean; deferred: boolean }[]>`
      SELECT tgdeferrable AS deferrable, tginitdeferred AS deferred
      FROM pg_trigger WHERE tgname = 'ledger_entries_journal_balance'
    `;
    expect(balance.deferrable).toBe(true);
    expect(balance.deferred).toBe(true);
  }, 300_000);

  it('refuses the migration when an activated table holds rows', async () => {
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const earlier = readMigrations(migrationsDirectory()).filter((entry) => entry.id < '202608110001');
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
    // Seeded through the *pre-convergence* shape: `final_settlement_accounts.workspace_id` is still
    // a UUID into `workspaces` at this point in history.
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'legacy', 'organization')
    `;
    const [workspace] = await database.sql<{ id: string }[]>`SELECT id FROM workspaces LIMIT 1`;
    await database.sql`
      INSERT INTO final_settlement_accounts
        (workspace_id, milestone_id, total_entitlement_amount_minor, total_settled_amount_minor,
         outstanding_amount_minor, currency, status)
      VALUES (${workspace.id}::uuid, gen_random_uuid(), 1000, 0, 1000, 'NGN', 'DRAFT')
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('WAVE5_BATCH_C_AUTHORITY_REFUSED');
    expect(message).toContain('final_settlement_accounts=1');
    expect(message).toContain('Nothing has been changed');
  }, 300_000);
});

describe('integration: the database enforces double entry', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundSettlementChain(database);
    await as(database, (store) => store.append('paymentInstructions', instruction()));
  }, 300_000);

  it('accepts a balanced journal written leg by leg in one transaction', async () => {
    // The mechanism working as designed: the state after the debit is unbalanced and permitted,
    // because the constraint is deferred to COMMIT.
    await as(database, (store) =>
      store.transaction(async (tx) => {
        await tx.append('ledgerEntries', leg('le-d1', 'DEBIT'));
        await tx.append('ledgerEntries', leg('le-c1', 'CREDIT'));
      }),
    );
    const entries = await as(database, (store) =>
      store.list<{ id: string; entryType: string; amountMinor: number }>('ledgerEntries'),
    );
    expect(entries.map((entry) => entry.entryType).sort()).toEqual(['CREDIT', 'DEBIT']);
    expect(entries.every((entry) => entry.amountMinor === 925_000)).toBe(true);
  }, 300_000);

  it('refuses a lone debit at commit, through the store', async () => {
    const error = await as(database, (store) =>
      store
        .transaction(async (tx) => {
          await tx.append('ledgerEntries', leg('le-lonely', 'DEBIT', { amountMinor: 1_000 }));
        })
        .catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(PostgresStoreError);
    // Its own code, not PERSISTENCE_TRANSACTION_FAILED: an unbalanced posting is not an outage and
    // retrying it can never succeed.
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_LEDGER_UNBALANCED');
    expect((error as PostgresStoreError).detail ?? '').toContain('LEDGER_JOURNAL_DOES_NOT_BALANCE');
  }, 300_000);

  it('refuses a lone debit on a direct statement the application never mediated', async () => {
    // The reason this is a trigger rather than a posting procedure. A console session gets the same
    // refusal as the store.
    const error = await raw(database, (tx) => tx`
      INSERT INTO ledger_entries
        (id, tenant_id, workspace_id, payment_instruction_id, entry_type, amount_minor, currency,
         description, recorded_at, version, schema_version, updated_at)
      VALUES ('le-direct', ${TENANT}, ${WORKSPACE}, 'pi-1', 'DEBIT', 500, 'NGN',
              'unbalanced by hand', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('LEDGER_JOURNAL_DOES_NOT_BALANCE');
  }, 300_000);

  it('refuses a pair whose legs disagree on amount', async () => {
    const error = await as(database, (store) =>
      store
        .transaction(async (tx) => {
          await tx.append('ledgerEntries', leg('le-d2', 'DEBIT', { amountMinor: 700 }));
          await tx.append('ledgerEntries', leg('le-c2', 'CREDIT', { amountMinor: 300 }));
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_LEDGER_UNBALANCED');
  }, 300_000);

  it('balances per currency, so a debit in one currency is not answered by a credit in another', async () => {
    // MONETARY_INVARIANTS: a journal balances independently per currency, and amounts in different
    // currencies are never combined without a governed conversion. Here the cross-currency credit
    // is refused before the balance check even runs — the composite key requires the posting's
    // currency to match its instruction's.
    const error = await as(database, (store) =>
      store
        .transaction(async (tx) => {
          await tx.append('ledgerEntries', leg('le-d3', 'DEBIT', { amountMinor: 400 }));
          await tx.append(
            'ledgerEntries',
            leg('le-c3', 'CREDIT', { amountMinor: 400, currency: 'USD' }),
          );
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).detail ?? '').toMatch(
      /instruction_currency_fk|LEDGER_JOURNAL_DOES_NOT_BALANCE/,
    );
  }, 300_000);

  it('keeps a later posting balanced against the running journal', async () => {
    // A reversal is a compensating posting, never a negated original. A second balanced pair leaves
    // the running total balanced; a single leg does not, even though the journal already balanced.
    await as(database, (store) =>
      store.transaction(async (tx) => {
        await tx.append('ledgerEntries', leg('le-d4', 'DEBIT', { amountMinor: 100 }));
        await tx.append('ledgerEntries', leg('le-c4', 'CREDIT', { amountMinor: 100 }));
      }),
    );
    const error = await as(database, (store) =>
      store
        .transaction(async (tx) => {
          await tx.append('ledgerEntries', leg('le-d5', 'DEBIT', { amountMinor: 100 }));
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_LEDGER_UNBALANCED');
  }, 300_000);

  it('refuses a negative or zero posting rather than storing a signed amount', async () => {
    for (const amountMinor of [-100, 0]) {
      const error = await as(database, (store) =>
        store
          .append('ledgerEntries', leg('le-signed', 'DEBIT', { amountMinor }))
          .catch((caught: unknown) => caught),
      );
      expect((error as PostgresStoreError).code, String(amountMinor)).toBe(
        'PERSISTENCE_SCHEMA_VIOLATION',
      );
    }
  }, 300_000);
});

describe('integration: Batch C money and settlement invariants', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundSettlementChain(database);
    await as(database, (store) => store.append('paymentInstructions', instruction()));
  }, 300_000);

  it('round-trips an instruction exactly, with bigint amounts as exact numbers', async () => {
    const [read] = await as(database, (store) =>
      store.list<Record<string, unknown>>('paymentInstructions'),
    );
    expect(read).toEqual(instruction());

    const [row] = await raw(database, (tx) => tx<Record<string, unknown>[]>`
      SELECT amount_minor::text AS amount, attempts, currency, tenant_id, version, schema_version
      FROM payment_instructions WHERE id = ${'pi-1'}
    `);
    expect(row).toEqual({
      amount: '925000',
      attempts: 0,
      currency: 'NGN',
      tenant_id: TENANT,
      version: 1,
      schema_version: 1,
    });
  }, 300_000);

  it('refuses an instruction whose currency disagrees with its release request', async () => {
    const error = await as(database, (store) =>
      store
        .append('paymentInstructions', instruction({ id: 'pi-usd', idempotencyKey: 'idem-usd', currency: 'USD' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).detail ?? '').toMatch(/release_request_currency_fk/);
  }, 300_000);

  it('refuses an instruction naming a release request that does not exist', async () => {
    // The foreign key this migration added, which did not exist at all: a money-movement record
    // could name an authority that was never granted.
    const error = await as(database, (store) =>
      store
        .append(
          'paymentInstructions',
          instruction({ id: 'pi-ghost', idempotencyKey: 'idem-ghost', releaseRequestId: 'rr-absent' }),
        )
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).detail ?? '').toMatch(/release_request_currency_fk/);
  }, 300_000);

  it('scopes idempotency per tenant and workspace, matching the engine rule', async () => {
    const [def] = await database.sql<{ d: string }[]>`
      SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conname = 'payment_instructions_idempotency_unique'
    `;
    // Not widened to include provider_key: `PaymentExecutionEngine.issue` deduplicates on the key
    // regardless of provider, and a looser constraint would admit what the engine prevents.
    expect(def.d).toBe('UNIQUE (tenant_id, workspace_id, idempotency_key)');

    const error = await as(database, (store) =>
      store
        .append('paymentInstructions', instruction({ id: 'pi-dup' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a reconciliation whose outcome its own amounts contradict', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO reconciliation_records
        (id, tenant_id, workspace_id, payment_instruction_id, provider_statement_reference,
         currency, provider_reported_amount_minor, recorded_amount_minor, matched, reconciled_at,
         version, schema_version, updated_at)
      VALUES ('rec-lie', ${TENANT}, ${WORKSPACE}, 'pi-1', 'stmt-lie', 'NGN', 900000, 925000, true,
              ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('matched_follows_from_amounts');
  }, 300_000);

  it('carries currency in the reconciliation key, closing the gap Batch C recorded', async () => {
    // `202608110003`. Two money amounts with no unit was the gap; the key can now express that a
    // reconciliation and the payment it reconciles agree on currency.
    //
    // `202608110008` then added `workspace_id`, so the key carries three scopes and the currency. The
    // currency clause is what this test is about and is asserted on its own, rather than by matching the
    // whole column list, so that a later scope addition does not read as this gap reopening.
    const [def] = await database.sql<{ d: string }[]>`
      SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conname = 'reconciliation_records_instruction_currency_fk'
    `;
    expect(def.d).toContain('payment_instruction_id, currency)');
    expect(def.d).toContain('(tenant_id, workspace_id,');
  }, 300_000);

  it('reconciles a statement once per instruction and refuses the second', async () => {
    const record = {
      id: 'rec-1',
      workspaceId: WORKSPACE,
      paymentInstructionId: 'pi-1',
      providerStatementReference: 'stmt-2026-08',
      currency: 'NGN',
      providerReportedAmountMinor: 925_000,
      recordedAmountMinor: 925_000,
      matched: true,
      reconciledAt: stamp,
    };
    await as(database, (store) => store.append('reconciliationRecords', record));
    const error = await as(database, (store) =>
      store
        .append('reconciliationRecords', { ...record, id: 'rec-2' })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses settlement arithmetic that does not follow from its parts', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO final_settlement_accounts
        (id, tenant_id, workspace_id, milestone_id, total_entitlement_amount_minor,
         total_settled_amount_minor, outstanding_amount_minor, currency, status, created_at,
         version, schema_version, updated_at)
      VALUES ('fsa-bad', ${TENANT}, ${WORKSPACE}, 'ms-1', 1000000, 400000, 700000, 'NGN', 'DRAFT',
              ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('outstanding_follows_from_parts');
  }, 300_000);

  it('refuses a closure with no time it happened', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO final_settlement_accounts
        (id, tenant_id, workspace_id, milestone_id, total_entitlement_amount_minor,
         total_settled_amount_minor, outstanding_amount_minor, currency, status, created_at,
         version, schema_version, updated_at)
      VALUES ('fsa-untimed', ${TENANT}, ${WORKSPACE}, 'ms-1', 1000, 1000, 0, 'NGN', 'CLOSED',
              ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('closed_at_follows_status');
  }, 300_000);

  it('refuses a closed account that still owes something', async () => {
    // `close()` refuses an outstanding balance, and until `202608110007` that rule was only in the
    // engine. The arithmetic check alone does not catch this: entitlement 1000, settled 400,
    // outstanding 600 is internally consistent and still not a closure.
    const error = await raw(database, (tx) => tx`
      INSERT INTO final_settlement_accounts
        (id, tenant_id, workspace_id, milestone_id, total_entitlement_amount_minor,
         total_settled_amount_minor, outstanding_amount_minor, currency, status, closed_at, created_at,
         version, schema_version, updated_at)
      VALUES ('fsa-owing', ${TENANT}, ${WORKSPACE}, 'ms-1', 1000, 400, 600, 'NGN', 'CLOSED',
              ${stamp}, ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('closed_owes_nothing');
  }, 300_000);

  it('refuses a closure certificate for an account that is not closed', async () => {
    await raw(database, (tx) => tx`
      INSERT INTO final_settlement_accounts
        (id, tenant_id, workspace_id, milestone_id, total_entitlement_amount_minor,
         total_settled_amount_minor, outstanding_amount_minor, currency, status, created_at,
         version, schema_version, updated_at)
      VALUES ('fsa-draft', ${TENANT}, ${WORKSPACE}, 'ms-1', 1000, 0, 1000, 'NGN', 'DRAFT',
              ${stamp}, 1, 1, ${stamp})
    `);

    // `issueCertificate()` checks the status and nothing else, so a certificate written around the
    // engine was previously accepted and then indistinguishable from a true one. The foreign key now
    // carries the required status, so the account has to actually be closed.
    const error = await raw(database, (tx) => tx`
      INSERT INTO financial_closure_certificates
        (id, tenant_id, workspace_id, milestone_id, final_settlement_account_id, canonical_hash,
         status, issued_by, issued_at, version, schema_version, updated_at)
      VALUES ('fcc-draft', ${TENANT}, ${WORKSPACE}, 'ms-1', 'fsa-draft', 'c4d5e6', 'ISSUED',
              ${ACTOR}, ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('closed_account_fk');
  }, 300_000);

  it('issues one closure certificate per account and refuses a concurrent second', async () => {
    await as(database, async (store) => {
      // Closed, and settled in full. `202608110007` made the certificate's key demand a CLOSED account,
      // so the DRAFT fixture this test used to open with is no longer a state a certificate can exist
      // against — which is the constraint working, not a fixture inconvenience. What the test is about is
      // unchanged: one ISSUED certificate per account.
      await store.append(
        'finalSettlementAccounts',
        account({
          totalSettledAmountMinor: 1_000_000,
          outstandingAmountMinor: 0,
          status: 'CLOSED',
          closedAt: stamp,
        }),
      );
      await store.append('financialClosureCertificates', {
        id: 'fcc-1',
        workspaceId: WORKSPACE,
        milestoneId: 'ms-1',
        finalSettlementAccountId: 'fsa-1',
        canonicalHash: 'a3f1c9',
        status: 'ISSUED',
        issuedBy: ACTOR,
        issuedAt: stamp,
      });
    });
    // The engine counts ISSUED rows before issuing, which two concurrent requests both pass. The
    // partial unique index is what actually prevents the second.
    const error = await as(database, (store) =>
      store
        .append('financialClosureCertificates', {
          id: 'fcc-2',
          workspaceId: WORKSPACE,
          milestoneId: 'ms-1',
          finalSettlementAccountId: 'fsa-1',
          canonicalHash: 'b7e2d4',
          status: 'ISSUED',
          issuedBy: ACTOR,
          issuedAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a child row referencing a parent in another tenant', async () => {
    await foundSettlementChain(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
    // `pi-1` exists, but in TENANT. Foreign key checks run as the table owner and are not subject to
    // row-level security, so only the composite key closes this.
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO reconciliation_records
          (id, tenant_id, workspace_id, payment_instruction_id, provider_statement_reference,
           currency, provider_reported_amount_minor, recorded_amount_minor, matched, reconciled_at,
           version, schema_version, updated_at)
        VALUES ('rec-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'pi-1', 'stmt-cross', 'NGN', 1, 1,
                true, ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/reconciliation_records_instruction_currency_fk/);
  }, 300_000);

  it('refuses a child row referencing a parent in another workspace of the same tenant', async () => {
    // The gap `202608110008` closes, and the one the cross-tenant test above could not catch. Same
    // tenant, so the tenant half of the old composite key agreed; different workspace, which the key did
    // not mention. RLS does not close it either — the child row's own `workspace_id` is the caller's, so
    // the policy is satisfied — and `LedgerPostingEngine.post` never loads the instruction, so nothing
    // in the application compares the two.
    const SECOND_WORKSPACE = 'workspace-c-second';
    await foundSettlementChain(database, TENANT, SECOND_WORKSPACE, '-second');
    // `foundSettlementChain` stops at the release request, so the second workspace needs its own
    // instruction for the intra-workspace half of this test to have a legitimate parent to reference.
    await as(
      database,
      (store) =>
        store.append(
          'paymentInstructions',
          instruction({
            id: 'pi-1-second',
            workspaceId: SECOND_WORKSPACE,
            releaseRequestId: 'rr-1-second',
            idempotencyKey: 'idem-second',
            payloadDigest: 'digest-pi-1-second',
          }),
        ),
      TENANT,
      SECOND_WORKSPACE,
    );

    // `pi-1` exists in this tenant, in WORKSPACE. The reference is refused for naming a parent this
    // workspace cannot see rather than for the row not existing, which is the distinction that matters:
    // accepted, it would have produced a ledger entry in one workspace citing an instruction in another.
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO reconciliation_records
          (id, tenant_id, workspace_id, payment_instruction_id, provider_statement_reference,
           currency, provider_reported_amount_minor, recorded_amount_minor, matched, reconciled_at,
           version, schema_version, updated_at)
        VALUES ('rec-cross-ws', ${TENANT}, ${SECOND_WORKSPACE}, 'pi-1', 'stmt-cross-ws', 'NGN', 1, 1,
                true, ${stamp}, 1, 1, ${stamp})
      `,
      TENANT,
      SECOND_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/reconciliation_records_instruction_currency_fk/);

    // And the same reference within one workspace still works, so the constraint narrowed the key
    // rather than breaking the relationship.
    await raw(
      database,
      (tx) => tx`
        INSERT INTO reconciliation_records
          (id, tenant_id, workspace_id, payment_instruction_id, provider_statement_reference,
           currency, provider_reported_amount_minor, recorded_amount_minor, matched, reconciled_at,
           version, schema_version, updated_at)
        VALUES ('rec-same-ws', ${TENANT}, ${SECOND_WORKSPACE}, 'pi-1-second', 'stmt-same-ws', 'NGN', 1,
                1, true, ${stamp}, 1, 1, ${stamp})
      `,
      TENANT,
      SECOND_WORKSPACE,
    );
  }, 300_000);

  it('shows another tenant nothing', async () => {
    const seen = await as(
      database,
      (store) => store.list('paymentInstructions'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(seen).toEqual([]);
  }, 300_000);
});

describe('integration: Batch C mutation boundaries', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundSettlementChain(database);
    await as(database, (store) => store.append('paymentInstructions', instruction()));
  }, 300_000);

  it('permits the retry path, because FAILED is not terminal', async () => {
    // The defect this batch nearly repeated in reverse. `submit` accepts DRAFT *or* FAILED, so a
    // provider rejection must not close the instruction — naming FAILED terminal would have made
    // every retry impossible, and nothing would have shown it until a payment was rejected.
    await as(database, (store) =>
      store.replace('paymentInstructions', instruction({ status: 'FAILED', attempts: 1 })),
    );
    await as(database, (store) =>
      store.replace(
        'paymentInstructions',
        instruction({ status: 'SUBMITTED', attempts: 2, providerReference: 'PROV-1', submittedAt: stamp }),
      ),
    );
    const [read] = await as(database, (store) =>
      store.list<{ status: string; attempts: number }>('paymentInstructions'),
    );
    expect(read.status).toBe('SUBMITTED');
    expect(read.attempts).toBe(2);
  }, 300_000);

  it('refuses any change once REVERSED, which is terminal', async () => {
    await as(database, (store) =>
      store.replace(
        'paymentInstructions',
        instruction({ status: 'SETTLED', attempts: 2, providerReference: 'PROV-1', submittedAt: stamp, settledAt: stamp }),
      ),
    );
    await as(database, (store) =>
      store.replace(
        'paymentInstructions',
        instruction({ status: 'REVERSED', attempts: 2, providerReference: 'PROV-1', submittedAt: stamp, settledAt: stamp }),
      ),
    );
    const error = await as(database, (store) =>
      store
        .replace('paymentInstructions', instruction({ status: 'SETTLED', attempts: 3 }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
    expect((error as PostgresStoreError).detail ?? '').toContain('AGGREGATE_STATE_IS_TERMINAL');
  }, 300_000);

  it('refuses a change to an instructed amount, and refuses a DELETE', async () => {
    const immutable = await raw(database, (tx) => tx`
      UPDATE payment_instructions SET amount_minor = 9999999, version = version + 1
      WHERE id = ${'pi-1'}
    `).catch((caught: unknown) => caught);
    expect(String(immutable)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const deleted = await raw(database, (tx) => tx`
      DELETE FROM payment_instructions WHERE id = ${'pi-1'}
    `).catch((caught: unknown) => caught);
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('keeps the journal and its reconciliations append-only, in the store and the database', async () => {
    const appendOnly = Object.values(BATCH_C_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    expect(appendOnly).toEqual([...BATCH_C_APPEND_ONLY_COLLECTIONS].sort());

    await as(database, (store) =>
      store.transaction(async (tx) => {
        await tx.append('ledgerEntries', leg('le-ap-d', 'DEBIT', { amountMinor: 50 }));
        await tx.append('ledgerEntries', leg('le-ap-c', 'CREDIT', { amountMinor: 50 }));
      }),
    );

    const refused = await as(database, (store) =>
      store
        .replace('ledgerEntries', leg('le-ap-d', 'DEBIT', { amountMinor: 60 }))
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

    // And in the database, for a caller the store never mediated. A posted amount that can be
    // edited is a journal that cannot be trusted, and a balanced journal could be silently unbalanced
    // by an UPDATE the deferred trigger never sees — it fires on INSERT.
    const direct = await raw(database, (tx) => tx`
      UPDATE ledger_entries SET amount_minor = 60 WHERE id = ${'le-ap-d'}
    `).catch((caught: unknown) => caught);
    // `prevent_append_only_mutation` is the historical per-engine function, and it raises
    // 'append-only table' rather than the trust store's own prefix. `translate` maps both to
    // PERSISTENCE_HISTORY_IMMUTABLE; the message asserted here is the one this trigger actually
    // raises.
    expect(String(direct)).toContain('append-only table');
  }, 300_000);

  it('permits confirming a funding commitment, which Batch B converged but never wrote', async () => {
    await as(database, (store) =>
      store.replace('fundingCommitments', {
        id: 'fc-1',
        workspaceId: WORKSPACE,
        milestoneId: 'ms-1',
        providerKey: 'partner-bank',
        externalCustodyReference: 'CUSTODY-99001',
        committedAmountMinor: 2_000_000,
        currency: 'NGN',
        status: 'CONFIRMED',
        providerConfirmationReference: 'CONF-1',
        createdAt: stamp,
        confirmedAt: stamp,
      }),
    );
    const [read] = await as(database, (store) =>
      store.list<{ status: string; providerConfirmationReference?: string }>('fundingCommitments'),
    );
    expect(read.status).toBe('CONFIRMED');
    expect(read.providerConfirmationReference).toBe('CONF-1');

    // The external custody reference is immutable. Non-custody rests on it naming the provider's own
    // record, so a writer that could repoint it could relabel whose funds these are.
    const error = await raw(database, (tx) => tx`
      UPDATE funding_commitments SET external_custody_reference = 'CUSTODY-OTHER',
        version = version + 1 WHERE id = ${'fc-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
  }, 300_000);
});
