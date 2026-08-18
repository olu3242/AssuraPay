import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_L_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_L_AGGREGATES,
  BATCH_L_APPEND_ONLY_COLLECTIONS,
  BATCH_L_TABLES,
  scorecardOverallScore,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch L persists to its own tables, and the platform's AI governance becomes performable.
 *
 * The nine enterprise-analytics aggregates of canonical Engines 56-60, and the last batch in the durability
 * register. `202608110016` retires `workspaces`, `workspace_memberships` and `user_identities` behind it,
 * which this suite also proves.
 *
 * The test this suite exists for is `performs every AI-governance decision that could not be recorded`. Four
 * of the nine aggregates are transitioned and every one of them was broken — three refused by a blanket
 * append-only trigger from `202608030009`, and `drift_alerts` protected by nothing at all. So a financial
 * forecast could not be reviewed, a model the platform had itself flagged as drifting could not be
 * deprecated, an AI recommendation could not be accepted or dismissed, and the drift alert recording the
 * failure could be edited or deleted by anyone.
 *
 * None of that is checkable against `InMemoryTrustStore`: there is no trigger to refuse the statement and no
 * boundary whose absence to notice.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-l';
const OTHER_TENANT = 'tenant-l-other';
const WORKSPACE = 'workspace-l';
const OTHER_WORKSPACE = 'workspace-l-other';
const ACTOR = 'user-model-owner';

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
const later = '2026-08-18T11:00:00.000Z';

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch L table forces row-level security. */
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
  registration: (o: Record<string, unknown> = {}) => ({
    id: 'mr-1',
    workspaceId: WORKSPACE,
    modelId: 'deterministic-financial-forecast',
    modelVersion: '1',
    purpose: 'Forecast payment failure risk on release requests',
    governedBy: 'model-governance-committee',
    status: 'ACTIVE',
    registeredAt: stamp,
    ...o,
  }),
  evaluation: (o: Record<string, unknown> = {}) => ({
    id: 'er-1',
    workspaceId: WORKSPACE,
    modelRegistrationId: 'mr-1',
    metric: 'precision',
    score: 0.82,
    threshold: 0.75,
    passed: true,
    evaluatedAt: stamp,
    ...o,
  }),
  alert: (o: Record<string, unknown> = {}) => ({
    id: 'da-1',
    workspaceId: WORKSPACE,
    modelRegistrationId: 'mr-1',
    description: 'Evaluation for metric "precision" scored 0.4, below threshold 0.75',
    severity: 'HIGH',
    status: 'OPEN',
    raisedAt: stamp,
    ...o,
  }),
  feedback: (o: Record<string, unknown> = {}) => ({
    id: 'mf-1',
    workspaceId: WORKSPACE,
    modelRegistrationId: 'mr-1',
    outputReference: 'ff-1',
    rating: 'NEGATIVE',
    comment: 'Predicted a payment failure that did not occur; funding cleared on time.',
    submittedBy: ACTOR,
    submittedAt: stamp,
    ...o,
  }),
  recommendation: (o: Record<string, unknown> = {}) => ({
    id: 'rc-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    modelRegistrationId: 'mr-1',
    recommendation: 'Hold the release pending reconciliation of the funding confirmation',
    confidence: 0.7,
    status: 'PENDING',
    createdAt: stamp,
    ...o,
  }),
  forecast: (o: Record<string, unknown> = {}) => ({
    id: 'ff-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    forecastType: 'PAYMENT_FAILURE',
    modelId: 'deterministic-financial-forecast',
    modelVersion: '1',
    predictedValue: 40,
    confidence: 0.6,
    rationale: 'Deterministic baseline forecast for PAYMENT_FAILURE derived from 2 signal(s).',
    reviewStatus: 'NOT_REVIEWED',
    generatedAt: stamp,
    ...o,
  }),
  scorecard: (o: Record<string, unknown> = {}) => ({
    id: 'ps-1',
    workspaceId: WORKSPACE,
    partyId: 'party-1',
    partyRole: 'VENDOR',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    metrics: { delivery: 80, quality: 70 },
    overallScore: 75,
    computedAt: stamp,
    ...o,
  }),
  snapshot: (o: Record<string, unknown> = {}) => ({
    id: 'pf-1',
    workspaceId: WORKSPACE,
    scopeId: 'scope-1',
    atRiskCount: 2,
    blockedCount: 1,
    unpaidAmountMinor: 5_000_000,
    disputedCount: 0,
    retainedAmountMinor: 250_000,
    concentrationTopPartyPercent: 35,
    currency: 'NGN',
    computedAt: stamp,
    ...o,
  }),
  assessment: (o: Record<string, unknown> = {}) => ({
    id: 'ra-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    renewalReadinessScore: 72,
    performanceHistorySummary: 'Two milestones certified late, no disputes.',
    recommendedAction: 'RENEGOTIATE',
    rationale: 'Delivery slipped twice; commercial terms should reflect the observed cadence.',
    assessedBy: ACTOR,
    assessedAt: stamp,
    ...o,
  }),
};

/** All nine, in dependency order — `modelRegistrations` is the hub for four of them. */
async function foundAnalytics(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('modelRegistrations', record.registration({ id: k('mr-1'), workspaceId }));
    await store.append(
      'evaluationRecords',
      record.evaluation({ id: k('er-1'), workspaceId, modelRegistrationId: k('mr-1') }),
    );
    await store.append(
      'driftAlerts',
      record.alert({ id: k('da-1'), workspaceId, modelRegistrationId: k('mr-1') }),
    );
    await store.append(
      'modelFeedback',
      record.feedback({ id: k('mf-1'), workspaceId, modelRegistrationId: k('mr-1') }),
    );
    await store.append(
      'recommendations',
      record.recommendation({ id: k('rc-1'), workspaceId, modelRegistrationId: k('mr-1') }),
    );
    await store.append('financialForecasts', record.forecast({ id: k('ff-1'), workspaceId }));
    await store.append('performanceScorecards', record.scorecard({ id: k('ps-1'), workspaceId }));
    await store.append('portfolioSnapshots', record.snapshot({ id: k('pf-1'), workspaceId }));
    await store.append('renewalAssessments', record.assessment({ id: k('ra-1'), workspaceId }));
  });
}

describe('integration: Batch L is activated and enterprise analytics becomes durable', () => {
  const seeded = sharedDatabase(foundAnalytics);

  it('pairs all nine contracts with a relational repository', () => {
    expect(Object.keys(BATCH_L_RELATIONS).sort()).toEqual(
      BATCH_L_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
    expect(BATCH_L_AGGREGATES).toHaveLength(9);
  });

  it('requires all nine tables at startup and routes to them', async () => {
    const database = await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_L_TABLES) {
      expect(required.has(table), table).toBe(true);
      expect(routed.has(table), table).toBe(true);
    }
  }, 300_000);

  it('keys every table as TEXT, forces row-level security, and leaves the superseded functions behind', async () => {
    const database = await seeded();
    const uuid = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${BATCH_L_TABLES as string[]})
          AND data_type = 'uuid'
      `,
    );
    // `submitted_by`, `assessed_by`, `party_id`, `scope_id` and `contract_id` are principals and
    // cross-aggregate references the runtime keeps as TEXT.
    expect(uuid).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relforcerowsecurity: boolean }[]>`
        SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${BATCH_L_TABLES as string[]})
      `,
    );
    expect(security).toHaveLength(BATCH_L_TABLES.length);
    for (const row of security) expect(row.relforcerowsecurity, row.relname).toBe(true);

    const legacy = await raw(database, (tx) =>
      tx<{ tablename: string }[]>`
        SELECT tablename FROM pg_policies
        WHERE schemaname = current_schema()
          AND (qual LIKE '%has_active_workspace_membership%' OR qual LIKE '%current_workspace_id%')
      `,
    );
    // Not just this batch's: nothing anywhere still predicates on the superseded pair, which is what lets
    // `202608110016` drop the table behind them.
    expect(legacy).toEqual([]);
  }, 300_000);

  it('stores and reads back all nine aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      modelRegistrations: await store.list('modelRegistrations'),
      evaluationRecords: await store.list('evaluationRecords'),
      driftAlerts: await store.list('driftAlerts'),
      modelFeedback: await store.list('modelFeedback'),
      recommendations: await store.list('recommendations'),
      financialForecasts: await store.list('financialForecasts'),
      performanceScorecards: await store.list('performanceScorecards'),
      portfolioSnapshots: await store.list('portfolioSnapshots'),
      renewalAssessments: await store.list('renewalAssessments'),
    }));

    expect(seen.modelRegistrations[0]).toEqual(record.registration());
    // NUMERIC comes back from the driver as a string; a round trip is where that is either parsed or
    // silently returned as text the schema rejects.
    expect(seen.evaluationRecords[0]).toEqual(record.evaluation());
    // `resolvedAt` is optional and absent on an OPEN alert.
    expect(seen.driftAlerts[0]).toEqual(record.alert());
    expect(seen.modelFeedback[0]).toEqual(record.feedback());
    expect(seen.recommendations[0]).toEqual(record.recommendation());
    expect(seen.financialForecasts[0]).toEqual(record.forecast());
    // DATE columns, which the driver returns as a Date at *local* midnight — so a naive ISO conversion moves
    // the day back in any zone behind UTC and the period silently shifts.
    expect(seen.performanceScorecards[0]).toEqual(record.scorecard());
    // BIGINT money, in integer minor units.
    expect(seen.portfolioSnapshots[0]).toEqual(record.snapshot());
    expect(seen.renewalAssessments[0]).toEqual(record.assessment());
  }, 300_000);
});

describe('integration: the AI-governance decisions that could not be recorded', () => {
  const seeded = sharedDatabase(foundAnalytics);

  it('performs every AI-governance decision that could not be recorded', async () => {
    const database = await seeded();
    // Three statements, all refused before `202608110015` by a blanket append-only trigger. Together they are
    // the whole human half of Engine 60's stated contract — and of Engine 56's, which forecasts payment
    // failure and leakage.
    await as(database, (store) =>
      store.replace('financialForecasts', record.forecast({ reviewStatus: 'ACCEPTED' })),
    );
    await as(database, (store) =>
      store.replace('modelRegistrations', record.registration({ status: 'DEPRECATED' })),
    );
    await as(database, (store) =>
      store.replace(
        'recommendations',
        record.recommendation({ status: 'DISMISSED', decidedAt: later }),
      ),
    );

    const seen = await as(database, async (store) => ({
      forecast: (await store.list<{ reviewStatus: string }>('financialForecasts'))[0],
      registration: (await store.list<{ status: string }>('modelRegistrations'))[0],
      recommendation: (await store.list<{ status: string; decidedAt?: string }>('recommendations'))[0],
    }));
    expect(seen.forecast.reviewStatus).toBe('ACCEPTED');
    // A model the platform flagged as drifting can now be taken out of service.
    expect(seen.registration.status).toBe('DEPRECATED');
    expect(seen.recommendation).toMatchObject({ status: 'DISMISSED', decidedAt: later });
  }, 300_000);

  it('acknowledges and resolves a drift alert, and refuses to weaken it', async () => {
    const database = await seeded();
    await as(database, (store) => store.replace('driftAlerts', record.alert({ status: 'ACKNOWLEDGED' })));
    await as(database, (store) =>
      store.replace('driftAlerts', record.alert({ status: 'RESOLVED', resolvedAt: later })),
    );
    const [resolved] = await as(database, (store) =>
      store.list<{ status: string; resolvedAt?: string; severity: string }>('driftAlerts'),
    );
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedAt: later, severity: 'HIGH' });

    // This table had **no** trigger at all before `202608110015`, so the severity of a drift alert could be
    // lowered and the alert deleted outright. It is the evidence that a model has gone wrong.
    const weakened = await attempt(
      raw(database, (tx) =>
        tx`UPDATE drift_alerts SET severity = 'LOW', row_version = row_version + 1 WHERE id = 'da-1'`,
      ),
    );
    expect(String(weakened)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(weakened)).toContain('severity');

    const rewritten = await attempt(
      raw(database, (tx) =>
        tx`UPDATE drift_alerts SET description = 'nothing to see', row_version = row_version + 1
           WHERE id = 'da-1'`,
      ),
    );
    expect(String(rewritten)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const deleted = await attempt(raw(database, (tx) => tx`DELETE FROM drift_alerts WHERE id = 'da-1'`));
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('refuses re-attributing a registration to a different model', async () => {
    const database = await seeded();
    // Every evaluation, drift alert, feedback item and recommendation in this batch references the
    // registration, so a mutable `model_id` silently re-attributes all of them.
    for (const column of ['model_id', 'model_version', 'purpose', 'governed_by'] as const) {
      const failure = await attempt(
        raw(database, (tx) =>
          tx.unsafe(
            `UPDATE model_registrations SET ${column} = 'something-else', row_version = row_version + 1 WHERE id = 'mr-1'`,
          ),
        ),
      );
      expect(String(failure), column).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    }
  }, 300_000);

  it('refuses rewriting what a forecast reviewer read', async () => {
    const database = await seeded();
    for (const [column, value] of [
      ['rationale', `'revised'`],
      ['confidence', '0.99'],
      ['predicted_value', '1'],
      ['model_id', `'other-model'`],
    ] as const) {
      const failure = await attempt(
        raw(database, (tx) =>
          tx.unsafe(
            `UPDATE financial_forecasts SET ${column} = ${value}, row_version = row_version + 1 WHERE id = 'ff-1'`,
          ),
        ),
      );
      expect(String(failure), column).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    }
  }, 300_000);

  it('refuses a transition that does not advance the row counter', async () => {
    const database = await seeded();
    const failure = await attempt(
      raw(database, (tx) => tx`UPDATE model_registrations SET status = 'DEPRECATED' WHERE id = 'mr-1'`),
    );
    expect(String(failure)).toContain('row_version');
  }, 300_000);

  it('refuses rewriting or deleting the five that are measurements', async () => {
    const database = await seeded();
    expect([...BATCH_L_APPEND_ONLY_COLLECTIONS]).toHaveLength(5);
    for (const table of [
      'performance_scorecards',
      'portfolio_snapshots',
      'renewal_assessments',
      'evaluation_records',
      'model_feedback',
    ] as const) {
      const updated = await attempt(
        raw(database, (tx) => tx.unsafe(`UPDATE ${table} SET workspace_id = workspace_id WHERE true`)),
      );
      expect(String(updated), table).toContain('append-only');
      const deleted = await attempt(raw(database, (tx) => tx.unsafe(`DELETE FROM ${table} WHERE true`)));
      expect(String(deleted), table).toContain('append-only');
    }
  }, 300_000);

  it('reports the store’s own refusal for an append-only collection', async () => {
    const database = await seeded();
    const refused = (await as(database, (store) =>
      attempt(store.replace('evaluationRecords', record.evaluation({ passed: false, score: 0.1 }))),
    )) as PostgresStoreError;
    expect(refused.code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
  }, 300_000);
});

describe('integration: rows that cannot contradict themselves', () => {
  const seeded = sharedDatabase(foundAnalytics);

  it('refuses an evaluation claiming a pass below its own threshold', async () => {
    const database = await seeded();
    // The most consequential constraint in the batch. `recordEvaluation` raises a drift alert only when
    // `passed` is false, so a falsified pass suppresses the alert that would have prompted anyone to look.
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO evaluation_records
             (id, tenant_id, workspace_id, model_registration_id, metric, score, threshold, passed,
              evaluated_at, row_version, schema_version, updated_at)
           VALUES ('er-lying', ${TENANT}, ${WORKSPACE}, 'mr-1', 'recall', 0.4, 0.75, true, ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('passed_follows_threshold');

    // And the reverse — a failure recorded against a score that cleared the bar, which would raise an alert
    // about a model that was fine.
    const inverted = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO evaluation_records
             (id, tenant_id, workspace_id, model_registration_id, metric, score, threshold, passed,
              evaluated_at, row_version, schema_version, updated_at)
           VALUES ('er-inverted', ${TENANT}, ${WORKSPACE}, 'mr-1', 'recall', 0.9, 0.75, false, ${stamp}, 1,
                   1, ${stamp})`,
      ),
    );
    expect(String(inverted)).toContain('passed_follows_threshold');
  }, 300_000);

  it('refuses a scorecard whose headline disagrees with its metrics', async () => {
    const database = await seeded();
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO performance_scorecards
             (id, tenant_id, workspace_id, party_id, party_role, period_start, period_end, metrics,
              overall_score, computed_at, row_version, schema_version, updated_at)
           VALUES ('ps-lying', ${TENANT}, ${WORKSPACE}, 'party-2', 'VENDOR', '2026-07-01', '2026-07-31',
                   '{"delivery":80,"quality":70}'::jsonb, 95, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('headline_follows_metrics');

    const empty = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO performance_scorecards
             (id, tenant_id, workspace_id, party_id, party_role, period_start, period_end, metrics,
              overall_score, computed_at, row_version, schema_version, updated_at)
           VALUES ('ps-empty', ${TENANT}, ${WORKSPACE}, 'party-3', 'VENDOR', '2026-07-01', '2026-07-31',
                   '{}'::jsonb, 0, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(empty)).toContain('measures_something');
  }, 300_000);

  it('agrees with the engine on the overall score, at the rounding boundary', async () => {
    const database = await seeded();
    // The database computes the mean in SQL and the engine in JavaScript, so they can diverge on rounding.
    // `round()` in PostgreSQL and `Math.round` in JavaScript differ on negative halves, but a percentage is
    // never negative — this walks a .5 mean, which is where the two would part company if anywhere.
    const accepted = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO performance_scorecards
             (id, tenant_id, workspace_id, party_id, party_role, period_start, period_end, metrics,
              overall_score, computed_at, row_version, schema_version, updated_at)
           VALUES ('ps-half', ${TENANT}, ${WORKSPACE}, 'party-4', 'CUSTOMER', '2026-07-01', '2026-07-31',
                   '{"a":80,"b":71}'::jsonb, ${scorecardOverallScore({ a: 80, b: 71 })}, ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(accepted)).not.toContain('headline_follows_metrics');
  }, 300_000);

  it('keeps a drift alert’s resolution in step with its status', async () => {
    const database = await seeded();
    const resolvedWithoutTime = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO drift_alerts
             (id, tenant_id, workspace_id, model_registration_id, description, severity, status, raised_at,
              resolved_at, row_version, schema_version, updated_at)
           VALUES ('da-nowhen', ${TENANT}, ${WORKSPACE}, 'mr-1', 'drifted', 'LOW', 'RESOLVED', ${stamp},
                   NULL, 1, 1, ${stamp})`,
      ),
    );
    expect(String(resolvedWithoutTime)).toContain('resolution_follows_status');

    // `openDrifts` filters on status, so an OPEN alert carrying a resolution time is visible to that query
    // and closed to anything reading the timestamp.
    const openWithTime = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO drift_alerts
             (id, tenant_id, workspace_id, model_registration_id, description, severity, status, raised_at,
              resolved_at, row_version, schema_version, updated_at)
           VALUES ('da-both', ${TENANT}, ${WORKSPACE}, 'mr-1', 'drifted', 'LOW', 'OPEN', ${stamp},
                   ${later}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(openWithTime)).toContain('resolution_follows_status');

    const backwards = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO drift_alerts
             (id, tenant_id, workspace_id, model_registration_id, description, severity, status, raised_at,
              resolved_at, row_version, schema_version, updated_at)
           VALUES ('da-backwards', ${TENANT}, ${WORKSPACE}, 'mr-1', 'drifted', 'LOW', 'RESOLVED', ${later},
                   ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(backwards)).toContain('resolution_follows_status');
  }, 300_000);

  it('keeps a recommendation’s decision in step with its status', async () => {
    const database = await seeded();
    const pendingWithTime = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO recommendations
             (id, tenant_id, workspace_id, scope_id, model_registration_id, recommendation, confidence,
              status, created_at, decided_at, row_version, schema_version, updated_at)
           VALUES ('rc-both', ${TENANT}, ${WORKSPACE}, 'scope-2', 'mr-1', 'Do the thing', 0.5, 'PENDING',
                   ${stamp}, ${later}, 1, 1, ${stamp})`,
      ),
    );
    expect(String(pendingWithTime)).toContain('decision_follows_status');

    const decidedWithout = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO recommendations
             (id, tenant_id, workspace_id, scope_id, model_registration_id, recommendation, confidence,
              status, created_at, decided_at, row_version, schema_version, updated_at)
           VALUES ('rc-nowhen', ${TENANT}, ${WORKSPACE}, 'scope-3', 'mr-1', 'Do the thing', 0.5,
                   'ACCEPTED', ${stamp}, NULL, 1, 1, ${stamp})`,
      ),
    );
    expect(String(decidedWithout)).toContain('decision_follows_status');
  }, 300_000);

  it('refuses an ungoverned model and an unreasoned assessment', async () => {
    const database = await seeded();
    const ungoverned = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO model_registrations
             (id, tenant_id, workspace_id, model_id, model_version, purpose, governed_by, status,
              registered_at, row_version, schema_version, updated_at)
           VALUES ('mr-blank', ${TENANT}, ${WORKSPACE}, 'm', '2', '   ', 'committee', 'ACTIVE', ${stamp},
                   1, 1, ${stamp})`,
      ),
    );
    expect(String(ungoverned)).toContain('is_governed');

    const unreasoned = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO renewal_assessments
             (id, tenant_id, workspace_id, contract_id, renewal_readiness_score,
              performance_history_summary, recommended_action, rationale, assessed_by, assessed_at,
              row_version, schema_version, updated_at)
           VALUES ('ra-blank', ${TENANT}, ${WORKSPACE}, 'c-2', 20, 'summary', 'DO_NOT_RENEW', '  ',
                   ${ACTOR}, ${stamp}, 1, 1, ${stamp})`,
      ),
    );
    // `DO_NOT_RENEW` with no stated reasoning is a commercially consequential conclusion nobody can review.
    expect(String(unreasoned)).toContain('is_reasoned');
  }, 300_000);
});

describe('integration: Batch L tenancy and the retirement it unlocks', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundAnalytics(database);
    await foundAnalytics(database, OTHER_TENANT, OTHER_WORKSPACE, '-o');
  });

  it('shows another tenant only its own models', async () => {
    const database = await seeded();
    const mine = await as(database, (store) => store.list<{ id: string }>('modelRegistrations'));
    expect(mine.map((row) => row.id)).toEqual(['mr-1']);
    const theirs = await as(
      database,
      (store) => store.list<{ id: string }>('modelRegistrations'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(theirs.map((row) => row.id)).toEqual(['mr-1-o']);
  }, 300_000);

  it('lets two tenants register the same model version, which a global key had prevented', async () => {
    const database = await seeded();
    // Both seeds register `deterministic-financial-forecast` version 1. The original key named the workspace
    // but not the tenant; the scoped replacement is why both succeed.
    const mine = await as(database, (store) =>
      store.list<{ modelId: string; modelVersion: string }>('modelRegistrations'),
    );
    const theirs = await as(
      database,
      (store) => store.list<{ modelId: string; modelVersion: string }>('modelRegistrations'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(mine[0]).toMatchObject({ modelId: 'deterministic-financial-forecast', modelVersion: '1' });
    expect(theirs[0]).toMatchObject({ modelId: 'deterministic-financial-forecast', modelVersion: '1' });

    // And a duplicate inside one tenant is still refused.
    const duplicate = await attempt(
      as(database, (store) => store.append('modelRegistrations', record.registration({ id: 'mr-dup' }))),
    );
    expect(String(duplicate)).toContain('model_registrations_tenant_model_version_unique');
  }, 300_000);

  it('refuses a child row referencing a model in another tenant', async () => {
    const database = await seeded();
    const failure = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO drift_alerts
             (id, tenant_id, workspace_id, model_registration_id, description, severity, status, raised_at,
              row_version, schema_version, updated_at)
           VALUES ('da-cross', ${TENANT}, ${WORKSPACE}, 'mr-1-o', 'drifted', 'LOW', 'OPEN', ${stamp}, 1, 1,
                   ${stamp})`,
      ),
    );
    expect(String(failure)).toContain('drift_alerts_model_fk');
  }, 300_000);

  it('retires the three trust-domain compatibility tables', async () => {
    const database = await seeded();
    // `202608080001` had to retain `workspaces`, `workspace_memberships` and `user_identities`, and named
    // `persistence.domain-store-durability` as the retirement condition. Twelve batches later it is met:
    // Batch L removed the last tables referencing them.
    const present = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY(${['workspaces', 'workspace_memberships', 'user_identities']})
      `,
    );
    expect(present).toEqual([]);

    // And the functions behind them. A function reading a table that no longer exists resolves at policy
    // creation and fails at query time, which is the worst place to find out.
    const functions = await raw(database, (tx) =>
      tx<{ proname: string }[]>`
        SELECT proname FROM pg_proc
        WHERE proname IN ('has_active_workspace_membership', 'current_workspace_id')
      `,
    );
    expect(functions).toEqual([]);
  }, 300_000);

  it('leaves no table carrying ENABLE without FORCE', async () => {
    const database = await seeded();
    // The register measured 59 of these, and recorded them as a ceiling that could fall without an edit and
    // could not rise. Batches E through L converged every one, and the retirement removed the last three
    // tables that had them.
    const unforced = await raw(database, (tx) =>
      tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND c.relrowsecurity AND NOT c.relforcerowsecurity
        ORDER BY 1
      `,
    );
    expect(unforced).toEqual([]);

    // What remains without any boundary, named rather than left implicit: two dead legacy tables no engine
    // reads or writes, and the migration ledger, which the owner writes and every host reads at startup.
    const none = await raw(database, (tx) =>
      tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY 1
      `,
    );
    expect(none.map((row) => row.relname)).toEqual([
      'contracts',
      'milestones',
      'trust_migration_ledger',
    ]);
  }, 300_000);
});
