import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_G_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_G_AGGREGATES,
  BATCH_G_APPEND_ONLY_COLLECTIONS,
  BATCH_G_TABLES,
} from '@assurapay/domain-contracts';
import {
  AcceptanceCriteriaEngine,
  PaymentTriggerRuleEngine,
  SuccessMetricsEngine,
} from '@assurapay/performance-readiness';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch G persists to its own tables, and three engines start working.
 *
 * Every batch since A has found a mutation boundary that contradicted its engines, and this suite is
 * where Batch G's is proved rather than asserted. `202608030005` put blanket append-only triggers on
 * `acceptance_criteria`, `success_metrics` and `payment_trigger_rules`, all three of which their engines
 * transition — so `confirm()`, `confirm()` and `activate()` all refused on the durable path. The tests
 * below drive those three methods through the real store against real PostgreSQL, which is the only place
 * that claim can be checked: against `InMemoryTrustStore` they always passed.
 *
 * The payment trigger rule is the case that matters. `evaluate()` refuses any rule that is not ACTIVE and
 * `paymentEligibility.paymentTriggerRuleId` names the rule as the authority a release rests on, so a rule
 * that could not leave DRAFT made the whole condition unassessable. `202608110009` also makes that
 * reference a foreign key for the first time, which is asserted here too.
 *
 * Every refusal is exercised through a direct statement as well as, or instead of, the store.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-g';
const OTHER_TENANT = 'tenant-g-other';
const WORKSPACE = 'workspace-g';
const OTHER_WORKSPACE = 'workspace-g-other';
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

/**
 * One database per describe block, seeded once.
 *
 * The same arrangement Batch F settled on, and for the same reason: a database per test exhausts the
 * server's connection allowance long before the suite finishes.
 */
function sharedDatabase(seed?: (database: TestDatabase) => Promise<void>): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () =>
    (pending ??= (async () => {
      const database = await migratedDatabase();
      if (seed) await seed(database);
      return database;
    })());
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

/** Raw SQL under a tenant scope. Every Batch G table forces row-level security. */
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

const CONTEXT = {
  actorUserId: ACTOR,
  sessionId: 'session-g',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: WORKSPACE,
  tenantId: TENANT,
  memberships: [WORKSPACE],
  correlationId: 'correlation-g',
};

// ---------------------------------------------------------------------------------------
// Records, in the domain's vocabulary
// ---------------------------------------------------------------------------------------

const record = {
  criterion: (o: Record<string, unknown> = {}) => ({
    id: 'ac-1',
    workspaceId: WORKSPACE,
    deliverableId: 'dl-1',
    description: 'Slab reaches design strength',
    testMethod: 'MEASUREMENT',
    metric: 'compressive-strength',
    tolerance: { operator: 'GTE', target: 30, unit: 'MPa' },
    validatorRole: 'ENGINEER',
    retestAllowed: true,
    maxRetests: 2,
    status: 'DRAFT',
    createdAt: stamp,
    ...o,
  }),
  metric: (o: Record<string, unknown> = {}) => ({
    id: 'sm-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    kind: 'QUALITY',
    name: 'Defect density',
    targetValue: 2.5,
    unit: 'per-kloc',
    direction: 'LOWER_IS_BETTER',
    weightPercent: 40,
    status: 'DRAFT',
    createdAt: stamp,
    ...o,
  }),
  dependency: (o: Record<string, unknown> = {}) => ({
    id: 'dep-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    kind: 'VENDOR',
    description: 'Supplier confirms the delivery window',
    ownerId: ACTOR,
    dueDate: '2026-09-15',
    criticality: 'BLOCKING',
    status: 'OPEN',
    createdAt: stamp,
    ...o,
  }),
  rule: (o: Record<string, unknown> = {}) => ({
    id: 'ptr-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    name: 'On acceptance',
    ruleType: 'ACCEPTANCE_PASSED',
    requiredAcceptanceCriterionIds: ['ac-1'],
    amountMinor: 5_000_000,
    currency: 'NGN',
    status: 'DRAFT',
    createdAt: stamp,
    ...o,
  }),
  baseline: (o: Record<string, unknown> = {}) => ({
    id: 'pb-1',
    workspaceId: WORKSPACE,
    blueprintId: 'bp-1',
    milestoneId: 'ms-1',
    plannedStartDate: '2026-09-01',
    plannedDueDate: '2026-09-30',
    plannedBudgetAmountMinor: 5_000_000,
    plannedScopeItemCount: 4,
    plannedQualityScore: 90,
    plannedRiskScore: 20,
    status: 'BASELINED',
    createdAt: stamp,
    ...o,
  }),
  variance: (o: Record<string, unknown> = {}) => ({
    id: 'bv-1',
    workspaceId: WORKSPACE,
    baselineId: 'pb-1',
    actualDueDate: '2026-09-27',
    actualCostAmountMinor: 4_750_000,
    actualScopeItemCount: 4,
    // Signed both ways: three days early, a quarter of a million under.
    scheduleVarianceDays: -3,
    costVarianceMinor: -250_000,
    scopeVarianceCount: 0,
    recordedBy: ACTOR,
    recordedAt: stamp,
    ...o,
  }),
};

/**
 * The Batch E chain Batch G hangs off, then Batch G's own six.
 *
 * Batch G references four Batch E parents — deliverable, milestone, definition-of-done package,
 * blueprint — so the seed has to build them. That it can is the whole reason this batch comes after E.
 */
async function foundReadiness(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('performanceBlueprints', {
      id: k('bp-1'),
      workspaceId,
      contractId: k('c-1'),
      contractVersionId: k('cv-1'),
      agreementIntelligenceVersionId: k('aiv-1'),
      version: 1,
      status: 'ACTIVE',
      createdBy: ACTOR,
      createdAt: stamp,
      contentHash: 'a3f1c9',
    });
    await store.append('scopeItems', {
      id: k('si-1'),
      workspaceId,
      blueprintId: k('bp-1'),
      kind: 'INCLUDED',
      description: 'Foundation works to slab level',
      assumptions: ['Site access from week 1'],
      constraints: ['No weekend working'],
      ownerId: ACTOR,
      status: 'DRAFT',
      createdAt: stamp,
    });
    await store.append('deliverables', {
      id: k('dl-1'),
      workspaceId,
      blueprintId: k('bp-1'),
      scopeItemId: k('si-1'),
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
    });
    await store.append('blueprintMilestones', {
      id: k('ms-1'),
      workspaceId,
      blueprintId: k('bp-1'),
      title: 'Slab complete',
      deliverableIds: [k('dl-1')],
      startDate: '2026-09-01',
      dueDate: '2026-09-30',
      budgetAmountMinor: 5_000_000,
      currency: 'NGN',
      valueAllocationPercent: 25,
      status: 'SCHEDULED',
      createdAt: stamp,
    });
    await store.append('dodPackages', {
      id: k('dod-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      version: 1,
      deliverableGateIds: [k('dl-1')],
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
    });
    // A HYBRID rule, so the definition-of-done foreign key is exercised rather than only the CHECK that
    // requires the reference. Nullable and MATCH SIMPLE, so an unnamed package skips the key entirely —
    // which is why a rule that *does* name one needs a test of its own.
    await store.append(
      'paymentTriggerRules',
      record.rule({
        id: k('ptr-hybrid'),
        workspaceId,
        milestoneId: k('ms-1'),
        ruleType: 'HYBRID',
        requiredDodPackageId: k('dod-1'),
        requiredAcceptanceCriterionIds: [k('ac-1')],
      }),
    );

    await store.append('acceptanceCriteria', record.criterion({ id: k('ac-1'), workspaceId, deliverableId: k('dl-1') }));
    await store.append('successMetrics', record.metric({ id: k('sm-1'), workspaceId, milestoneId: k('ms-1') }));
    await store.append('dependencies', record.dependency({ id: k('dep-1'), workspaceId, milestoneId: k('ms-1') }));
    await store.append(
      'paymentTriggerRules',
      record.rule({
        id: k('ptr-1'),
        workspaceId,
        milestoneId: k('ms-1'),
        requiredAcceptanceCriterionIds: [k('ac-1')],
      }),
    );
    await store.append(
      'performanceBaselines',
      record.baseline({ id: k('pb-1'), workspaceId, blueprintId: k('bp-1'), milestoneId: k('ms-1') }),
    );
    await store.append('baselineVariances', record.variance({ id: k('bv-1'), workspaceId, baselineId: k('pb-1') }));
  });
}

describe('integration: Batch G is activated and performance readiness becomes durable', () => {
  const seeded = sharedDatabase(foundReadiness);

  it('pairs all six contracts with a relational repository', () => {
    expect(Object.keys(BATCH_G_RELATIONS).sort()).toEqual(
      BATCH_G_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
  });

  it('requires all six tables at startup and routes to no others', async () => {
    const database = await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    for (const table of BATCH_G_TABLES) expect(required.has(table)).toBe(true);
    // The other direction, which is what the readiness check is for: a routed table readiness does not
    // require is discovered on the first write, after the host has reported itself healthy.
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_G_TABLES) expect(routed.has(table)).toBe(true);

    const present = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `,
    );
    const names = new Set(present.map((row) => row.table_name));
    for (const table of BATCH_G_TABLES) expect(names.has(table)).toBe(true);
  }, 300_000);

  it('keys every Batch G table as TEXT, forces row-level security, and leaves no UUID behind', async () => {
    const database = await seeded();
    const columns = await raw(database, (tx) =>
      tx<{ data_type: string }[]>`
        SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${BATCH_G_TABLES as string[]})
          AND data_type = 'uuid'
      `,
    );
    // The Batch A defect, which these six carried until now: identity was UUID while the trust runtime
    // is TEXT throughout, so an actor column could not hold a trust principal id.
    expect(columns).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${BATCH_G_TABLES as string[]})
      `,
    );
    expect(security).toHaveLength(BATCH_G_TABLES.length);
    // FORCE, not merely ENABLE: ENABLE does not constrain the table owner.
    for (const row of security) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  }, 300_000);

  it('stores and reads back every one of the six aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      acceptanceCriteria: await store.list('acceptanceCriteria'),
      successMetrics: await store.list('successMetrics'),
      dependencies: await store.list('dependencies'),
      paymentTriggerRules: await store.list('paymentTriggerRules'),
      performanceBaselines: await store.list('performanceBaselines'),
      baselineVariances: await store.list('baselineVariances'),
    }));

    expect(seen.acceptanceCriteria[0]).toEqual(record.criterion());
    expect(seen.successMetrics[0]).toEqual(record.metric());
    expect(seen.dependencies[0]).toEqual(record.dependency());
    expect(seen.paymentTriggerRules[0]).toEqual(record.rule());
    expect(seen.performanceBaselines[0]).toEqual(record.baseline());
    // The signed money and the fractional decimals survive the round trip exactly: -250_000 kobo under
    // budget stays negative, and 2.5 stays 2.5 rather than becoming 2 or "2.5".
    expect(seen.baselineVariances[0]).toEqual(record.variance());
  }, 300_000);
});

describe('integration: the three engines the blanket trigger had disabled now work', () => {
  // Its own database, because these tests transition rows and the assertions above read them as seeded.
  const seeded = sharedDatabase(foundReadiness);

  it('confirms an acceptance criterion, which the append-only trigger used to refuse', async () => {
    const database = await seeded();
    const confirmed = await as(database, (store) =>
      new AcceptanceCriteriaEngine(store).confirm(CONTEXT, 'ac-1'),
    );
    expect(confirmed.status).toBe('CONFIRMED');
  }, 300_000);

  it('confirms a success metric', async () => {
    const database = await seeded();
    const confirmed = await as(database, (store) =>
      new SuccessMetricsEngine(store).confirm(CONTEXT, 'sm-1'),
    );
    expect(confirmed.status).toBe('CONFIRMED');
  }, 300_000);

  it('activates a payment trigger rule and then evaluates it', async () => {
    const database = await seeded();
    // The consequential one. Before `202608110009` this refused with `append-only table`, so no rule could
    // reach ACTIVE — and `evaluate()` refuses anything that is not, so the condition
    // `paymentEligibility` cites as its authority could never be assessed at all.
    const activated = await as(database, (store) =>
      new PaymentTriggerRuleEngine(store).activate(CONTEXT, 'ptr-1'),
    );
    expect(activated.status).toBe('ACTIVE');

    const met = await as(database, (store) =>
      new PaymentTriggerRuleEngine(store).evaluate(CONTEXT, 'ptr-1', {
        dodPublished: true,
        acceptedCriterionIds: ['ac-1'],
        blockingDependencyCount: 0,
      }),
    );
    expect(met).toEqual({ triggerId: 'ptr-1', eligible: true, blockers: [] });

    const blocked = await as(database, (store) =>
      new PaymentTriggerRuleEngine(store).evaluate(CONTEXT, 'ptr-1', {
        dodPublished: true,
        acceptedCriterionIds: [],
        blockingDependencyCount: 1,
      }),
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockers).toEqual([
      'UNRESOLVED_BLOCKING_DEPENDENCIES',
      'ACCEPTANCE_CRITERIA_NOT_MET',
    ]);
  }, 300_000);
});

describe('integration: Batch G mutation boundaries', () => {
  const seeded = sharedDatabase(foundReadiness);

  it('refuses a change to the amount a rule authorises', async () => {
    const database = await seeded();
    // The load-bearing immutable fact of this batch. A rule whose amount could be rewritten after
    // activation would let an approved authority release a different sum than the one approved.
    const failure = await raw(database, (tx) =>
      tx`UPDATE payment_trigger_rules SET amount_minor = 9_000_000, row_version = row_version + 1
         WHERE id = 'ptr-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('amount_minor');
  }, 300_000);

  it('refuses a change to the evidence a rule requires', async () => {
    const database = await seeded();
    for (const column of ['rule_type', 'required_acceptance_criterion_ids'] as const) {
      const failure = await raw(database, (tx) =>
        column === 'rule_type'
          ? tx`UPDATE payment_trigger_rules SET rule_type = 'MILESTONE_COMPLETION',
                 row_version = row_version + 1 WHERE id = 'ptr-1'`
          : tx`UPDATE payment_trigger_rules SET required_acceptance_criterion_ids = '[]'::jsonb,
                 row_version = row_version + 1 WHERE id = 'ptr-1'`,
      ).catch((caught: unknown) => caught);
      // A condition that has already been evaluated must not be able to mean something else afterwards.
      expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
      expect(String(failure)).toContain(column);
    }
  }, 300_000);

  it('refuses downgrading a blocking dependency in place', async () => {
    const database = await seeded();
    // `blockers()` treats an OPEN BLOCKING dependency as a reason a milestone cannot proceed. A mutable
    // criticality is a blocker that can be made to disappear without being resolved.
    const failure = await raw(database, (tx) =>
      tx`UPDATE dependencies SET criticality = 'LOW', row_version = row_version + 1 WHERE id = 'dep-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('criticality');
  }, 300_000);

  it('refuses a write that does not advance the row counter', async () => {
    const database = await seeded();
    const stale = await raw(database, (tx) =>
      tx`UPDATE success_metrics SET status = 'CONFIRMED' WHERE id = 'sm-1'`,
    ).catch((caught: unknown) => caught);
    // Names `row_version`, which is what the generalised trigger's `concurrency=` argument selects.
    expect(String(stale)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
    expect(String(stale)).toContain('row_version');
  }, 300_000);

  it('keeps the two genuinely append-only aggregates append-only', async () => {
    const database = await seeded();
    expect([...BATCH_G_APPEND_ONLY_COLLECTIONS].sort()).toEqual([
      'baselineVariances',
      'performanceBaselines',
    ]);

    // A baseline is the plan as it stood, and a variance is an observation. Both refuse in the database
    // as well as in the store, which is what makes the store's refusal a report rather than the rule.
    for (const table of ['performance_baselines', 'baseline_variances'] as const) {
      const failure = await raw(database, (tx) =>
        table === 'performance_baselines'
          ? tx`UPDATE performance_baselines SET planned_risk_score = 5 WHERE id = 'pb-1'`
          : tx`UPDATE baseline_variances SET scope_variance_count = 9 WHERE id = 'bv-1'`,
      ).catch((caught: unknown) => caught);
      expect(String(failure)).toContain('append-only');
    }

    const refused = await as(database, (store) =>
      store
        .replace('performanceBaselines', record.baseline({ plannedRiskScore: 5 }))
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
  }, 300_000);
});

describe('integration: Batch G invariants the schema alone cannot carry', () => {
  const seeded = sharedDatabase(foundReadiness);

  it('refuses an incoherent retest configuration', async () => {
    const database = await seeded();
    for (const [allowed, limit] of [
      [false, 3],
      [true, 0],
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx`INSERT INTO acceptance_criteria
             (id, tenant_id, workspace_id, deliverable_id, description, test_method, metric, tolerance,
              validator_role, retest_allowed, max_retests, status, created_at, row_version,
              schema_version, updated_at)
           VALUES ('ac-bad', ${TENANT}, ${WORKSPACE}, 'dl-1', 'x', 'MEASUREMENT', 'm',
                   '{"operator":"GTE","target":1,"unit":"MPa"}'::jsonb, 'ENGINEER', ${allowed},
                   ${limit}, 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
      ).catch((caught: unknown) => caught);
      expect(String(failure)).toContain('retest_configuration');
    }
  }, 300_000);

  it('refuses a BETWEEN tolerance whose upper bound does not clear the target', async () => {
    const database = await seeded();
    const failure = await raw(database, (tx) =>
      tx`INSERT INTO acceptance_criteria
           (id, tenant_id, workspace_id, deliverable_id, description, test_method, metric, tolerance,
            validator_role, retest_allowed, max_retests, status, created_at, row_version, schema_version,
            updated_at)
         VALUES ('ac-band', ${TENANT}, ${WORKSPACE}, 'dl-1', 'x', 'MEASUREMENT', 'm',
                 '{"operator":"BETWEEN","target":5,"unit":"MPa","upperBound":4}'::jsonb, 'ENGINEER',
                 false, 0, 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    // A band that admits nothing makes every measurement fail, so the deliverable reads as defective
    // rather than the criterion as misconfigured.
    expect(String(failure)).toContain('tolerance_range');
  }, 300_000);

  it('refuses a rule that turns on evidence it does not name', async () => {
    const database = await seeded();
    for (const [ruleType, constraint] of [
      ['DOD_PUBLISHED', 'dod_reference_present'],
      ['ACCEPTANCE_PASSED', 'acceptance_reference_present'],
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx`INSERT INTO payment_trigger_rules
             (id, tenant_id, workspace_id, milestone_id, name, rule_type, required_dod_package_id,
              required_acceptance_criterion_ids, amount_minor, currency, status, created_at, row_version,
              schema_version, updated_at)
           VALUES ('ptr-bad', ${TENANT}, ${WORKSPACE}, 'ms-1', 'x', ${ruleType}, NULL, '[]'::jsonb,
                   1000, 'NGN', 'DRAFT', ${stamp}, 1, 1, ${stamp})`,
      ).catch((caught: unknown) => caught);
      // `evaluate()` would otherwise find nothing to check and report the condition met — a release
      // authorised by a condition that never applied.
      expect(String(failure)).toContain(constraint);
    }
  }, 300_000);

  it('refuses a resolved dependency with no time it resolved, and an open one that has one', async () => {
    const database = await seeded();
    for (const [status, resolvedAt] of [
      ['RESOLVED', null],
      ['OPEN', stamp],
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx`INSERT INTO dependencies
             (id, tenant_id, workspace_id, milestone_id, kind, description, owner_id, due_date,
              criticality, status, created_at, resolved_at, row_version, schema_version, updated_at)
           VALUES ('dep-bad', ${TENANT}, ${WORKSPACE}, 'ms-1', 'VENDOR', 'x', ${ACTOR}, '2026-09-15',
                   'LOW', ${status}, ${stamp}, ${resolvedAt}, 1, 1, ${stamp})`,
      ).catch((caught: unknown) => caught);
      expect(String(failure)).toContain('resolved_at_follows_status');
    }
  }, 300_000);

  it('refuses a baseline that finishes before it starts, and a second for the same milestone', async () => {
    const database = await seeded();
    const inverted = await raw(database, (tx) =>
      tx`INSERT INTO performance_baselines
           (id, tenant_id, workspace_id, blueprint_id, milestone_id, planned_start_date,
            planned_due_date, planned_budget_amount_minor, planned_scope_item_count,
            planned_quality_score, planned_risk_score, status, created_at, row_version, schema_version,
            updated_at)
         VALUES ('pb-bad', ${TENANT}, ${WORKSPACE}, 'bp-1', 'ms-2', '2026-09-30', '2026-09-01', 1000, 1,
                 90, 20, 'BASELINED', ${stamp}, 1, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    expect(String(inverted)).toContain('dates_ordered');

    // `baseline()` lists existing baselines and refuses BASELINE_ALREADY_SET, which two concurrent
    // callers both clear. The unique key is what actually prevents the second.
    const duplicate = await as(database, (store) =>
      store
        .append('performanceBaselines', record.baseline({ id: 'pb-2' }))
        .catch((caught: unknown) => caught),
    );
    expect((duplicate as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a negative observed cost while keeping the variance signed', async () => {
    const database = await seeded();
    const negative = await raw(database, (tx) =>
      tx`INSERT INTO baseline_variances
           (id, tenant_id, workspace_id, baseline_id, actual_cost_amount_minor, schedule_variance_days,
            cost_variance_minor, scope_variance_count, recorded_by, recorded_at, row_version,
            schema_version, updated_at)
         VALUES ('bv-bad', ${TENANT}, ${WORKSPACE}, 'pb-1', -1, 0, 0, 0, ${ACTOR}, ${stamp}, 1, 1,
                 ${stamp})`,
    ).catch((caught: unknown) => caught);
    // A negative outlay is not a cost, it is a different event.
    expect(String(negative)).toContain('actual_cost_not_negative');

    // The variance itself stays signed, because under budget is a real outcome. Already proved by the
    // round trip; asserted again here so the pair of rules reads together.
    const [stored] = await as(database, (store) =>
      store.list<{ costVarianceMinor: number }>('baselineVariances'),
    );
    expect(stored.costVarianceMinor).toBe(-250_000);
  }, 300_000);
});

describe('integration: the reference Batch B had to leave open', () => {
  const seeded = sharedDatabase(foundReadiness);

  it('makes paymentEligibility.paymentTriggerRuleId a real foreign key', async () => {
    const database = await seeded();
    const [definition] = await raw(database, (tx) =>
      tx<{ d: string }[]>`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname = 'payment_eligibilities_trigger_rule_fk'
      `,
    );
    // NOT NULL with no key since `202608030008`, because the rule had no durable home to point at.
    expect(definition.d).toContain('payment_trigger_rule_id');
    expect(definition.d).toContain('REFERENCES payment_trigger_rules');
    expect(definition.d).toContain('(tenant_id, workspace_id,');
  }, 300_000);

  it('refuses an eligibility naming a rule that does not exist', async () => {
    const database = await seeded();
    const failure = await raw(database, (tx) =>
      tx`INSERT INTO payment_eligibilities
           (id, tenant_id, workspace_id, milestone_id, completion_certificate_id,
            payment_trigger_rule_id, eligible, blockers, evaluated_by, evaluated_at, version,
            schema_version, updated_at)
         VALUES ('pe-ghost', ${TENANT}, ${WORKSPACE}, 'ms-1', 'cert-1', 'ptr-does-not-exist', true,
                 '[]'::jsonb, ${ACTOR}, ${stamp}, 1, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    // The whole point of the batch: an eligibility whose stated authority never existed is refused,
    // rather than standing as evidence for a release.
    expect(String(failure)).toContain('payment_eligibilities_trigger_rule_fk');
  }, 300_000);
});

describe('integration: Batch G tenancy, and the keys that used to span tenants', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundReadiness(database);
    await foundReadiness(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
  });

  it('shows another tenant nothing', async () => {
    const database = await seeded();
    const seen = await as(
      database,
      (store) => store.list<{ id: string }>('paymentTriggerRules'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    // Both of the other tenant's rules and neither of this tenant's. Sorted, because what is being
    // asserted is the set the policy admits rather than the order the reader happens to return.
    expect(seen.map((row) => row.id).sort()).toEqual(['ptr-1-other', 'ptr-hybrid-other']);
  }, 300_000);

  it('refuses a child row referencing a parent in another tenant', async () => {
    const database = await seeded();
    // Foreign key checks run as the table owner and are not subject to row-level security, so only the
    // composite key closes this.
    const failure = await raw(
      database,
      (tx) => tx`
        INSERT INTO success_metrics
          (id, tenant_id, workspace_id, milestone_id, kind, name, target_value, unit, direction,
           weight_percent, status, created_at, row_version, schema_version, updated_at)
        VALUES ('sm-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'ms-1', 'QUALITY', 'x', 1, 'u',
                'HIGHER_IS_BETTER', 10, 'DRAFT', ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('success_metrics_milestone_fk');
  }, 300_000);

  it('lets two tenants hold the same blueprint revision, which a global key had prevented', async () => {
    const database = await seeded();
    // `202608110010`. Both tenants above founded a blueprint at version 1, which
    // `performance_blueprints_contract_id_version_key` refused outright until it was scoped — a
    // cross-tenant denial of service needing no privilege and no mistake. That both seeds succeeded is
    // the proof; this asserts the historical key is actually gone rather than merely unexercised.
    const leftovers = await raw(database, (tx) =>
      tx<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND indexdef LIKE '%UNIQUE%'
          AND indexname NOT LIKE '%\\_pkey'
          AND indexdef NOT LIKE '%tenant_id%' AND indexdef NOT LIKE '%workspace_id%'
          AND tablename = ANY(${[...POSTGRES_ROUTED_TABLES] as string[]})
      `,
    );
    // A ratchet, not a snapshot: any routed table that later gains a unique key naming neither scope
    // fails here, which is how this defect class stays closed.
    expect(leftovers.map((row) => row.indexname)).toEqual([]);
  }, 300_000);
});
