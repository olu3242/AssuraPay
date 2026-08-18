import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_H_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_H_AGGREGATES,
  BATCH_H_APPEND_ONLY_COLLECTIONS,
  BATCH_H_DOMAIN_VERSION_IS_CONCURRENCY,
  BATCH_H_TABLES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch H persists to its own tables, and the release-authorisation chain gains a boundary.
 *
 * The eleven governance-core aggregates of canonical Engines 06-10. Eight of the eleven tables had no
 * mutation boundary at all before `202608110011`, and four of those eight are the aggregates that gate a
 * release — the definition-of-done evaluation, the trigger definition, and the authorization proposal that
 * `createEscrowReleaseIntent` reads before instructing a certified Financial Provider.
 *
 * The test this suite exists for is `refuses the one statement that authorised an uncertified release`. It
 * performs the exact UPDATE that used to work, and asserts the database now refuses it. That claim cannot
 * be checked anywhere but here: against `InMemoryTrustStore` there is no statement to issue.
 *
 * Every refusal is exercised through a direct statement as well as, or instead of, the store.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-h';
const OTHER_TENANT = 'tenant-h-other';
const WORKSPACE = 'workspace-h';
const OTHER_WORKSPACE = 'workspace-h-other';
const ACTOR = 'user-owner';
const REVIEWER = 'user-reviewer';

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

const stamp = '2026-08-11T09:00:00.000Z';
const HASH = 'a'.repeat(64);

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch H table forces row-level security. */
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

const record = {
  execution: (o: Record<string, unknown> = {}) => ({
    id: 'ge-1',
    workspaceId: WORKSPACE,
    contractId: 'c-1',
    title: 'Foundation package',
    ownerUserId: ACTOR,
    state: 'ACTIVE',
    startedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    version: 2,
    ...o,
  }),
  history: (o: Record<string, unknown> = {}) => ({
    id: 'eh-1',
    workspaceId: WORKSPACE,
    executionId: 'ge-1',
    fromState: 'PLANNED',
    toState: 'ACTIVE',
    actorId: ACTOR,
    reason: 'Site handover complete',
    sequence: 2,
    occurredAt: stamp,
    ...o,
  }),
  milestone: (o: Record<string, unknown> = {}) => ({
    id: 'gm-1',
    workspaceId: WORKSPACE,
    executionId: 'ge-1',
    title: 'Slab complete',
    ownerUserId: ACTOR,
    state: 'ACTIVE',
    durationDays: 30,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
    ...o,
  }),
  dependency: (o: Record<string, unknown> = {}) => ({
    id: 'md-1',
    workspaceId: WORKSPACE,
    executionId: 'ge-1',
    predecessorId: 'gm-1',
    successorId: 'gm-2',
    dependencyType: 'FINISH_TO_START',
    createdAt: stamp,
    ...o,
  }),
  definition: (o: Record<string, unknown> = {}) => ({
    id: 'dv-1',
    workspaceId: WORKSPACE,
    milestoneId: 'gm-1',
    version: 1,
    status: 'PUBLISHED',
    criteria: [
      {
        key: 'cube-test',
        description: 'Cube test at 28 days',
        mandatory: true,
        evidenceRequirementKeys: ['lab-cert'],
        evaluationType: 'MANUAL',
      },
    ],
    createdBy: ACTOR,
    createdAt: stamp,
    publishedAt: stamp,
    contentHash: HASH,
    ...o,
  }),
  evaluation: (o: Record<string, unknown> = {}) => ({
    id: 'de-1',
    workspaceId: WORKSPACE,
    milestoneId: 'gm-1',
    definitionId: 'dv-1',
    results: [{ criterionKey: 'cube-test', passed: true, reason: 'Met at 28 days' }],
    mandatoryPassed: true,
    manualReviewRequired: false,
    evidenceReferences: ['lab-cert-1'],
    evaluatedBy: ACTOR,
    evaluatedAt: stamp,
    ...o,
  }),
  request: (o: Record<string, unknown> = {}) => ({
    id: 'cr-1',
    workspaceId: WORKSPACE,
    executionId: 'ge-1',
    milestoneId: 'gm-1',
    dodEvaluationId: 'de-1',
    requestedBy: ACTOR,
    status: 'APPROVED',
    reviewerIds: [REVIEWER],
    createdAt: stamp,
    updatedAt: stamp,
    version: 2,
    ...o,
  }),
  decision: (o: Record<string, unknown> = {}) => ({
    id: 'cd-1',
    workspaceId: WORKSPACE,
    certificationRequestId: 'cr-1',
    reviewerId: REVIEWER,
    decision: 'APPROVE',
    rationale: 'Evidence complete and consistent',
    evidenceReferences: ['lab-cert-1'],
    decidedAt: stamp,
    ...o,
  }),
  certificate: (o: Record<string, unknown> = {}) => ({
    id: 'dcr-1',
    workspaceId: WORKSPACE,
    certificationRequestId: 'cr-1',
    milestoneId: 'gm-1',
    certificateNumber: 'AP-CERT-2026-000001',
    canonicalHash: 'b'.repeat(64),
    status: 'CERTIFIED',
    issuedBy: ACTOR,
    issuedAt: stamp,
    ...o,
  }),
  trigger: (o: Record<string, unknown> = {}) => ({
    id: 'ptd-1',
    workspaceId: WORKSPACE,
    milestoneId: 'gm-1',
    name: 'On certification',
    requiredDodDefinitionId: 'dv-1',
    certificationRequired: true,
    amountMinor: 5_000_000,
    currency: 'NGN',
    escrowProviderKey: 'partner-bank',
    status: 'ACTIVE',
    createdAt: stamp,
    version: 1,
    ...o,
  }),
  proposal: (o: Record<string, unknown> = {}) => ({
    id: 'pap-1',
    workspaceId: WORKSPACE,
    triggerId: 'ptd-1',
    milestoneId: 'gm-1',
    certificationId: 'dcr-1',
    amountMinor: 5_000_000,
    currency: 'NGN',
    status: 'PROPOSED',
    blockers: [],
    proposedBy: ACTOR,
    proposedAt: stamp,
    idempotencyKey: 'idem-0001',
    ...o,
  }),
};

/** The whole governance chain, in dependency order — every parent is one of the eleven. */
async function foundGovernance(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('governedExecutions', record.execution({ id: k('ge-1'), workspaceId }));
    await store.append(
      'executionHistory',
      record.history({ id: k('eh-1'), workspaceId, executionId: k('ge-1') }),
    );
    await store.append(
      'governedMilestones',
      record.milestone({ id: k('gm-1'), workspaceId, executionId: k('ge-1') }),
    );
    await store.append(
      'governedMilestones',
      record.milestone({ id: k('gm-2'), workspaceId, executionId: k('ge-1'), title: 'Handover' }),
    );
    await store.append(
      'milestoneDependencies',
      record.dependency({
        id: k('md-1'),
        workspaceId,
        executionId: k('ge-1'),
        predecessorId: k('gm-1'),
        successorId: k('gm-2'),
      }),
    );
    await store.append(
      'dodVersions',
      record.definition({ id: k('dv-1'), workspaceId, milestoneId: k('gm-1') }),
    );
    await store.append(
      'dodEvaluations',
      record.evaluation({
        id: k('de-1'),
        workspaceId,
        milestoneId: k('gm-1'),
        definitionId: k('dv-1'),
      }),
    );
    await store.append(
      'certificationRequests',
      record.request({
        id: k('cr-1'),
        workspaceId,
        executionId: k('ge-1'),
        milestoneId: k('gm-1'),
        dodEvaluationId: k('de-1'),
      }),
    );
    await store.append(
      'certificationDecisions',
      record.decision({ id: k('cd-1'), workspaceId, certificationRequestId: k('cr-1') }),
    );
    await store.append(
      'digitalCertifications',
      record.certificate({
        id: k('dcr-1'),
        workspaceId,
        certificationRequestId: k('cr-1'),
        milestoneId: k('gm-1'),
      }),
    );
    await store.append(
      'paymentTriggerDefinitions',
      record.trigger({
        id: k('ptd-1'),
        workspaceId,
        milestoneId: k('gm-1'),
        requiredDodDefinitionId: k('dv-1'),
      }),
    );
    await store.append(
      'paymentAuthorizationProposals',
      record.proposal({
        id: k('pap-1'),
        workspaceId,
        triggerId: k('ptd-1'),
        milestoneId: k('gm-1'),
        certificationId: k('dcr-1'),
      }),
    );
    // A second proposal, blocked, so the release-path tests have a row that must never become authorised.
    await store.append(
      'paymentAuthorizationProposals',
      record.proposal({
        id: k('pap-blocked'),
        workspaceId,
        triggerId: k('ptd-1'),
        milestoneId: k('gm-1'),
        certificationId: undefined,
        status: 'BLOCKED',
        blockers: ['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED'],
        idempotencyKey: 'idem-blocked',
      }),
    );
  });
}

describe('integration: Batch H is activated and governance core becomes durable', () => {
  const seeded = sharedDatabase(foundGovernance);

  it('pairs all eleven contracts with a relational repository', () => {
    expect(Object.keys(BATCH_H_RELATIONS).sort()).toEqual(
      BATCH_H_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
  });

  it('requires all eleven tables at startup and routes to them', async () => {
    const database = await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_H_TABLES) {
      expect(required.has(table), table).toBe(true);
      expect(routed.has(table), table).toBe(true);
    }

    const present = await raw(database, (tx) =>
      tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `,
    );
    const names = new Set(present.map((row) => row.table_name));
    for (const table of BATCH_H_TABLES) expect(names.has(table), table).toBe(true);
  }, 300_000);

  it('keys every Batch H table as TEXT and forces row-level security', async () => {
    const database = await seeded();
    const uuid = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${BATCH_H_TABLES as string[]})
          AND data_type = 'uuid'
      `,
    );
    // Identity was UUID on all eleven while the trust runtime is TEXT throughout, so an `actor_id` or
    // `reviewer_id` column could not hold a trust principal.
    expect(uuid).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${BATCH_H_TABLES as string[]})
      `,
    );
    expect(security).toHaveLength(BATCH_H_TABLES.length);
    for (const row of security) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      // FORCE, not merely ENABLE: ENABLE does not constrain the table owner.
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  }, 300_000);

  it('stores and reads back all eleven aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      governedExecutions: await store.list('governedExecutions'),
      executionHistory: await store.list('executionHistory'),
      governedMilestones: await store.list('governedMilestones'),
      milestoneDependencies: await store.list('milestoneDependencies'),
      dodVersions: await store.list('dodVersions'),
      dodEvaluations: await store.list('dodEvaluations'),
      certificationRequests: await store.list('certificationRequests'),
      certificationDecisions: await store.list('certificationDecisions'),
      digitalCertifications: await store.list('digitalCertifications'),
      paymentTriggerDefinitions: await store.list('paymentTriggerDefinitions'),
      paymentAuthorizationProposals: await store.list('paymentAuthorizationProposals'),
    }));

    expect(seen.governedExecutions[0]).toEqual(record.execution());
    expect(seen.executionHistory[0]).toEqual(record.history());
    expect(seen.governedMilestones[0]).toEqual(record.milestone());
    expect(seen.milestoneDependencies[0]).toEqual(record.dependency());
    // The nested criteria survive the round trip, including the optional `rule` being absent.
    expect(seen.dodVersions[0]).toEqual(record.definition());
    expect(seen.dodEvaluations[0]).toEqual(record.evaluation());
    expect(seen.certificationRequests[0]).toEqual(record.request());
    expect(seen.certificationDecisions[0]).toEqual(record.decision());
    expect(seen.digitalCertifications[0]).toEqual(record.certificate());
    expect(seen.paymentTriggerDefinitions[0]).toEqual(record.trigger());
    expect(seen.paymentAuthorizationProposals[0]).toEqual(record.proposal());
  }, 300_000);
});

describe('integration: the release-authorisation path, closed', () => {
  const seeded = sharedDatabase(foundGovernance);

  it('refuses the one statement that authorised an uncertified release', async () => {
    const database = await seeded();
    // The defect, exactly as it was. `createEscrowReleaseIntent` reads a proposal, requires
    // `status === 'PROPOSED'`, and then instructs a certified Financial Provider. No engine ever updates a
    // proposal, and until `202608110011` nothing in the database said so — so this statement turned
    // "definition of done not satisfied, certification required" into an authorised release.
    const failure = await raw(database, (tx) =>
      tx`UPDATE payment_authorization_proposals
         SET status = 'PROPOSED', blockers = '[]'::jsonb
         WHERE id = 'pap-blocked'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('append-only');

    // And the row is unchanged, which is the part that matters: the refusal is not a partial application.
    const [blocked] = await as(database, (store) =>
      store
        .list<{ id: string; status: string; blockers: string[] }>('paymentAuthorizationProposals')
        .then((rows) => rows.filter((row) => row.id === 'pap-blocked')),
    );
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockers).toEqual(['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED']);
  }, 300_000);

  it('refuses a proposal written incoherent in the first place', async () => {
    const database = await seeded();
    // The trigger stops an existing row being edited; this CHECK stops one being *created* saying it is
    // clear while carrying the reasons it is not.
    const failure = await raw(database, (tx) =>
      tx`INSERT INTO payment_authorization_proposals
           (id, tenant_id, workspace_id, trigger_id, milestone_id, amount_minor, currency, status,
            blockers, proposed_by, proposed_at, idempotency_key, schema_version, updated_at)
         VALUES ('pap-lying', ${TENANT}, ${WORKSPACE}, 'ptd-1', 'gm-1', 1000, 'NGN', 'PROPOSED',
                 '["DOD_NOT_SATISFIED"]'::jsonb, ${ACTOR}, ${stamp}, 'idem-lying', 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('blockers_follow_status');

    const reverse = await raw(database, (tx) =>
      tx`INSERT INTO payment_authorization_proposals
           (id, tenant_id, workspace_id, trigger_id, milestone_id, amount_minor, currency, status,
            blockers, proposed_by, proposed_at, idempotency_key, schema_version, updated_at)
         VALUES ('pap-mute', ${TENANT}, ${WORKSPACE}, 'ptd-1', 'gm-1', 1000, 'NGN', 'BLOCKED',
                 '[]'::jsonb, ${ACTOR}, ${stamp}, 'idem-mute', 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    // Blocked, but by nothing, is a proposal a reader cannot act on either way.
    expect(String(reverse)).toContain('blockers_follow_status');
  }, 300_000);

  it('refuses flipping a definition-of-done evaluation to passed', async () => {
    const database = await seeded();
    // `PaymentTriggerEngine.evaluate` reads `mandatory_passed` alone to decide whether DOD_NOT_SATISFIED
    // blocks the release, so a mutable evaluation manufactures a satisfied definition of done.
    const failure = await raw(database, (tx) =>
      tx`UPDATE dod_evaluations SET mandatory_passed = true WHERE id = 'de-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('append-only');
  }, 300_000);

  it('refuses changing the amount a trigger releases', async () => {
    const database = await seeded();
    // `propose()` copies the trigger's amount onto the proposal, so a mutable trigger changes what future
    // proposals authorise.
    const failure = await raw(database, (tx) =>
      tx`UPDATE payment_trigger_definitions SET amount_minor = 9_000_000 WHERE id = 'ptd-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('append-only');
  }, 300_000);

  it('refuses editing the criteria of a published definition of done', async () => {
    const database = await seeded();
    // A published definition is the standard the release turns on. Editable criteria are a bar that can be
    // lowered to match the result — governed rather than append-only, because publishing is a real
    // transition, so the criteria are named immutable instead.
    const failure = await raw(database, (tx) =>
      tx`UPDATE dod_versions SET criteria = '[]'::jsonb, row_version = row_version + 1 WHERE id = 'dv-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(failure)).toContain('criteria');

    const revision = await raw(database, (tx) =>
      tx`UPDATE dod_versions SET version = 9, row_version = row_version + 1 WHERE id = 'dv-1'`,
    ).catch((caught: unknown) => caught);
    // `version` here is the revision the definition *is*, not a row counter, so it cannot move either.
    expect(String(revision)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(revision)).toContain('version');
  }, 300_000);

  it('refuses deleting any of the seven append-only aggregates', async () => {
    const database = await seeded();
    expect([...BATCH_H_APPEND_ONLY_COLLECTIONS]).toHaveLength(7);
    for (const table of [
      'execution_history',
      'milestone_dependencies',
      'dod_evaluations',
      'certification_decisions',
      'digital_certification_records',
      'payment_trigger_definitions',
      'payment_authorization_proposals',
    ] as const) {
      const failure = await raw(database, (tx) =>
        tx.unsafe(`DELETE FROM ${table} WHERE true`),
      ).catch((caught: unknown) => caught);
      // Withholding DELETE from the runtime role is the other half; the trigger is what an operator who
      // granted it in a hurry still cannot get past.
      expect(String(failure), table).toContain('append-only');
    }
  }, 300_000);

  it('reports the store’s own refusal for an append-only collection', async () => {
    const database = await seeded();
    const refused = await as(database, (store) =>
      store
        .replace('paymentAuthorizationProposals', record.proposal({ status: 'BLOCKED', blockers: ['X'] }))
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
  }, 300_000);
});

describe('integration: Batch H governed transitions', () => {
  const seeded = sharedDatabase(foundGovernance);

  it('advances an execution through its domain version, not a second counter', async () => {
    const database = await seeded();
    expect([...BATCH_H_DOMAIN_VERSION_IS_CONCURRENCY].sort()).toEqual([
      'certificationRequests',
      'governedExecutions',
      'governedMilestones',
    ]);

    // The engine writes `version + 1` on every transition, so the domain field *is* the concurrency
    // counter and the governed trigger's default is exactly right. A `row_version` beside it would be a
    // second counter nothing maintains.
    await as(database, (store) =>
      store.replace(
        'governedExecutions',
        record.execution({ state: 'COMPLETED', completedAt: stamp, version: 3 }),
      ),
    );
    const [execution] = await as(database, (store) =>
      store.list<{ state: string; version: number }>('governedExecutions'),
    );
    expect(execution.state).toBe('COMPLETED');
    expect(execution.version).toBe(3);
  }, 300_000);

  it('refuses a transition that does not advance the domain version', async () => {
    const database = await seeded();
    const stale = await raw(database, (tx) =>
      tx`UPDATE governed_milestones SET state = 'COMPLETED' WHERE id = 'gm-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(stale)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
    expect(String(stale)).toContain('version');
  }, 300_000);

  it('refuses reassigning an execution to another contract, or a milestone to another duration', async () => {
    const database = await seeded();
    const reassigned = await raw(database, (tx) =>
      tx`UPDATE governed_executions SET contract_id = 'c-2', version = version + 1 WHERE id = 'ge-1'`,
    ).catch((caught: unknown) => caught);
    // A completed execution moved to a different agreement would take its whole history with it.
    expect(String(reassigned)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(reassigned)).toContain('contract_id');

    const restretched = await raw(database, (tx) =>
      tx`UPDATE governed_milestones SET duration_days = 90, version = version + 1 WHERE id = 'gm-1'`,
    ).catch((caught: unknown) => caught);
    // `project()` computes the schedule from this, so a mutable duration moves a date others depend on.
    expect(String(restretched)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(restretched)).toContain('duration_days');
  }, 300_000);

  it('refuses changing the evidence or the requester a certification rests on', async () => {
    const database = await seeded();
    for (const column of ['dod_evaluation_id', 'requested_by'] as const) {
      const failure = await raw(database, (tx) =>
        column === 'dod_evaluation_id'
          ? tx`UPDATE certification_requests SET dod_evaluation_id = 'de-2', version = version + 1
               WHERE id = 'cr-1'`
          : tx`UPDATE certification_requests SET requested_by = 'user-someone-else',
               version = version + 1 WHERE id = 'cr-1'`,
      ).catch((caught: unknown) => caught);
      // The evaluation is the evidence; the requester is half of the rule that stops self-certification.
      expect(String(failure), column).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
      expect(String(failure), column).toContain(column);
    }
  }, 300_000);
});

describe('integration: Batch H invariants the schema alone cannot carry', () => {
  const seeded = sharedDatabase(foundGovernance);

  it('refuses a self-certifying request', async () => {
    const database = await seeded();
    const failure = await raw(database, (tx) =>
      tx`INSERT INTO certification_requests
           (id, tenant_id, workspace_id, execution_id, milestone_id, dod_evaluation_id, requested_by,
            status, reviewer_ids, created_at, updated_at, version, schema_version)
         VALUES ('cr-self', ${TENANT}, ${WORKSPACE}, 'ge-1', 'gm-1', 'de-1', ${ACTOR}, 'PENDING',
                 '["user-owner"]'::jsonb, ${stamp}, ${stamp}, 1, 1)`,
    ).catch((caught: unknown) => caught);
    // Certification is the point at which work becomes payable, so self-review is the shape of an unearned
    // release.
    expect(String(failure)).toContain('reviewer_is_independent');
  }, 300_000);

  it('refuses an execution that completed without starting', async () => {
    const database = await seeded();
    const failure = await raw(database, (tx) =>
      tx`INSERT INTO governed_executions
           (id, tenant_id, workspace_id, contract_id, title, owner_user_id, state, started_at,
            completed_at, created_at, updated_at, version, schema_version)
         VALUES ('ge-ghost', ${TENANT}, ${WORKSPACE}, 'c-9', 'x', ${ACTOR}, 'COMPLETED', NULL,
                 ${stamp}, ${stamp}, ${stamp}, 1, 1)`,
    ).catch((caught: unknown) => caught);
    expect(String(failure)).toContain('completion_follows_start');
  }, 300_000);

  it('refuses a published definition with no publication time, and an evaluation with no results', async () => {
    const database = await seeded();
    const unpublished = await raw(database, (tx) =>
      tx`INSERT INTO dod_versions
           (id, tenant_id, workspace_id, milestone_id, version, status, criteria, created_by, created_at,
            published_at, content_hash, row_version, schema_version, updated_at)
         VALUES ('dv-nopub', ${TENANT}, ${WORKSPACE}, 'gm-1', 2, 'PUBLISHED', '[]'::jsonb, ${ACTOR},
                 ${stamp}, NULL, ${HASH}, 1, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    expect(String(unpublished)).toContain('published_at_follows_status');

    const empty = await raw(database, (tx) =>
      tx`INSERT INTO dod_evaluations
           (id, tenant_id, workspace_id, milestone_id, definition_id, results, mandatory_passed,
            manual_review_required, evidence_references, evaluated_by, evaluated_at, schema_version,
            updated_at)
         VALUES ('de-empty', ${TENANT}, ${WORKSPACE}, 'gm-1', 'dv-1', '[]'::jsonb, true, false,
                 '[]'::jsonb, ${ACTOR}, ${stamp}, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    // `mandatory_passed` over an empty set is a satisfied definition of done with no evidence at all.
    expect(String(empty)).toContain('has_results');
  }, 300_000);

  it('refuses a self-parent, a self-dependency and zero-day work', async () => {
    const database = await seeded();
    const selfParent = await raw(database, (tx) =>
      tx`UPDATE governed_milestones SET parent_milestone_id = id, version = version + 1
         WHERE id = 'gm-1'`,
    ).catch((caught: unknown) => caught);
    expect(String(selfParent)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const selfEdge = await raw(database, (tx) =>
      tx`INSERT INTO milestone_dependencies
           (id, tenant_id, workspace_id, execution_id, predecessor_id, successor_id, dependency_type,
            created_at, schema_version, updated_at)
         VALUES ('md-self', ${TENANT}, ${WORKSPACE}, 'ge-1', 'gm-1', 'gm-1', 'FINISH_TO_START',
                 ${stamp}, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    // A milestone that cannot start until it finishes is a permanent block that reads as an ordinary one.
    // `milestone_dependencies_check` is the historical unnamed CHECK from `202608030006`, which this batch
    // deliberately keeps: it already says exactly the right thing, and renaming it would churn a
    // constraint for the sake of its name.
    expect(String(selfEdge)).toContain('milestone_dependencies_check');

    const zeroDay = await raw(database, (tx) =>
      tx`INSERT INTO governed_milestones
           (id, tenant_id, workspace_id, execution_id, title, owner_user_id, state, duration_days,
            created_at, updated_at, version, schema_version)
         VALUES ('gm-zero', ${TENANT}, ${WORKSPACE}, 'ge-1', 'x', ${ACTOR}, 'PLANNED', 0, ${stamp},
                 ${stamp}, 1, 1)`,
    ).catch((caught: unknown) => caught);
    expect(String(zeroDay)).toContain('duration_is_positive');
  }, 300_000);
});

describe('integration: Batch H tenancy, and the keys 202608110010 deferred here', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundGovernance(database);
    await foundGovernance(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
  });

  it('shows another tenant only its own certificates', async () => {
    const database = await seeded();
    const seen = await as(
      database,
      (store) => store.list<{ id: string }>('digitalCertifications'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(seen.map((row) => row.id)).toEqual(['dcr-1-other']);
  }, 300_000);

  it('lets two tenants issue the same certificate number, which a global key had prevented', async () => {
    const database = await seeded();
    // `202608110010` scoped six tenant-blind keys and left the rest to the batch that activates them; this
    // is that batch. `digital_certification_records_certificate_number_key` was global, and the engine
    // numbers certificates by counting its own rows — so every tenant produces AP-CERT-2026-000001 and only
    // the first could store it. Both seeds above did, which is the proof.
    const numbers = await raw(database, (tx) =>
      tx<{ certificate_number: string }[]>`
        SELECT certificate_number FROM digital_certification_records
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(numbers.map((row) => row.certificate_number)).toEqual(['AP-CERT-2026-000001']);

    // Still unique within a tenant and workspace, so the key was narrowed rather than dropped.
    const duplicate = await raw(database, (tx) =>
      tx`INSERT INTO digital_certification_records
           (id, tenant_id, workspace_id, certification_request_id, milestone_id, certificate_number,
            canonical_hash, status, issued_by, issued_at, schema_version, updated_at)
         VALUES ('dcr-dup', ${TENANT}, ${WORKSPACE}, 'cr-1', 'gm-1', 'AP-CERT-2026-000001',
                 ${'c'.repeat(64)}, 'CERTIFIED', ${ACTOR}, ${stamp}, 1, ${stamp})`,
    ).catch((caught: unknown) => caught);
    expect(String(duplicate)).toMatch(/ws_number_unique|ws_request_unique/);
  }, 300_000);

  it('refuses a child row referencing a parent in another tenant', async () => {
    const database = await seeded();
    const failure = await raw(
      database,
      (tx) => tx`
        INSERT INTO execution_history
          (id, tenant_id, workspace_id, execution_id, from_state, to_state, actor_id, reason, sequence,
           occurred_at, schema_version, updated_at)
        VALUES ('eh-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'ge-1', 'PLANNED', 'ACTIVE', ${ACTOR},
                'x', 9, ${stamp}, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    // `ge-1` exists, in the other tenant. Foreign key checks run as the table owner and are not subject to
    // row-level security, so only the composite key closes this.
    expect(String(failure)).toContain('execution_history_execution_fk');
  }, 300_000);
});
