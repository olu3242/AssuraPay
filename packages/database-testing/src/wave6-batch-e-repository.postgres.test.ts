import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_E_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_E_AGGREGATES,
  BATCH_E_APPEND_ONLY_COLLECTIONS,
  BATCH_E_CANONICAL_CHAIN_LINKS,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch E persists to its own tables, and the front of the canonical chain becomes
 * durable.
 *
 * The first batch of the sixty-seven `docs/persistence/DURABILITY_GAP_ANALYSIS.md` registers. Three of
 * these six aggregates are canonical chain links, so this suite is where the chain census in
 * `durability-coverage.test.ts` moves from seven of eleven to ten.
 *
 * Two things here that no earlier batch had to prove: that the *generalised* governed-transition
 * trigger honours a concurrency column other than `version` without breaking the thirty-five
 * aggregates that use `version`, and that a domain `version` — the revision a blueprint *is* — is
 * immutable while the row counter beside it advances.
 *
 * Every refusal is exercised through a direct statement as well as, or instead of, the store.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-e';
const OTHER_TENANT = 'tenant-e-other';
const WORKSPACE = 'workspace-e';
const OTHER_WORKSPACE = 'workspace-e-other';
const ACTOR = 'user-planner';

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

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch E table forces row-level security. */
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

function blueprint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bp-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    agreementIntelligenceVersionId: 'aiv-1',
    version: 1,
    status: 'DRAFT',
    createdBy: ACTOR,
    createdAt: stamp,
    contentHash: 'a3f1c9',
    ...overrides,
  };
}

function scopeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'si-1',
    workspaceId: WORKSPACE,
    blueprintId: 'bp-1',
    kind: 'INCLUDED',
    description: 'Foundation works to slab level',
    assumptions: ['Site access from week 1'],
    constraints: ['No weekend working'],
    ownerId: ACTOR,
    status: 'DRAFT',
    createdAt: stamp,
    ...overrides,
  };
}

function deliverable(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dl-1',
    workspaceId: WORKSPACE,
    blueprintId: 'bp-1',
    scopeItemId: 'si-1',
    title: 'Reinforced slab',
    quantity: 2.5,
    unit: 'tonnes',
    qualityStandard: 'BS 8500-1',
    ownerId: ACTOR,
    dueDate: '2026-09-30',
    acceptanceCriteria: ['Cube test at 28 days'],
    evidenceRequirements: ['Laboratory certificate'],
    status: 'DRAFT',
    createdAt: stamp,
    ...overrides,
  };
}

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ms-1',
    workspaceId: WORKSPACE,
    blueprintId: 'bp-1',
    title: 'Slab complete',
    deliverableIds: ['dl-1'],
    startDate: '2026-09-01',
    dueDate: '2026-09-30',
    budgetAmountMinor: 5_000_000,
    currency: 'NGN',
    valueAllocationPercent: 25,
    status: 'SCHEDULED',
    createdAt: stamp,
    ...overrides,
  };
}

function dodPackage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dod-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    version: 1,
    deliverableGateIds: ['dl-1'],
    criteria: [
      {
        key: 'cube-test',
        description: 'Cube test at 28 days',
        mandatory: true,
        evaluationType: 'MANUAL',
      },
    ],
    evidenceRequirements: ['Laboratory certificate'],
    qualityGate: true,
    complianceGate: true,
    riskGate: false,
    paymentGate: true,
    status: 'DRAFT',
    createdBy: ACTOR,
    createdAt: stamp,
    contentHash: 'b7e2d4',
    ...overrides,
  };
}

/** The blueprint plan, through the production store, in foreign-key order. */
async function foundPlan(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    const k = (base: string) => `${base}${suffix}`;
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append(
      'performanceBlueprints',
      blueprint({ id: k('bp-1'), workspaceId, contractId: k('c-1') }),
    );
    await store.append(
      'scopeItems',
      scopeItem({ id: k('si-1'), workspaceId, blueprintId: k('bp-1') }),
    );
    await store.append(
      'deliverables',
      deliverable({
        id: k('dl-1'),
        workspaceId,
        blueprintId: k('bp-1'),
        scopeItemId: k('si-1'),
      }),
    );
    await store.append(
      'blueprintMilestones',
      milestone({
        id: k('ms-1'),
        workspaceId,
        blueprintId: k('bp-1'),
        deliverableIds: [k('dl-1')],
      }),
    );
    await store.append(
      'dodPackages',
      dodPackage({ id: k('dod-1'), workspaceId, milestoneId: k('ms-1'), deliverableGateIds: [k('dl-1')] }),
    );
  });
}

describe('integration: Batch E is activated and repairs the chain', () => {
  it('pairs all six contracts with a relational repository', () => {
    expect(Object.keys(BATCH_E_RELATIONS)).toHaveLength(6);
    expect(BATCH_E_AGGREGATES).toHaveLength(6);
    for (const aggregate of BATCH_E_AGGREGATES) {
      const relation = BATCH_E_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('makes three canonical chain links durable, and requires all six tables', async () => {
    // The reason this batch is first in the register: three chain links for six aggregates of work.
    expect([...BATCH_E_CANONICAL_CHAIN_LINKS].sort()).toEqual([
      'blueprintMilestones',
      'dodPackages',
      'performanceBlueprints',
    ]);
    for (const collection of BATCH_E_CANONICAL_CHAIN_LINKS)
      expect(Object.keys(BATCH_E_RELATIONS), collection).toContain(collection);

    for (const aggregate of BATCH_E_AGGREGATES)
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, aggregate.table).toContain(aggregate.table);
    // Every one of this batch's tables is required, and the required set holds no duplicates. Not a
    // bare total: this suite asserted exactly 41 when it was written, which was the same brittleness it
    // had just corrected in Batch D's suite — and Batch F made it false. A count of the whole registry
    // is a fact about the *next* batch, so it belongs to whichever suite that batch brings with it.
    expect(new Set(REQUIRED_DOMAIN_AGGREGATE_TABLES).size).toBe(
      REQUIRED_DOMAIN_AGGREGATE_TABLES.length,
    );
    expect(REQUIRED_DOMAIN_AGGREGATE_TABLES.length).toBeGreaterThanOrEqual(41);

    const database = await migratedDatabase();
    const compatible = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);
  }, 300_000);

  it('keys every Batch E table as TEXT and forces row-level security', async () => {
    const database = await migratedDatabase();
    const tables = BATCH_E_AGGREGATES.map((aggregate) => aggregate.table);
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
      // All six carried ENABLE without FORCE before this migration.
      expect(flags.forced, table).toBe(true);
    }
  }, 300_000);

  it('refuses the migration when a Batch E table holds rows', async () => {
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const earlier = readMigrations(migrationsDirectory()).filter((entry) => entry.id < '202608110004');
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
    // Through the pre-convergence shape: `workspace_id` is still a UUID into `workspaces`.
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'legacy', 'organization')
    `;
    const [workspace] = await database.sql<{ id: string }[]>`SELECT id FROM workspaces LIMIT 1`;
    await database.sql`
      INSERT INTO performance_blueprints
        (workspace_id, contract_id, contract_version_id, agreement_intelligence_version_id,
         version, status, created_by, content_hash)
      VALUES (${workspace.id}::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              1, 'DRAFT', gen_random_uuid(), 'legacy')
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('WAVE6_BATCH_E_AUTHORITY_REFUSED');
    expect(message).toContain('performance_blueprints=1');
    expect(message).toContain('Nothing has been changed');
  }, 300_000);
});

describe('integration: the domain version and the row counter are different things', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundPlan(database);
  }, 300_000);

  it('round-trips a blueprint exactly, including its revision', async () => {
    const [read] = await as(database, (store) =>
      store.list<Record<string, unknown>>('performanceBlueprints'),
    );
    expect(read).toEqual(blueprint());

    const [row] = await raw(database, (tx) => tx<Record<string, unknown>[]>`
      SELECT version, row_version, schema_version, tenant_id
      FROM performance_blueprints WHERE id = ${'bp-1'}
    `);
    // The revision is 1 because it is the contract's first blueprint; the row counter is also 1
    // because the row has never been updated. They coincide here and diverge below, which is the point.
    expect(row).toEqual({ version: 1, row_version: 1, schema_version: 1, tenant_id: TENANT });
  }, 300_000);

  it('advances the row counter on a transition and leaves the revision alone', async () => {
    await as(database, (store) =>
      store.replace('performanceBlueprints', blueprint({ status: 'ACTIVE' })),
    );
    const [row] = await raw(database, (tx) => tx<{ version: number; row_version: number; status: string }[]>`
      SELECT version, row_version, status FROM performance_blueprints WHERE id = ${'bp-1'}
    `);
    expect(row.status).toBe('ACTIVE');
    expect(row.version).toBe(1);
    expect(row.row_version).toBe(2);
  }, 300_000);

  it('refuses a change to the revision, because a revision is which row this is', async () => {
    const error = await raw(database, (tx) => tx`
      UPDATE performance_blueprints SET version = 2, row_version = row_version + 1
      WHERE id = ${'bp-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
  }, 300_000);

  it('refuses a transition whose row counter does not advance', async () => {
    // The generalised trigger checking `row_version` rather than `version`. Without the
    // `concurrency=` marker it would have checked `version`, which never moves — so every transition
    // would have been refused as a non-advancing write.
    const error = await raw(database, (tx) => tx`
      UPDATE performance_blueprints SET status = 'SUPERSEDED' WHERE id = ${'bp-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
    expect(String(error)).toContain('row_version');
  }, 300_000);

  it('refuses any change once SUPERSEDED, which is terminal', async () => {
    await as(database, (store) =>
      store.replace('performanceBlueprints', blueprint({ status: 'SUPERSEDED' })),
    );
    const error = await as(database, (store) =>
      store
        .replace('performanceBlueprints', blueprint({ status: 'ACTIVE' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
    expect((error as PostgresStoreError).detail ?? '').toContain('AGGREGATE_STATE_IS_TERMINAL');
  }, 300_000);
});

describe('integration: Batch E plan invariants', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundPlan(database);
  }, 300_000);

  it('round-trips a milestone with its money and its calendar dates exact', async () => {
    const [read] = await as(database, (store) =>
      store.list<Record<string, unknown>>('blueprintMilestones'),
    );
    expect(read).toEqual(milestone());

    const [row] = await raw(database, (tx) => tx<Record<string, unknown>[]>`
      SELECT budget_amount_minor::text AS budget, currency,
             start_date::text AS start_date, due_date::text AS due_date
      FROM blueprint_milestones WHERE id = ${'ms-1'}
    `);
    // `bigint` as a string, and the dates as calendar dates rather than instants.
    expect(row).toEqual({
      budget: '5000000',
      currency: 'NGN',
      start_date: '2026-09-01',
      due_date: '2026-09-30',
    });
  }, 300_000);

  it('round-trips a fractional quantity, because a quantity is not an amount', async () => {
    const [read] = await as(database, (store) => store.list<{ quantity: number }>('deliverables'));
    expect(read.quantity).toBe(2.5);
  }, 300_000);

  it('refuses an unsupported currency on a milestone budget', async () => {
    // The governed currency set, outside the settlement batches for the first time.
    const error = await as(database, (store) =>
      store
        .append('blueprintMilestones', milestone({ id: 'ms-eur', currency: 'EUR' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_SCHEMA_VIOLATION');

    const direct = await raw(database, (tx) => tx`
      INSERT INTO blueprint_milestones
        (id, tenant_id, workspace_id, blueprint_id, title, deliverable_ids, start_date, due_date,
         budget_amount_minor, currency, value_allocation_percent, status, created_at,
         row_version, schema_version, updated_at)
      VALUES ('ms-eur', ${TENANT}, ${WORKSPACE}, 'bp-1', 'T', '["dl-1"]'::jsonb, '2026-09-01',
              '2026-09-30', 1000, 'EUR', 10, 'SCHEDULED', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('currency_ck');
  }, 300_000);

  it('refuses a milestone due before it starts, on a direct statement', async () => {
    const error = await raw(database, (tx) => tx`
      INSERT INTO blueprint_milestones
        (id, tenant_id, workspace_id, blueprint_id, title, deliverable_ids, start_date, due_date,
         budget_amount_minor, currency, value_allocation_percent, status, created_at,
         row_version, schema_version, updated_at)
      VALUES ('ms-back', ${TENANT}, ${WORKSPACE}, 'bp-1', 'T', '["dl-1"]'::jsonb, '2026-09-30',
              '2026-09-01', 1000, 'NGN', 10, 'SCHEDULED', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('dates_ordered');
  }, 300_000);

  it('refuses a self-edge and a duplicate edge in the sequence graph', async () => {
    await as(database, async (store) => {
      await store.append(
        'blueprintMilestones',
        milestone({ id: 'ms-2', title: 'Second', valueAllocationPercent: 30 }),
      );
      await store.append('milestoneSequenceEdges', {
        id: 'ed-1',
        workspaceId: WORKSPACE,
        blueprintId: 'bp-1',
        predecessorId: 'ms-1',
        successorId: 'ms-2',
        createdAt: stamp,
      });
    });

    const selfEdge = await raw(database, (tx) => tx`
      INSERT INTO milestone_sequence_edges
        (id, tenant_id, workspace_id, blueprint_id, predecessor_id, successor_id, created_at,
         row_version, schema_version, updated_at)
      VALUES ('ed-self', ${TENANT}, ${WORKSPACE}, 'bp-1', 'ms-1', 'ms-1', ${stamp}, 1, 1, ${stamp})
    `).catch((caught: unknown) => caught);
    expect(String(selfEdge)).toMatch(/check constraint|no_self_edge/);

    const duplicate = await as(database, (store) =>
      store
        .append('milestoneSequenceEdges', {
          id: 'ed-2',
          workspaceId: WORKSPACE,
          blueprintId: 'bp-1',
          predecessorId: 'ms-1',
          successorId: 'ms-2',
          createdAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((duplicate as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('permits one ACTIVE blueprint per contract and refuses a second', async () => {
    // `activate` supersedes every ACTIVE row before activating, so two ACTIVE rows mean the
    // supersession lost a race — and a contract with two active plans has no plan.
    await as(database, (store) =>
      store.replace('performanceBlueprints', blueprint({ status: 'ACTIVE' })),
    );
    const error = await as(database, (store) =>
      store
        .append('performanceBlueprints', blueprint({ id: 'bp-2', version: 2, status: 'ACTIVE' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a second blueprint revision with the same number', async () => {
    const error = await as(database, (store) =>
      store
        .append('performanceBlueprints', blueprint({ id: 'bp-dup', version: 1, status: 'DRAFT' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a second PUBLISHED definition-of-done package for one milestone', async () => {
    await as(database, (store) => store.replace('dodPackages', dodPackage({ status: 'PUBLISHED' })));
    const error = await as(database, (store) =>
      store
        .append('dodPackages', dodPackage({ id: 'dod-2', version: 2, status: 'PUBLISHED' }))
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a child referencing a parent in another tenant', async () => {
    await foundPlan(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
    // `bp-1` exists, but in TENANT. Foreign key checks run as the table owner and are not subject to
    // row-level security, so only the composite key stops this.
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO scope_items
          (id, tenant_id, workspace_id, blueprint_id, kind, description, assumptions, constraints,
           owner_id, status, created_at, row_version, schema_version, updated_at)
        VALUES ('si-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'bp-1', 'INCLUDED', 'reaching',
                '[]'::jsonb, '[]'::jsonb, ${ACTOR}, 'DRAFT', ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/scope_items_blueprint_fk/);
  }, 300_000);

  it('shows another tenant nothing', async () => {
    const seen = await as(
      database,
      (store) => store.list('performanceBlueprints'),
      'tenant-e-empty',
      'workspace-e-empty',
    );
    expect(seen).toEqual([]);
  }, 300_000);
});

describe('integration: Batch E mutation boundaries', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundPlan(database);
  }, 300_000);

  it('permits confirming a scope item and a deliverable', async () => {
    // Both carried a blanket append-only trigger that would have refused these — the fifth instance
    // of that defect.
    await as(database, async (store) => {
      await store.replace('scopeItems', scopeItem({ status: 'CONFIRMED' }));
      await store.replace('deliverables', deliverable({ status: 'CONFIRMED' }));
    });
    const [item] = await as(database, (store) => store.list<{ status: string }>('scopeItems'));
    const [item2] = await as(database, (store) => store.list<{ status: string }>('deliverables'));
    expect(item.status).toBe('CONFIRMED');
    expect(item2.status).toBe('CONFIRMED');
  }, 300_000);

  it('refuses a change to a confirmed scope item, because CONFIRMED is terminal', async () => {
    // Already CONFIRMED by the previous test in this suite. Confirming it again would itself be a
    // post-terminal write, so the attempt under test is the reversal.
    const error = await as(database, (store) =>
      store.replace('scopeItems', scopeItem({ status: 'DRAFT' })).catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
  }, 300_000);

  it('refuses a change to a planned fact, and refuses a DELETE', async () => {
    const immutable = await raw(database, (tx) => tx`
      UPDATE deliverables SET quantity = 99, row_version = row_version + 1 WHERE id = ${'dl-1'}
    `).catch((caught: unknown) => caught);
    expect(String(immutable)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const deleted = await raw(database, (tx) => tx`
      DELETE FROM performance_blueprints WHERE id = ${'bp-1'}
    `).catch((caught: unknown) => caught);
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('keeps milestones and sequence edges append-only, in the store and the database', async () => {
    const appendOnly = Object.values(BATCH_E_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    // Checked against the engines: `BlueprintMilestone.status` declares CANCELLED and nothing writes
    // it, so the aggregate is append-only because of what the engines do.
    expect(appendOnly).toEqual([...BATCH_E_APPEND_ONLY_COLLECTIONS].sort());

    const refused = await as(database, (store) =>
      store
        .replace('blueprintMilestones', milestone({ status: 'CANCELLED' }))
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

    const direct = await raw(database, (tx) => tx`
      UPDATE blueprint_milestones SET title = 'edited by hand' WHERE id = ${'ms-1'}
    `).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('append-only table');
  }, 300_000);
});
