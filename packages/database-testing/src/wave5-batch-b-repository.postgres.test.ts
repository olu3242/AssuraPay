import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_B_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_B_AGGREGATES,
  BATCH_B_CONVERGED_NOT_ACTIVATED,
  BATCH_B_TABLES,
  SUPPORTED_CURRENCIES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch B persists to its own tables, and the database enforces the monetary
 * invariants.
 *
 * Batch B is the first batch carrying money, so these suites prove what
 * `docs/finance/MONETARY_INVARIANTS.md` requires *of the database*: integer minor units, a governed
 * currency, non-negative deductions, currency agreement between an aggregate and its claim,
 * cross-tenant reference refusal, and segregation of duties. Each of those was previously enforced
 * only in TypeScript, or not at all, and the accepted decision is explicit that an invariant
 * PostgreSQL can enforce must not exist only as an application check.
 *
 * Every refusal below is exercised through a *direct statement* as well as, or instead of, the
 * store — because the point of moving an invariant into the database is that it holds for a caller
 * the application does not mediate.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-b';
const OTHER_TENANT = 'tenant-b-other';
const WORKSPACE = 'workspace-b';
const OTHER_WORKSPACE = 'workspace-b-other';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';

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

async function foundTenancy(database: TestDatabase): Promise<void> {
  const store = new PostgresTrustStore(database.sql);
  for (const [tenantId, workspaceId] of [
    [TENANT, WORKSPACE],
    [OTHER_TENANT, OTHER_WORKSPACE],
  ]) {
    await withTrustScope({ tenantId, workspaceId, actorId: REQUESTER }, async () => {
      await store.append('trustWorkspaces', {
        id: workspaceId,
        tenantId,
        status: 'ACTIVE',
        version: 1,
      });
    });
  }
}

/** Work inside a tenant scope through the production store. */
function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: REQUESTER }, () => work(store));
}

/**
 * Raw SQL under a tenant scope.
 *
 * Every Batch B table forces row-level security, so an unscoped verification query reads nothing —
 * correct, and not a useful assertion. A refusal proved by a direct statement has to be proved from
 * inside a scope, exactly as the application runs.
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

const stamp = '2026-08-10T09:00:00.000Z';

function eligibility(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pe-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    completionCertificateId: 'cert-1',
    paymentTriggerRuleId: 'ptr-1',
    eligible: true,
    blockers: [],
    evaluatedBy: REQUESTER,
    evaluatedAt: stamp,
    ...overrides,
  };
}

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fe-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    paymentEligibilityId: 'pe-1',
    currency: 'NGN',
    grossEarnedAmountMinor: 1_000_000,
    variationsAmountMinor: 0,
    retentionAmountMinor: 50_000,
    taxAmountMinor: 25_000,
    penaltyAmountMinor: 0,
    netPayableAmountMinor: 925_000,
    status: 'DRAFT',
    calculatedAt: stamp,
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    financialEntitlementId: 'fe-1',
    invoiceNumber: 'INV-000001',
    amountMinor: 925_000,
    currency: 'NGN',
    status: 'SUBMITTED',
    submittedBy: REQUESTER,
    createdAt: stamp,
    ...overrides,
  };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auth-1',
    workspaceId: WORKSPACE,
    releaseRequestId: 'rr-1',
    requestedBy: REQUESTER,
    amountMinor: 925_000,
    currency: 'NGN',
    requiredApprovals: 2,
    status: 'PENDING',
    createdAt: stamp,
    ...overrides,
  };
}

/** A fund reservation and its commitment, written directly: Batch C owns them, so no repository does. */
async function seedReservation(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<string> {
  await raw(
    database,
    async (tx) => {
      await tx`
        INSERT INTO funding_commitments
          (id, tenant_id, workspace_id, milestone_id, provider_key, external_custody_reference,
           committed_amount_minor, currency, status, created_at, version, schema_version, updated_at)
        VALUES (${`fc${suffix}`}, ${tenantId}, ${workspaceId}, 'ms-1', 'provider-x', 'custody-1',
                2000000, 'NGN', 'CONFIRMED', ${stamp}, 1, 1, ${stamp})
      `;
      await tx`
        INSERT INTO fund_reservations
          (id, tenant_id, workspace_id, funding_commitment_id, invoice_id, reserved_amount_minor,
           status, created_at, version, schema_version, updated_at)
        VALUES (${`fr${suffix}`}, ${tenantId}, ${workspaceId}, ${`fc${suffix}`}, ${`inv-1${suffix}`},
                925000, 'RESERVED', ${stamp}, 1, 1, ${stamp})
      `;
    },
    tenantId,
    workspaceId,
  );
  return `fr${suffix}`;
}

describe('integration: Batch B is activated, and its closure is converged but not', () => {
  it('pairs all seven contracts with a relational repository', () => {
    expect(Object.keys(BATCH_B_RELATIONS)).toHaveLength(7);
    expect(BATCH_B_AGGREGATES).toHaveLength(7);
    for (const aggregate of BATCH_B_AGGREGATES) {
      const relation = BATCH_B_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('requires the seven activated tables, and claims neither of the two it merely converged', async () => {
    // The distinction is the whole reason the migration could proceed: Batch B's foreign-key
    // closure includes two Batch C tables, so all nine had to be converted together, and requiring
    // a table the store never reads would make readiness assert something it does not depend on.
    for (const table of BATCH_B_AGGREGATES.map((a) => a.table))
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, table).toContain(table);
    expect([...BATCH_B_CONVERGED_NOT_ACTIVATED].sort()).toEqual([
      'fund_reservations',
      'funding_commitments',
    ]);
    // Asserted against `BATCH_B_TABLES`, not against the union. Batch C has since activated these
    // two, so they *are* required now — by their own batch, which owns them. The durable claim is
    // that Batch B never claimed them, and that stays true as later batches land.
    for (const table of BATCH_B_CONVERGED_NOT_ACTIVATED)
      expect(BATCH_B_TABLES, table).not.toContain(table);

    const database = await migratedDatabase();
    const compatible = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);

    await database.sql.unsafe('DROP TABLE release_requests CASCADE');
    const degraded = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(degraded.missingTables).toEqual(['release_requests']);
    expect(degraded.compatible).toBe(false);
  }, 300_000);

  it('routes no collection to a converged-but-not-activated table', async () => {
    const routed = Object.values(BATCH_B_RELATIONS).map((relation) => relation.table);
    for (const table of BATCH_B_CONVERGED_NOT_ACTIVATED)
      expect(routed, table).not.toContain(table);
  });

  it('keys every table in the closure as TEXT and forces row-level security', async () => {
    const database = await migratedDatabase();
    const closure = [
      ...BATCH_B_AGGREGATES.map((a) => a.table),
      ...BATCH_B_CONVERGED_NOT_ACTIVATED,
    ];
    const uuid = await database.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${closure}) AND data_type = 'uuid'
    `;
    expect(uuid).toEqual([]);

    for (const table of closure) {
      const [flags] = await database.sql<{ enabled: boolean; forced: boolean }[]>`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
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
  }, 300_000);

  it('refuses the migration when a table in the closure holds rows', async () => {
    // The safety argument for converting nine identity columns in place. A populated table makes it
    // a data migration, and this one refuses rather than performing one.
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const earlier = readMigrations(migrationsDirectory()).filter(
      (entry) => entry.id < '202608100002',
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
    // Seeded through the *pre-convergence* shape: workspace_id is still a UUID into `workspaces`.
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'legacy', 'organization')
    `;
    const [workspace] = await database.sql<{ id: string }[]>`SELECT id FROM workspaces LIMIT 1`;
    await database.sql`
      INSERT INTO payment_eligibilities
        (workspace_id, milestone_id, completion_certificate_id, payment_trigger_rule_id, eligible,
         blockers, evaluated_by)
      VALUES (${workspace.id}::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), true,
              '[]'::jsonb, gen_random_uuid())
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('WAVE5_BATCH_B_AUTHORITY_REFUSED');
    expect(message).toContain('payment_eligibilities=1');
    expect(message).toContain('Nothing has been changed');
  }, 300_000);
});

describe('integration: Batch B money round-trips exactly', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
  }, 300_000);

  it('round-trips an entitlement through columns, with bigint amounts as exact numbers', async () => {
    await as(database, async (store) => {
      await store.append('paymentEligibilities', eligibility());
      await store.append('financialEntitlements', entitlement());
    });

    const [read] = await as(database, (store) =>
      store.list<Record<string, unknown>>('financialEntitlements'),
    );
    expect(read).toEqual(entitlement());

    // `bigint` arrives from the driver as a string, so the read is a conversion. Asserted against
    // the columns, not only through the store, so a rounding bug in the reader is visible.
    const [row] = await raw(database, (tx) => tx<Record<string, unknown>[]>`
      SELECT gross_earned_amount_minor::text AS gross, net_payable_amount_minor::text AS net,
             currency, tenant_id, version, schema_version
      FROM financial_entitlements WHERE id = ${'fe-1'}
    `);
    expect(row).toEqual({
      gross: '1000000',
      net: '925000',
      currency: 'NGN',
      tenant_id: TENANT,
      version: 1,
      schema_version: 1,
    });
  }, 300_000);

  it('preserves a negative variation and the exact net it produces', async () => {
    await as(database, async (store) => {
      await store.append('paymentEligibilities', eligibility({ id: 'pe-var' }));
      await store.append(
        'financialEntitlements',
        entitlement({
          id: 'fe-var',
          paymentEligibilityId: 'pe-var',
          variationsAmountMinor: -100_000,
          netPayableAmountMinor: 825_000,
        }),
      );
    });
    const records = await as(database, (store) =>
      store.list<{ id: string; variationsAmountMinor: number; netPayableAmountMinor: number }>(
        'financialEntitlements',
      ),
    );
    const found = records.find((r) => r.id === 'fe-var');
    expect(found?.variationsAmountMinor).toBe(-100_000);
    expect(found?.netPayableAmountMinor).toBe(825_000);
  }, 300_000);

  it('takes the tenant from the ambient scope and refuses an unscoped write', async () => {
    const [row] = await raw(database, (tx) => tx<{ tenant_id: string }[]>`
      SELECT tenant_id FROM financial_entitlements WHERE id = ${'fe-1'}
    `);
    expect(row.tenant_id).toBe(TENANT);
    expect(Object.keys(entitlement())).not.toContain('tenantId');

    const store = new PostgresTrustStore(database.sql);
    const error = await store
      .append('paymentEligibilities', eligibility({ id: 'pe-unscoped' }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgresStoreError);
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_SCOPE_INVALID');
  }, 300_000);

  it('shows another tenant nothing', async () => {
    const seen = await as(
      database,
      (store) => store.list('financialEntitlements'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(seen).toEqual([]);
  }, 300_000);
});

describe('integration: the database enforces the monetary invariants', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
    await as(database, async (store) => {
      await store.append('paymentEligibilities', eligibility());
      await store.append('financialEntitlements', entitlement());
    });
  }, 300_000);

  it('names NGN and USD as the governed set, and the column agrees', async () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(['NGN', 'USD']);
    const [check] = await database.sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'financial_entitlements_currency_ck'
    `;
    for (const code of SUPPORTED_CURRENCIES) expect(check.def).toContain(code);
  }, 300_000);

  it('refuses an unsupported currency on a direct statement', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO financial_entitlements
        (id, tenant_id, workspace_id, milestone_id, payment_eligibility_id, currency,
         gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
         tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status, calculated_at,
         version, schema_version, updated_at)
      VALUES ('fe-eur', ${TENANT}, ${WORKSPACE}, 'ms-1', 'pe-1', 'EUR',
              1000, 0, 0, 0, 0, 1000, 'DRAFT', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/currency_ck/);
  }, 300_000);

  it('refuses a negative deduction on a direct statement', async () => {
    for (const column of ['retention_amount_minor', 'tax_amount_minor', 'penalty_amount_minor']) {
      const error = await raw(database, (tx) => tx.unsafe(`
        INSERT INTO financial_entitlements
          (id, tenant_id, workspace_id, milestone_id, payment_eligibility_id, currency,
           gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
           tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status, calculated_at,
           version, schema_version, updated_at)
        VALUES ('fe-neg-${column}', '${TENANT}', '${WORKSPACE}', 'ms-1', 'pe-1', 'NGN',
                1000, 0, 0, 0, 0, 1000, 'DRAFT', '${stamp}', 1, 1, '${stamp}')
      `).then(() => tx.unsafe(`
        UPDATE financial_entitlements SET ${column} = -1 WHERE id = 'fe-neg-${column}'
      `))).catch((caught: unknown) => caught);
      // Either the non-negativity check or the immutability trigger refuses it. Both are correct
      // refusals of the same statement, and asserting on one specifically would be asserting on
      // trigger ordering rather than on the invariant.
      expect(String(error), column).toMatch(/non_negative|AGGREGATE_FACT_IS_IMMUTABLE/);
    }
  }, 300_000);

  it('refuses a net payable that does not follow from its parts', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO financial_entitlements
        (id, tenant_id, workspace_id, milestone_id, payment_eligibility_id, currency,
         gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
         tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status, calculated_at,
         version, schema_version, updated_at)
      VALUES ('fe-bad-math', ${TENANT}, ${WORKSPACE}, 'ms-1', 'pe-1', 'NGN',
              1000, 0, 100, 0, 0, 1000, 'DRAFT', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('net_follows_from_parts');
  }, 300_000);

  it('refuses an invoice whose currency disagrees with its entitlement', async () => {
    // A composite foreign key, not a check: currency agreement is a property of two rows.
    // MONETARY_INVARIANTS — amounts in different currencies are never combined without an
    // explicit governed conversion event, and an invoice claiming in another currency is that case.
    const error = await as(database, (store) =>
      store
        .append('invoices', invoice({ id: 'inv-usd', currency: 'USD' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_SCOPE_INVALID');
    expect((error as PostgresStoreError).detail ?? '').toMatch(/entitlement_currency_fk/);
  }, 300_000);

  it('accepts an invoice that agrees on currency', async () => {
    await as(database, async (store) => {
      await store.append('invoices', invoice());
    });
    const [stored] = await as(database, (store) =>
      store.list<{ id: string; amountMinor: number; currency: string }>('invoices'),
    );
    expect(stored.id).toBe('inv-1');
    expect(stored.amountMinor).toBe(925_000);
    expect(stored.currency).toBe('NGN');
  }, 300_000);

  it('refuses a child row referencing a parent in another tenant', async () => {
    // The hole row-level security cannot close: foreign key checks run as the table owner and are
    // not subject to RLS, so a single-column key would have admitted this while the policy hid the
    // parent from the caller.
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO financial_entitlements
          (id, tenant_id, workspace_id, milestone_id, payment_eligibility_id, currency,
           gross_earned_amount_minor, variations_amount_minor, retention_amount_minor,
           tax_amount_minor, penalty_amount_minor, net_payable_amount_minor, status, calculated_at,
           version, schema_version, updated_at)
        VALUES ('fe-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'ms-1', 'pe-1', 'NGN',
                1000, 0, 0, 0, 0, 1000, 'DRAFT', ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    // `pe-1` exists, but in TENANT. The composite key requires the tenant to match.
    expect(String(error)).toMatch(/eligibility_fk/);
  }, 300_000);

  it('scopes invoice numbers per tenant and workspace rather than globally', async () => {
    // Was UNIQUE (workspace_id, invoice_number), which predates tenancy. Now a *partial* unique index
    // rather than a constraint, because the rule carries a predicate — see the next test.
    const [def] = await database.sql<{ d: string }[]>`
      SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'invoices_live_number_unique'
    `;
    expect(def.d).toContain('(tenant_id, workspace_id, invoice_number)');
    expect(def.d).toContain("WHERE (status <> 'REJECTED'::text)");
    // And the unconditional constraint it replaced is gone rather than sitting alongside it, which
    // would make the predicate unreachable.
    const [old] = await database.sql<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conname = 'invoices_workspace_number_unique'
    `;
    expect(Number(old.n)).toBe(0);

    const error = await as(database, (store) =>
      store.append('invoices', invoice({ id: 'inv-dup' })).catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('lets a rejected invoice number be reused, because that is how a claim is corrected', async () => {
    // The defect `202608110006` closes, found in review of the merged Batch B. `InvoiceClaimEngine.submit`
    // excludes REJECTED rows when checking for a duplicate, deliberately: rejecting an invoice is how a
    // claim is sent back for correction, and the corrected claim carries the *same* number, because that
    // number is the counterparty's document reference and not a surrogate key.
    //
    // The unconditional constraint refused that resubmission, so the durable path could reject an
    // invoice and then refuse to accept its correction — leaving a confirmed entitlement with no route
    // to an invoice at all. Batch B's own suite submitted and rejected separately and never resubmitted,
    // which is why every gate passed.
    await as(database, async (store) => {
      await store.append('invoices', invoice({ id: 'inv-reject', invoiceNumber: 'INV-000009' }));
      await store.replace(
        'invoices',
        invoice({ id: 'inv-reject', invoiceNumber: 'INV-000009', status: 'REJECTED' }),
      );
      // The correction, under the same counterparty reference.
      await store.append('invoices', invoice({ id: 'inv-corrected', invoiceNumber: 'INV-000009' }));
    });

    const live = await raw(database, (tx) =>
      tx<{ id: string; status: string }[]>`
        SELECT id, status FROM invoices WHERE invoice_number = 'INV-000009' ORDER BY id`,
    );
    expect(live).toEqual([
      { id: 'inv-corrected', status: 'SUBMITTED' },
      { id: 'inv-reject', status: 'REJECTED' },
    ]);

    // Still one *live* invoice per number: the predicate narrows the key, it does not remove it.
    const second = await as(database, (store) =>
      store
        .append('invoices', invoice({ id: 'inv-third', invoiceNumber: 'INV-000009' }))
        .catch((caught: unknown) => caught),
    );
    expect((second as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);
});

describe('integration: the database enforces segregation of duties', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
    await as(database, async (store) => {
      await store.append('paymentEligibilities', eligibility());
      await store.append('financialEntitlements', entitlement());
      await store.append('invoices', invoice());
    });
    // After the invoice, not before: `fund_reservations_invoice_fk` is composite on
    // (tenant_id, invoice_id), so a reservation seeded first has nothing to point at.
    const reservation = await seedReservation(database);
    await as(database, async (store) => {
      await store.append('releaseRequests', {
        id: 'rr-1',
        workspaceId: WORKSPACE,
        milestoneId: 'ms-1',
        financialEntitlementId: 'fe-1',
        invoiceId: 'inv-1',
        fundReservationId: reservation,
        releaseType: 'FULL',
        requestedAmountMinor: 925_000,
        currency: 'NGN',
        status: 'DRAFT',
        blockers: [],
        requestedBy: REQUESTER,
        createdAt: stamp,
      });
      await store.append('authorizationDecisions', authorization());
    });
  }, 300_000);

  it('accepts an approval from someone other than the requester', async () => {
    await as(database, async (store) => {
      await store.append('financialApprovalDecisions', {
        id: 'fad-1',
        workspaceId: WORKSPACE,
        authorizationId: 'auth-1',
        approverId: APPROVER,
        decision: 'APPROVE',
        rationale: 'Entitlement and invoice reconcile',
        decidedAt: stamp,
      });
    });
    const stored = await as(database, (store) =>
      store.list<{ id: string; approverId: string }>('financialApprovalDecisions'),
    );
    expect(stored.map((s) => s.approverId)).toEqual([APPROVER]);
  }, 300_000);

  it('refuses a self-approval, on a direct statement the application never mediated', async () => {
    // The engine raises SEGREGATION_OF_DUTIES_VIOLATION; that refusal lives in TypeScript and a
    // console session evades it. This one is the trigger.
    const error = await raw(database, (tx) => tx`
      INSERT INTO financial_approval_decisions
        (id, tenant_id, workspace_id, authorization_id, approver_id, decision, rationale,
         decided_at, version, schema_version, updated_at)
      VALUES ('fad-self', ${TENANT}, ${WORKSPACE}, 'auth-1', ${REQUESTER}, 'APPROVE',
              'approving my own request', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('SEGREGATION_OF_DUTIES_VIOLATION');
  }, 300_000);

  it('refuses the same approver twice on one authorization', async () => {
    const error = await as(database, (store) =>
      store
        .append('financialApprovalDecisions', {
          id: 'fad-dup',
          workspaceId: WORKSPACE,
          authorizationId: 'auth-1',
          approverId: APPROVER,
          decision: 'APPROVE',
          rationale: 'Approving again',
          decidedAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses an approval against an authorization in another tenant', async () => {
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO financial_approval_decisions
          (id, tenant_id, workspace_id, authorization_id, approver_id, decision, rationale,
           decided_at, version, schema_version, updated_at)
        VALUES ('fad-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'auth-1', ${APPROVER}, 'APPROVE',
                'reaching across tenants', ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    // Either the composite key or the segregation trigger's own not-found guard refuses it; both
    // are correct, and both prove the authorization is unreachable from the other tenant.
    expect(String(error)).toMatch(/authorization_fk|APPROVAL_AUTHORIZATION_NOT_FOUND/);
  }, 300_000);
});

describe('integration: Batch B mutation boundaries', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
    await as(database, async (store) => {
      await store.append('paymentEligibilities', eligibility());
      await store.append('financialEntitlements', entitlement());
    });
  }, 300_000);

  it('permits the confirmation its canonical engine performs', async () => {
    // The blanket append-only trigger would have refused this — the same defect corrected for
    // Batch A, in the three Batch B tables that carried one and are transitioned.
    await as(database, async (store) => {
      await store.replace('financialEntitlements', entitlement({ status: 'CONFIRMED' }));
    });
    const [read] = await as(database, (store) =>
      store.list<{ status: string }>('financialEntitlements'),
    );
    expect(read.status).toBe('CONFIRMED');
    const [row] = await raw(database, (tx) => tx<{ version: number }[]>`
      SELECT version FROM financial_entitlements WHERE id = ${'fe-1'}
    `);
    expect(row.version).toBe(2);
  }, 300_000);

  it('refuses any change once CONFIRMED, which is terminal', async () => {
    const error = await as(database, (store) =>
      store
        .replace('financialEntitlements', entitlement({ status: 'DRAFT' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
    expect((error as PostgresStoreError).detail ?? '').toContain('AGGREGATE_STATE_IS_TERMINAL');
  }, 300_000);

  it('refuses a change to a calculated amount, and refuses a DELETE', async () => {
    const immutable = await raw(database, (tx) => tx`
      UPDATE financial_entitlements
      SET gross_earned_amount_minor = 9999999, version = version + 1 WHERE id = ${'fe-1'}
    `).catch((caught: unknown) => caught);
    expect(String(immutable)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const deleted = await raw(database, (tx) => tx`
      DELETE FROM financial_entitlements WHERE id = ${'fe-1'}
    `).catch((caught: unknown) => caught);
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('keeps the three untransitioned aggregates append-only, in the store and the database', async () => {
    const appendOnly = Object.values(BATCH_B_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    expect(appendOnly).toEqual([
      'approvalThresholds',
      'financialApprovalDecisions',
      'paymentEligibilities',
    ]);

    const refused = await as(database, (store) =>
      store
        .replace('paymentEligibilities', eligibility({ eligible: false }))
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

    const byDatabase = await raw(database, (tx) => tx`
      UPDATE payment_eligibilities SET eligible = false WHERE id = ${'pe-1'}
    `).catch((caught: unknown) => caught);
    expect(String(byDatabase)).toContain('append-only table');
  }, 300_000);
});
