import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_K_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_K_AGGREGATES,
  BATCH_K_APPEND_ONLY_COLLECTIONS,
  BATCH_K_TABLES,
  kpiValueIsOnTrack,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch K persists to its own tables, and two engines start that could not run.
 *
 * The six enterprise-intelligence aggregates of canonical Engines 51-55 — the first of the group the accepted
 * decision deferred "until the persistence boundary is resolved". Batch J resolved it.
 *
 * The test this suite exists for is `records a review of a forecast, which was impossible`. That package's own
 * header states its AI-governance contract: "a forecast can never auto-decide anything — it starts
 * NOT_REVIEWED and a human must explicitly accept or reject it". `202608030008` put a blanket append-only
 * trigger on `execution_forecasts`, so `review()` refused on the durable path and every forecast stayed
 * NOT_REVIEWED forever. The human-in-the-loop step the aggregate exists for was unperformable, and nothing
 * said so because against `InMemoryTrustStore` there is no trigger to refuse it.
 *
 * Every refusal is exercised by direct statement as well as, or instead of, through the store.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-k';
const OTHER_TENANT = 'tenant-k-other';
const WORKSPACE = 'workspace-k';
const OTHER_WORKSPACE = 'workspace-k-other';
const ACTOR = 'user-analyst';

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

/** One database per describe block, seeded once — a database per test exhausts the connection allowance. */
function sharedDatabase(seed?: (database: TestDatabase) => Promise<void>): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () =>
    (pending ??= (async () => {
      const database = await migratedDatabase();
      if (seed) await seed(database);
      return database;
    })());
}

const stamp = '2026-08-18T09:00:00.000Z';

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch K table forces row-level security. */
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

function attempt<T>(work: Promise<T>): Promise<T | unknown> {
  return work.catch((caught: unknown) => caught);
}

const record = {
  executionIndex: (o: Record<string, unknown> = {}) => ({
    id: 'eai-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    factors: { evidence: 80, schedule: 70 },
    mandatoryGates: [{ gate: 'DEFINITION_OF_DONE', passed: true }],
    score: 75,
    overridden: false,
    failedGates: [],
    computedAt: stamp,
    ...o,
  }),
  settlementIndex: (o: Record<string, unknown> = {}) => ({
    id: 'sai-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    factors: { funding: 90, entitlement: 80 },
    activeHold: false,
    score: 85,
    overridden: false,
    computedAt: stamp,
    ...o,
  }),
  definition: (o: Record<string, unknown> = {}) => ({
    id: 'kpi-1',
    workspaceId: WORKSPACE,
    kind: 'EXECUTION',
    name: 'Milestones certified on time',
    targetValue: 90,
    direction: 'HIGHER_IS_BETTER',
    unit: 'percent',
    status: 'ACTIVE',
    createdAt: stamp,
    ...o,
  }),
  value: (o: Record<string, unknown> = {}) => ({
    id: 'kv-1',
    workspaceId: WORKSPACE,
    kpiDefinitionId: 'kpi-1',
    scopeId: 'scope-1',
    actualValue: 95,
    onTrack: true,
    recordedAt: stamp,
    ...o,
  }),
  snapshot: (o: Record<string, unknown> = {}) => ({
    id: 'ds-1',
    workspaceId: WORKSPACE,
    role: 'FINANCE_DIRECTOR',
    widgets: [
      { key: 'net-payable', label: 'Net payable', value: 5_000_000, allowedRoles: ['FINANCE_DIRECTOR'] },
    ],
    generatedFor: ACTOR,
    generatedAt: stamp,
    ...o,
  }),
  forecast: (o: Record<string, unknown> = {}) => ({
    id: 'ef-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    forecastType: 'DELAY',
    modelId: 'deterministic-forecast',
    modelVersion: '1',
    predictedValue: 12,
    confidence: 0.6,
    rationale: 'Deterministic baseline forecast for DELAY derived from 2 signal(s).',
    reviewStatus: 'NOT_REVIEWED',
    generatedAt: stamp,
    ...o,
  }),
};

/** All six, in dependency order — the only intra-set parent is the KPI definition. */
async function foundIntelligence(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('kpiDefinitions', record.definition({ id: k('kpi-1'), workspaceId }));
    await store.append(
      'kpiValues',
      record.value({ id: k('kv-1'), workspaceId, kpiDefinitionId: k('kpi-1') }),
    );
    await store.append(
      'executionAssuranceIndices',
      record.executionIndex({ id: k('eai-1'), workspaceId }),
    );
    await store.append(
      'settlementAssuranceIndices',
      record.settlementIndex({ id: k('sai-1'), workspaceId }),
    );
    await store.append('dashboardSnapshots', record.snapshot({ id: k('ds-1'), workspaceId }));
    await store.append('executionForecasts', record.forecast({ id: k('ef-1'), workspaceId }));
  });
}

describe('integration: Batch K is activated and enterprise intelligence becomes durable', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('pairs all six contracts with a relational repository', () => {
    expect(Object.keys(BATCH_K_RELATIONS).sort()).toEqual(
      BATCH_K_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
    expect(BATCH_K_AGGREGATES).toHaveLength(6);
  });

  it('requires all six tables at startup and routes to them', async () => {
    const database = await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_K_TABLES) {
      expect(required.has(table), table).toBe(true);
      expect(routed.has(table), table).toBe(true);
    }
    const present = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `,
    );
    const names = new Set(present.map((row) => row.table_name));
    for (const table of BATCH_K_TABLES) expect(names.has(table), table).toBe(true);
  }, 300_000);

  it('keys every table as TEXT, forces row-level security, and leaves the superseded functions behind', async () => {
    const database = await seeded();
    const uuid = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${BATCH_K_TABLES as string[]})
          AND data_type = 'uuid'
      `,
    );
    // `scope_id` names an execution scope and `generated_for` a trust principal; a UUID column cannot hold
    // either now the runtime keeps them as TEXT.
    expect(uuid).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${BATCH_K_TABLES as string[]})
      `,
    );
    expect(security).toHaveLength(BATCH_K_TABLES.length);
    for (const row of security) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      // All six had ENABLE without FORCE, which does not constrain the table owner — the defect
      // `persistence.rls-certification` corrected for the trust tables.
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }

    const legacy = await raw(database, (tx) =>
      tx<{ tablename: string }[]>`
        SELECT tablename FROM pg_policies
        WHERE schemaname = current_schema()
          AND tablename = ANY(${BATCH_K_TABLES as string[]})
          AND (qual LIKE '%has_active_workspace_membership%' OR qual LIKE '%current_workspace_id%')
      `,
    );
    // The two functions that kept `workspace_memberships` alive. Every one of these six predicated on both.
    expect(legacy).toEqual([]);
  }, 300_000);

  it('stores and reads back all six aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      executionAssuranceIndices: await store.list('executionAssuranceIndices'),
      settlementAssuranceIndices: await store.list('settlementAssuranceIndices'),
      kpiDefinitions: await store.list('kpiDefinitions'),
      kpiValues: await store.list('kpiValues'),
      dashboardSnapshots: await store.list('dashboardSnapshots'),
      executionForecasts: await store.list('executionForecasts'),
    }));

    // `NUMERIC` columns come back from the driver as strings; the round trip is where that is either parsed
    // or silently returned as text a schema would reject.
    expect(seen.executionAssuranceIndices[0]).toEqual(record.executionIndex());
    expect(seen.settlementAssuranceIndices[0]).toEqual(record.settlementIndex());
    expect(seen.kpiDefinitions[0]).toEqual(record.definition());
    expect(seen.kpiValues[0]).toEqual(record.value());
    expect(seen.dashboardSnapshots[0]).toEqual(record.snapshot());
    expect(seen.executionForecasts[0]).toEqual(record.forecast());
  }, 300_000);
});

describe('integration: the two engines that could not run', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('records a review of a forecast, which was impossible', async () => {
    const database = await seeded();
    // The statement `review()` issues. Before `202608110014` a blanket append-only trigger refused it, so a
    // forecast could never leave NOT_REVIEWED — and this package's stated AI-governance contract is that a
    // forecast decides nothing until a human accepts or rejects it. On the durable store that step could not
    // be performed at all.
    await as(database, (store) =>
      store.replace('executionForecasts', record.forecast({ reviewStatus: 'ACCEPTED' })),
    );
    const [reviewed] = await as(database, (store) =>
      store.list<{ reviewStatus: string }>('executionForecasts'),
    );
    expect(reviewed.reviewStatus).toBe('ACCEPTED');
  }, 300_000);

  it('retires a KPI definition, which was impossible', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.replace('kpiDefinitions', record.definition({ status: 'RETIRED' })),
    );
    const [retired] = await as(database, (store) => store.list<{ status: string }>('kpiDefinitions'));
    expect(retired.status).toBe('RETIRED');
  }, 300_000);

  it('refuses rewriting what a reviewer read in order to decide', async () => {
    const database = await seeded();
    // The review status moves; the forecast does not. A mutable rationale means the record of what was
    // accepted is not the thing that was accepted.
    for (const [column, statement] of [
      ['rationale', `UPDATE execution_forecasts SET rationale = 'revised', row_version = row_version + 1 WHERE id = 'ef-1'`],
      ['confidence', `UPDATE execution_forecasts SET confidence = 0.99, row_version = row_version + 1 WHERE id = 'ef-1'`],
      ['model_id', `UPDATE execution_forecasts SET model_id = 'other-model', row_version = row_version + 1 WHERE id = 'ef-1'`],
      ['predicted_value', `UPDATE execution_forecasts SET predicted_value = 1, row_version = row_version + 1 WHERE id = 'ef-1'`],
    ] as const) {
      const failure = await attempt(raw(database, (tx) => tx.unsafe(statement)));
      expect(String(failure), column).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
      expect(String(failure), column).toContain(column);
    }
  }, 300_000);

  it('refuses moving a KPI target after values were judged against it', async () => {
    const database = await seeded();
    // `recordValue` reads `target_value` and `direction` to compute `on_track`, so a mutable target silently
    // rewrites the meaning of every value already recorded against the definition.
    for (const column of ['target_value', 'direction', 'unit'] as const) {
      const value = column === 'target_value' ? '1' : column === 'direction' ? `'LOWER_IS_BETTER'` : `'ratio'`;
      const failure = await attempt(
        raw(database, (tx) =>
          tx.unsafe(
            `UPDATE kpi_definitions SET ${column} = ${value}, row_version = row_version + 1 WHERE id = 'kpi-1'`,
          ),
        ),
      );
      expect(String(failure), column).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    }
  }, 300_000);

  it('refuses a transition that does not advance the row counter', async () => {
    const database = await seeded();
    // None of these six owns a domain `version`, so `row_version` is the only counter and a transition that
    // leaves it alone is a lost update waiting to happen.
    const failure = await attempt(
      raw(database, (tx) => tx`UPDATE kpi_definitions SET status = 'RETIRED' WHERE id = 'kpi-1'`),
    );
    expect(String(failure)).toContain('row_version');
  }, 300_000);

  it('refuses rewriting or deleting the four that are measurements', async () => {
    const database = await seeded();
    expect([...BATCH_K_APPEND_ONLY_COLLECTIONS]).toHaveLength(4);
    for (const table of [
      'execution_assurance_indices',
      'settlement_assurance_indices',
      'kpi_values',
      'dashboard_snapshots',
    ] as const) {
      const updated = await attempt(
        raw(database, (tx) => tx.unsafe(`UPDATE ${table} SET workspace_id = workspace_id WHERE true`)),
      );
      expect(String(updated), table).toContain('append-only');
      const deleted = await attempt(raw(database, (tx) => tx.unsafe(`DELETE FROM ${table} WHERE true`)));
      // Withholding UPDATE from the runtime role is the other half; the trigger is what an operator who
      // granted it in a hurry still cannot get past.
      expect(String(deleted), table).toContain('append-only');
    }
  }, 300_000);

  it('reports the store’s own refusal for an append-only collection', async () => {
    const database = await seeded();
    for (const collection of [
      'executionAssuranceIndices',
      'settlementAssuranceIndices',
      'kpiValues',
      'dashboardSnapshots',
    ] as const) {
      const refused = (await as(database, (store) =>
        attempt(store.replace(collection, record.executionIndex({ id: 'whatever' }))),
      )) as PostgresStoreError;
      expect(refused.code, collection).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
    }
  }, 300_000);
});

describe('integration: an index cannot contradict its own numbers', () => {
  const seeded = sharedDatabase(foundIntelligence);

  it('refuses a green banner over a failed mandatory gate', async () => {
    const database = await seeded();
    // The row that matters. `compute` sets score 0 and overridden true whenever a gate failed; a high score
    // beside a failed gate is a reading a viewer acts on and should not.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO execution_assurance_indices
             (id, tenant_id, workspace_id, scope_id, factors, mandatory_gates, score, overridden,
              failed_gates, computed_at, row_version, schema_version, updated_at)
           VALUES ('eai-lying', ${TENANT}, ${WORKSPACE}, 'scope-2', '{"evidence":80}'::jsonb,
                   ${tx.json([{ gate: 'DEFINITION_OF_DONE', passed: false }] as never)}, 80, true,
                   ${tx.json(['DEFINITION_OF_DONE'] as never)}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('override_follows_gates');
  }, 300_000);

  it('refuses a failed-gate list that does not match its own gates', async () => {
    const database = await seeded();
    // Understating the failure: a gate that did not pass, absent from `failed_gates`, so `overridden` reads
    // false and the score stands.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO execution_assurance_indices
             (id, tenant_id, workspace_id, scope_id, factors, mandatory_gates, score, overridden,
              failed_gates, computed_at, row_version, schema_version, updated_at)
           VALUES ('eai-quiet', ${TENANT}, ${WORKSPACE}, 'scope-3', '{"evidence":80}'::jsonb,
                   ${tx.json([{ gate: 'EVIDENCE', passed: false }] as never)}, 80, false,
                   '[]'::jsonb, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toMatch(/failed_gates_match|override_follows_gates/);

    // And naming a gate that is not in the list at all.
    const invented = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO execution_assurance_indices
             (id, tenant_id, workspace_id, scope_id, factors, mandatory_gates, score, overridden,
              failed_gates, computed_at, row_version, schema_version, updated_at)
           VALUES ('eai-invented', ${TENANT}, ${WORKSPACE}, 'scope-4', '{"evidence":80}'::jsonb,
                   ${tx.json([{ gate: 'EVIDENCE', passed: true }] as never)}, 0, true,
                   ${tx.json(['SOMETHING_ELSE'] as never)}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(invented)).toContain('failed_gates_match');
  }, 300_000);

  it('refuses a healthy settlement index under an active hold', async () => {
    const database = await seeded();
    // An active hold is CLAUDE.md's second hard constraint holding. An index reading 85 beside it shows the
    // constraint satisfied when it is not, on the read model an executive dashboard reports.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO settlement_assurance_indices
             (id, tenant_id, workspace_id, scope_id, factors, active_hold, score, overridden, computed_at,
              row_version, schema_version, updated_at)
           VALUES ('sai-lying', ${TENANT}, ${WORKSPACE}, 'scope-2', '{"funding":90}'::jsonb, true, 85,
                   true, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('override_follows_hold');
  }, 300_000);

  it('refuses an index that measured nothing', async () => {
    const database = await seeded();
    // `averageOf` returns 0 for an empty set, so an index with no factors scores zero and shows the worst
    // possible reading as though something had been measured.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO settlement_assurance_indices
             (id, tenant_id, workspace_id, scope_id, factors, active_hold, score, overridden, computed_at,
              row_version, schema_version, updated_at)
           VALUES ('sai-empty', ${TENANT}, ${WORKSPACE}, 'scope-5', '{}'::jsonb, false, 0, false,
                   ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('scores_something');
  }, 300_000);

  it('refuses a snapshot holding a widget its role may not see', async () => {
    const database = await seeded();
    // `compose` filters widgets to the role's allow-list. A stored widget outside it is a figure the viewer
    // was never entitled to, materialised where it can be read without passing the filter again — and the
    // widget in this batch's own fixture is a payable amount.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO dashboard_snapshots
             (id, tenant_id, workspace_id, role, widgets, generated_for, generated_at, row_version,
              schema_version, updated_at)
           VALUES ('ds-leak', ${TENANT}, ${WORKSPACE}, 'SITE_ENGINEER',
                   ${tx.json([
                     { key: 'payroll', label: 'Payroll', value: 9_000_000, allowedRoles: ['CHIEF_EXECUTIVE'] },
                   ] as never)},
                   ${ACTOR}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('widgets_visible_to_role');
  }, 300_000);

  it('refuses a widget list that is not an array at all', async () => {
    const database = await seeded();
    // The predicate opens with a CASE on `jsonb_typeof` rather than relying on `AND` to short-circuit, so a
    // scalar produces a refusal naming the rule rather than an internal error from `jsonb_array_length`.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO dashboard_snapshots
             (id, tenant_id, workspace_id, role, widgets, generated_for, generated_at, row_version,
              schema_version, updated_at)
           VALUES ('ds-scalar', ${TENANT}, ${WORKSPACE}, 'FINANCE_DIRECTOR', '"none"'::jsonb,
                   ${ACTOR}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('widgets_visible_to_role');
    expect(String(failure)).not.toContain('cannot get array length');
  }, 300_000);

  it('refuses a forecast that cannot say what produced it', async () => {
    const database = await seeded();
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO execution_forecasts
             (id, tenant_id, workspace_id, scope_id, forecast_type, model_id, model_version,
              predicted_value, confidence, rationale, review_status, generated_at, row_version,
              schema_version, updated_at)
           VALUES ('ef-anon', ${TENANT}, ${WORKSPACE}, 'scope-2', 'DELAY', '   ', '1', 12, 0.6,
                   'Some rationale', 'NOT_REVIEWED', ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('model_is_attributed');
  }, 300_000);

  it('keeps the on-track rule with the engine, because no row can check it', async () => {
    const database = await seeded();
    // The one derived field the database cannot express: the target lives on the parent, and PostgreSQL
    // forbids a subquery in a CHECK. So this asserts the shared comparison against what was actually stored,
    // which is the strongest check available without putting the authority in the weaker place.
    const [definition] = await as(database, (store) =>
      store.list<{ direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER'; targetValue: number }>(
        'kpiDefinitions',
      ),
    );
    const values = await as(database, (store) =>
      store.list<{ kpiDefinitionId: string; actualValue: number; onTrack: boolean }>('kpiValues'),
    );
    for (const value of values) {
      expect(value.onTrack, `${value.actualValue} against ${definition.targetValue}`).toBe(
        kpiValueIsOnTrack(definition, value.actualValue),
      );
    }
  }, 300_000);
});

describe('integration: Batch K tenancy and the keys the batch adds', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundIntelligence(database);
    await foundIntelligence(database, OTHER_TENANT, OTHER_WORKSPACE, '-o');
  });

  it('shows another tenant only its own readings', async () => {
    const database = await seeded();
    const mine = await as(database, (store) => store.list<{ id: string }>('executionForecasts'));
    expect(mine.map((row) => row.id)).toEqual(['ef-1']);
    const theirs = await as(
      database,
      (store) => store.list<{ id: string }>('executionForecasts'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(theirs.map((row) => row.id)).toEqual(['ef-1-o']);
  }, 300_000);

  it('refuses a second ACTIVE definition of the same KPI', async () => {
    const database = await seeded();
    // `define` refuses a blank name but not a duplicate one, and `retire` reads then writes — so two
    // concurrent `define` calls for the same KPI both succeed today, after which every dashboard reporting
    // that KPI has two definitions with different targets and nothing to say which is meant.
    const failure = await attempt(
      as(database, (store) => store.append('kpiDefinitions', record.definition({ id: 'kpi-dup' }))),
    );
    expect(String(failure)).toContain('kpi_definitions_one_active_per_name');
  }, 300_000);

  it('frees the name once the definition is retired', async () => {
    const database = await seeded();
    // Partial on `status = 'ACTIVE'`, so retiring a KPI releases its name rather than holding it forever.
    await as(database, (store) =>
      store.replace('kpiDefinitions', record.definition({ status: 'RETIRED' })),
    );
    await as(database, (store) => store.append('kpiDefinitions', record.definition({ id: 'kpi-2' })));
    const definitions = await as(database, (store) =>
      store.list<{ id: string; status: string }>('kpiDefinitions'),
    );
    expect(definitions.map((row) => `${row.id}:${row.status}`).sort()).toEqual([
      'kpi-1:RETIRED',
      'kpi-2:ACTIVE',
    ]);
  }, 300_000);

  it('lets two tenants name the same KPI, which a global key would have prevented', async () => {
    const database = await seeded();
    // Both seeds define `Milestones certified on time`. The key is scoped, so one tenant cannot hold a KPI
    // name against every other tenant on the deployment — the denial of service `202608110010` removed six of.
    const mine = await as(database, (store) => store.list<{ name: string }>('kpiDefinitions'));
    const theirs = await as(
      database,
      (store) => store.list<{ name: string }>('kpiDefinitions'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(mine[0].name).toBe('Milestones certified on time');
    expect(theirs[0].name).toBe('Milestones certified on time');
  }, 300_000);

  it('refuses a value referencing a definition in another tenant', async () => {
    const database = await seeded();
    // The composite `(tenant_id, workspace_id, id)` key is what makes this a foreign-key failure rather than
    // a row another tenant can reach: `kpi-1-o` exists, in the other tenant.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO kpi_values
             (id, tenant_id, workspace_id, kpi_definition_id, scope_id, actual_value, on_track,
              recorded_at, row_version, schema_version, updated_at)
           VALUES ('kv-cross', ${TENANT}, ${WORKSPACE}, 'kpi-1-o', 'scope-1', 95, true, ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('kpi_values_definition_fk');
  }, 300_000);
});
