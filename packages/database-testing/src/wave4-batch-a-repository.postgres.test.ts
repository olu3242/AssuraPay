import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_A_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import { BATCH_A_AGGREGATES } from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch A persists to its own tables, and the database governs what may change.
 *
 * Before this capability `PostgresTrustStore` refused all sixteen Engine 31-40 collections —
 * they are absent from `GOVERNED_DOCUMENTS`, so an execution workspace, a defect or a completion
 * certificate could not be written to PostgreSQL at all. These suites prove the activation
 * against a live instance, and they prove the *refusals*, because a boundary that admits
 * everything satisfies every happy-path assertion here.
 *
 * One database, migrated once, shared across the read-only structural assertions. The suites that
 * write take their own, because a shared one would make each test depend on what the previous
 * ones inserted — and the uniqueness assertions are precisely about what a second insert does.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-batch-a';
const OTHER_TENANT = 'tenant-other';
const WORKSPACE = 'workspace-batch-a';
const OTHER_WORKSPACE = 'workspace-other';
const ACTOR = 'user-1';

const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), {
    appliedBy: 'integration-test',
  });
  return database;
}

/**
 * Founds two tenants and a workspace each, through the store's own workspace path.
 *
 * `trustWorkspaces` is a dedicated trust collection, so this uses the real write path rather
 * than seeding rows behind the policies — the Batch A foreign keys point at whatever it creates,
 * and a fixture that inserted them directly could satisfy a key the application could not.
 */
async function foundTenancy(database: TestDatabase): Promise<void> {
  const store = new PostgresTrustStore(database.sql);
  for (const [tenantId, workspaceId] of [
    [TENANT, WORKSPACE],
    [OTHER_TENANT, OTHER_WORKSPACE],
  ]) {
    await withTrustScope(
      { tenantId, workspaceId, actorId: ACTOR },
      async () => {
        await store.append('trustWorkspaces', {
          id: workspaceId,
          tenantId,
          status: 'ACTIVE',
          version: 1,
        });
      },
    );
  }
}

/** A store, and a helper that runs work inside a tenant scope. */
function scoped(database: TestDatabase) {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return {
    store,
    as: <T>(
      tenantId: string,
      workspaceId: string,
      work: (store: TrustPersistence) => Promise<T>,
    ) =>
      withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () =>
        work(store),
      ),
  };
}

const stamp = '2026-08-10T09:00:00.000Z';

function executionWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    workspaceId: WORKSPACE,
    blueprintId: 'bp-1',
    milestoneId: 'ms-1',
    status: 'DRAFT',
    createdAt: stamp,
    ...overrides,
  };
}

describe('integration: every Batch A aggregate has a repository and a required table', () => {
  it('pairs all sixteen contracts with a relational repository', () => {
    // The module asserts this at load; restating it here makes the count evidence rather than
    // an internal invariant nobody reports.
    expect(Object.keys(BATCH_A_RELATIONS)).toHaveLength(16);
    expect(BATCH_A_AGGREGATES).toHaveLength(16);
    for (const aggregate of BATCH_A_AGGREGATES) {
      const relation = BATCH_A_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('treats the sixteen tables as a readiness requirement', async () => {
    // A store that routes a collection to a table it does not require at startup discovers the
    // absence on the first write, having already reported the host ready.
    expect([...REQUIRED_DOMAIN_AGGREGATE_TABLES]).toEqual(
      [...BATCH_A_AGGREGATES.map((aggregate) => aggregate.table)].sort(),
    );

    const database = await migratedDatabase();
    const compatible = await verifySchemaCompatibility(
      database.sql,
      migrationsDirectory(),
    );
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);

    await database.sql.unsafe('DROP TABLE completion_certificates CASCADE');
    const degraded = await verifySchemaCompatibility(
      database.sql,
      migrationsDirectory(),
    );
    expect(degraded.missingTables).toEqual(['completion_certificates']);
    expect(degraded.compatible).toBe(false);
  }, 300_000);
});

describe('integration: Batch A round-trips through its own columns', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
  }, 300_000);

  it('writes and reads an aggregate with no payload blob', async () => {
    const { as } = scoped(database);
    const record = executionWorkspace();

    await as(TENANT, WORKSPACE, async (store) => {
      await store.append('executionWorkspaces', record);
    });

    // Read back through the store, and separately from the columns, so the assertion is that
    // the *columns* hold the aggregate rather than that a JSON blob survived a round trip.
    const read = await as(TENANT, WORKSPACE, (store) =>
      store.list<Record<string, unknown>>('executionWorkspaces'),
    );
    expect(read).toEqual([record]);

    const [row] = await rawInScope(
      database,
      (tx) => tx<Record<string, unknown>[]>`
      SELECT tenant_id, workspace_id, blueprint_id, milestone_id, status, version, schema_version
      FROM execution_workspaces WHERE id = ${'exec-1'}
    `,
    );
    expect(row).toEqual({
      tenant_id: TENANT,
      workspace_id: WORKSPACE,
      blueprint_id: 'bp-1',
      milestone_id: 'ms-1',
      status: 'DRAFT',
      version: 1,
      schema_version: 1,
    });
  }, 300_000);

  it('takes the tenant from the ambient scope, not from the record', async () => {
    // None of the sixteen domain types carries a tenantId. The row must still be owned, and the
    // only source that cannot disagree with the policies is the scope they read.
    const [row] = await rawInScope(
      database,
      (tx) => tx<{ tenant_id: string }[]>`
      SELECT tenant_id FROM execution_workspaces WHERE id = ${'exec-1'}
    `,
    );
    expect(row.tenant_id).toBe(TENANT);
    expect(Object.keys(executionWorkspace())).not.toContain('tenantId');
  }, 300_000);

  it('refuses a write with no established scope', async () => {
    const store = new PostgresTrustStore(database.sql);
    const error = await store
      .append(
        'executionWorkspaces',
        executionWorkspace({ id: 'exec-unscoped' }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgresStoreError);
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_SCOPE_INVALID',
    );
  }, 300_000);

  it('refuses a record belonging to a workspace other than the caller scope', async () => {
    const { as } = scoped(database);
    const error = await as(TENANT, WORKSPACE, (store) =>
      store
        .append(
          'executionWorkspaces',
          executionWorkspace({
            id: 'exec-smuggled',
            workspaceId: OTHER_WORKSPACE,
          }),
        )
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_SCOPE_INVALID',
    );
  }, 300_000);

  it('shows another tenant nothing', async () => {
    const { as } = scoped(database);
    const read = await as(OTHER_TENANT, OTHER_WORKSPACE, (store) =>
      store.list<Record<string, unknown>>('executionWorkspaces'),
    );
    expect(read).toEqual([]);
  }, 300_000);

  it('round-trips a calendar date without moving it', async () => {
    // `scheduled_for` is a DATE. Rebuilding it from a driver `Date` means choosing a zone to
    // read it in, which is how a scheduled inspection lands a day early on one host.
    const { as } = scoped(database);
    const inspection = {
      id: 'insp-1',
      workspaceId: WORKSPACE,
      workItemId: 'wi-x',
      scheduledFor: '2026-08-10',
      checklist: [{ item: 'weld-quality', required: true }],
      findings: [],
      status: 'SCHEDULED',
      passed: false,
      createdAt: stamp,
    };
    await as(TENANT, WORKSPACE, async (store) => {
      await store.append('inspections', inspection);
    });
    const read = await as(TENANT, WORKSPACE, (store) =>
      store.list<Record<string, unknown>>('inspections'),
    );
    expect(read).toEqual([inspection]);
  }, 300_000);

  it('round-trips numeric and bigint money columns as numbers', async () => {
    // `percent_complete` is NUMERIC and `earned_value_amount_minor` is BIGINT; both arrive from
    // the driver as strings, so this is a conversion rather than a cast.
    const { as } = scoped(database);
    await as(TENANT, WORKSPACE, async (store) => {
      await store.append('workItems', {
        id: 'wi-1',
        workspaceId: WORKSPACE,
        executionWorkspaceId: 'exec-1',
        deliverableId: 'del-1',
        title: 'Pour foundation',
        assigneeId: 'crew-1',
        status: 'IN_PROGRESS',
        createdAt: stamp,
        updatedAt: stamp,
      });
      await store.append('progressRecords', {
        id: 'prog-1',
        workspaceId: WORKSPACE,
        workItemId: 'wi-1',
        stage: 'DECLARED',
        percentComplete: 42.5,
        earnedValueAmountMinor: 125_000_00,
        reportedBy: ACTOR,
        createdAt: stamp,
      });
    });

    const [record] = await as(TENANT, WORKSPACE, (store) =>
      store.list<{ percentComplete: number; earnedValueAmountMinor: number }>(
        'progressRecords',
      ),
    );
    expect(record.percentComplete).toBe(42.5);
    expect(record.earnedValueAmountMinor).toBe(12_500_000);
  }, 300_000);

  it('omits an absent optional field rather than reading it back as null', async () => {
    const [record] = await as0(database, (store) =>
      store.list<Record<string, unknown>>('progressRecords'),
    );
    // `earnedValueAmountMinor` is set above, so a different aggregate carries the assertion.
    await as0(database, async (store) => {
      await store.append('evidenceRequirements', {
        id: 'req-1',
        workspaceId: WORKSPACE,
        deliverableId: 'del-1',
        kind: 'PHOTO',
        description: 'Site photograph',
        mandatory: true,
        createdAt: stamp,
      });
      await store.append('defects', {
        id: 'def-1',
        workspaceId: WORKSPACE,
        workItemId: 'wi-1',
        severity: 'MINOR',
        description: 'Hairline crack',
        status: 'OPEN',
        raisedBy: ACTOR,
        createdAt: stamp,
      });
    });
    const [defect] = await as0(database, (store) =>
      store.list<Record<string, unknown>>('defects'),
    );
    expect(record).toBeDefined();
    expect(Object.hasOwn(defect, 'rootCause')).toBe(false);
    expect(Object.hasOwn(defect, 'resolvedAt')).toBe(false);
  }, 300_000);
});

/**
 * Raw SQL under a tenant scope.
 *
 * Every Batch A table forces row-level security, so a verification query on the pool's own
 * connection reads nothing at all — which is the correct behaviour and not a useful assertion.
 * A column the store does not return has to be inspected from inside a scope, exactly as the
 * store does it.
 */
function rawInScope<T>(
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

/** The default scope, for tests that do not vary it. */
function as0<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope(
    { tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR },
    () => work(store),
  );
}

describe('integration: the schema is enforced at the store boundary', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
  }, 300_000);

  it('refuses a record with an unknown field rather than dropping it', async () => {
    // Every schema is strict. A relational writer has a column per field and would silently
    // discard anything it did not recognise, so a permissive schema turns an added field into
    // data loss discoverable only by its absence.
    const error = await as0(database, (store) =>
      store
        .append('executionWorkspaces', {
          ...executionWorkspace({ id: 'exec-extra' }),
          smuggled: 'x',
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_SCHEMA_VIOLATION',
    );
  }, 300_000);

  it('refuses an ISO datetime where the aggregate means a calendar date', async () => {
    // The DATE column would accept it and discard the time. Silent coercion is what the accepted
    // schema-authority decision forbids.
    const error = await as0(database, (store) =>
      store
        .append('inspections', {
          id: 'insp-bad',
          workspaceId: WORKSPACE,
          workItemId: 'wi-x',
          scheduledFor: '2026-08-10T13:45:00.000Z',
          checklist: [{ item: 'x', required: true }],
          findings: [],
          status: 'SCHEDULED',
          passed: false,
          createdAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_SCHEMA_VIOLATION',
    );
    expect((error as PostgresStoreError).detail).toContain('scheduledFor');
  }, 300_000);

  it('names the failing field without quoting its value', async () => {
    // These records carry evidence references, actor identities and narrative text. A Zod message
    // quotes the offending value; the store must not.
    const error = await as0(database, (store) =>
      store
        .append('defects', {
          id: 'def-secret',
          workspaceId: WORKSPACE,
          workItemId: 'wi-x',
          severity: 'CATASTROPHIC-token-abcdef',
          description: 'x',
          status: 'OPEN',
          raisedBy: ACTOR,
          createdAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    const message = (error as PostgresStoreError).message;
    expect(message).toContain('severity');
    expect(message).not.toContain('token-abcdef');
  }, 300_000);

  it('refuses a stored row written at an unsupported schema version', async () => {
    // An unknown version must fail into an explicit result rather than a best-effort parse: a
    // release gate reading a mis-parsed acceptance decision would approve on a field it invented.
    //
    // Inserted at the future version rather than updated to it, because `schema_version` is one of
    // the immutable facts the governed-transition trigger protects — the row cannot be edited into
    // this state, which is the correct rule and means the fixture has to be created in it. That is
    // also the real scenario: a newer build writes version 2 and this one reads it.
    await rawInScope(
      database,
      (tx) => tx`
      INSERT INTO execution_workspaces
        (id, tenant_id, workspace_id, blueprint_id, milestone_id, status, created_at,
         version, schema_version, updated_at)
      VALUES ('exec-future', ${TENANT}, ${WORKSPACE}, 'bp-f', 'ms-future', 'DRAFT', ${stamp},
              1, 99, ${stamp})
    `,
    );

    const error = await as0(database, (store) =>
      store.list('executionWorkspaces').catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(PostgresStoreError);
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
    );
  }, 300_000);
});

describe('integration: the database governs which changes a transition may make', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
    await as0(database, async (store) => {
      await store.append(
        'executionWorkspaces',
        executionWorkspace({ status: 'ACTIVE' }),
      );
    });
  }, 300_000);

  it('permits the lifecycle transition its canonical engine performs', async () => {
    // The blanket append-only trigger would have refused this, which is why five of them were
    // replaced. `SUSPENDED` is a state ExecutionOrchestrationEngine.suspend reaches.
    await as0(database, async (store) => {
      await store.replace(
        'executionWorkspaces',
        executionWorkspace({ status: 'SUSPENDED' }),
      );
    });
    const [record] = await as0(database, (store) =>
      store.list<{ status: string }>('executionWorkspaces'),
    );
    expect(record.status).toBe('SUSPENDED');

    const [row] = await rawInScope(
      database,
      (tx) => tx<{ version: number }[]>`
      SELECT version FROM execution_workspaces WHERE id = ${'exec-1'}
    `,
    );
    expect(row.version).toBe(2);
  }, 300_000);

  it('refuses a change to a recorded fact', async () => {
    const error = await database.sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
        await tx`
          UPDATE execution_workspaces
          SET blueprint_id = 'rewritten', version = version + 1
          WHERE id = ${'exec-1'}
        `;
      })
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');
    expect(String(error)).toContain('blueprint_id');
  }, 300_000);

  it('refuses a DELETE', async () => {
    const error = await database.sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
        await tx`DELETE FROM execution_workspaces WHERE id = ${'exec-1'}`;
      })
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('refuses a version that does not advance', async () => {
    const error = await database.sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
        await tx`UPDATE execution_workspaces SET status = 'ACTIVE' WHERE id = ${'exec-1'}`;
      })
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
  }, 300_000);

  it('refuses any change once the lifecycle reaches a terminal state', async () => {
    await as0(database, async (store) => {
      await store.replace(
        'executionWorkspaces',
        executionWorkspace({ status: 'ACTIVE' }),
      );
      await store.replace(
        'executionWorkspaces',
        executionWorkspace({ status: 'SUBMITTED' }),
      );
    });

    const error = await as0(database, (store) =>
      store
        .replace(
          'executionWorkspaces',
          executionWorkspace({ status: 'ACTIVE' }),
        )
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_HISTORY_IMMUTABLE',
    );
    expect((error as PostgresStoreError).detail).toContain(
      'AGGREGATE_STATE_IS_TERMINAL',
    );
  }, 300_000);

  it('keeps the six untransitioned aggregates append-only, in the store and in the database', async () => {
    // Both, independently. The store refuses to issue the statement; the trigger refuses it if
    // anything else does.
    const appendOnly = Object.values(BATCH_A_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    expect(appendOnly).toEqual([
      'changeApprovals',
      'evidenceRequirements',
      'progressRecords',
      'qualityGateResults',
      'qualityPlans',
      'validationTests',
    ]);

    await as0(database, async (store) => {
      await store.append('evidenceRequirements', {
        id: 'req-append-only',
        workspaceId: WORKSPACE,
        deliverableId: 'del-1',
        kind: 'PHOTO',
        description: 'Site photograph',
        mandatory: true,
        createdAt: stamp,
      });
    });

    const refused = await as0(database, (store) =>
      store
        .replace('evidenceRequirements', {
          id: 'req-append-only',
          workspaceId: WORKSPACE,
          deliverableId: 'del-1',
          kind: 'PHOTO',
          description: 'Rewritten',
          mandatory: true,
          createdAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe(
      'PERSISTENCE_HISTORY_IMMUTABLE',
    );

    const byDatabase = await database.sql
      .begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
        await tx`
          UPDATE evidence_requirements SET description = 'Rewritten'
          WHERE id = ${'req-append-only'}
        `;
      })
      .catch((caught: unknown) => caught);
    expect(String(byDatabase)).toContain('append-only table');
  }, 300_000);
});

describe('integration: natural uniqueness is enforced per workspace', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundTenancy(database);
  }, 300_000);

  it('lets two workspaces execute the same milestone identifier', async () => {
    // `UNIQUE (milestone_id)` was global, so the second tenant could never have executed against
    // a milestone identifier the first had used.
    await as0(database, async (store) => {
      await store.append(
        'executionWorkspaces',
        executionWorkspace({ id: 'exec-a' }),
      );
    });
    await withTrustScope(
      { tenantId: OTHER_TENANT, workspaceId: OTHER_WORKSPACE, actorId: ACTOR },
      async () => {
        const store = new PostgresTrustStore(database.sql);
        await store.append(
          'executionWorkspaces',
          executionWorkspace({ id: 'exec-b', workspaceId: OTHER_WORKSPACE }),
        );
      },
    );

    // Both inserts succeeded, which is the whole property: the global constraint would have
    // refused the second. Asserted per scope rather than with an unscoped count, because FORCE
    // RLS means no single connection can see both rows — and that is also correct.
    const mine = await as0(database, (store) =>
      store.list<{ id: string; milestoneId: string }>('executionWorkspaces'),
    );
    expect(mine.map((row) => row.id)).toEqual(['exec-a']);

    const theirs = await withTrustScope(
      { tenantId: OTHER_TENANT, workspaceId: OTHER_WORKSPACE, actorId: ACTOR },
      () =>
        new PostgresTrustStore(database.sql).list<{
          id: string;
          milestoneId: string;
        }>('executionWorkspaces'),
    );
    expect(theirs.map((row) => row.id)).toEqual(['exec-b']);
    expect([...mine, ...theirs].map((row) => row.milestoneId)).toEqual([
      'ms-1',
      'ms-1',
    ]);
  }, 300_000);

  it('refuses a second execution workspace for the same milestone in one workspace', async () => {
    const error = await as0(database, (store) =>
      store
        .append(
          'executionWorkspaces',
          executionWorkspace({ id: 'exec-duplicate' }),
        )
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_DUPLICATE_RECORD',
    );
  }, 300_000);

  it('lets two workspaces both issue CERT-000001', async () => {
    // The engine numbers certificates per workspace, so a global unique constraint would have
    // failed the second workspace's first certificate.
    for (const [tenantId, workspaceId, id] of [
      [TENANT, WORKSPACE, 'cert-a'],
      [OTHER_TENANT, OTHER_WORKSPACE, 'cert-b'],
    ]) {
      await withTrustScope(
        { tenantId, workspaceId, actorId: ACTOR },
        async () => {
          const store = new PostgresTrustStore(database.sql);
          await store.append('acceptanceDecisions', {
            id: `accept-${id}`,
            workspaceId,
            workItemId: `wi-${id}`,
            decision: 'FULL',
            rationale: 'Meets every criterion',
            conditions: [],
            status: 'ACTIVE',
            decidedBy: ACTOR,
            decidedAt: stamp,
          });
          await store.append('completionCertificates', {
            id,
            workspaceId,
            workItemId: `wi-${id}`,
            milestoneId: 'ms-1',
            certificateNumber: 'CERT-000001',
            acceptanceDecisionId: `accept-${id}`,
            canonicalHash: 'a'.repeat(64),
            status: 'CERTIFIED',
            issuedBy: ACTOR,
            issuedAt: stamp,
          });
        },
      );
    }

    for (const [tenantId, workspaceId, id] of [
      [TENANT, WORKSPACE, 'cert-a'],
      [OTHER_TENANT, OTHER_WORKSPACE, 'cert-b'],
    ]) {
      const seen = await withTrustScope(
        { tenantId, workspaceId, actorId: ACTOR },
        () =>
          new PostgresTrustStore(database.sql).list<{
            id: string;
            certificateNumber: string;
          }>('completionCertificates'),
      );
      expect(seen.map((row) => [row.id, row.certificateNumber])).toEqual([
        [id, 'CERT-000001'],
      ]);
    }
  }, 300_000);

  it('refuses a second CERTIFIED certificate for one work item', async () => {
    // CERTIFICATE_ALREADY_ISSUED, in the database. The engine counts CERTIFIED rows before
    // issuing, which two concurrent requests both pass.
    const error = await as0(database, (store) =>
      store
        .append('completionCertificates', {
          id: 'cert-second',
          workspaceId: WORKSPACE,
          workItemId: 'wi-cert-a',
          milestoneId: 'ms-1',
          certificateNumber: 'CERT-000002',
          acceptanceDecisionId: 'accept-cert-a',
          canonicalHash: 'b'.repeat(64),
          status: 'CERTIFIED',
          issuedBy: ACTOR,
          issuedAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_DUPLICATE_RECORD',
    );
  }, 300_000);

  it('refuses a second ACTIVE acceptance decision for one work item', async () => {
    const error = await as0(database, (store) =>
      store
        .append('acceptanceDecisions', {
          id: 'accept-second',
          workspaceId: WORKSPACE,
          workItemId: 'wi-cert-a',
          decision: 'PARTIAL',
          rationale: 'Second opinion',
          conditions: [],
          status: 'ACTIVE',
          decidedBy: ACTOR,
          decidedAt: stamp,
        })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe(
      'PERSISTENCE_DUPLICATE_RECORD',
    );
  }, 300_000);

  it('admits the replacement once the prior decision is superseded', async () => {
    // Which is what makes supersession a transition rather than an insert: the partial unique
    // index permits one ACTIVE decision per work item, so the prior one has to move first.
    await as0(database, async (store) => {
      await store.replace('acceptanceDecisions', {
        id: 'accept-cert-a',
        workspaceId: WORKSPACE,
        workItemId: 'wi-cert-a',
        decision: 'FULL',
        rationale: 'Meets every criterion',
        conditions: [],
        status: 'SUPERSEDED',
        decidedBy: ACTOR,
        decidedAt: stamp,
      });
      await store.append('acceptanceDecisions', {
        id: 'accept-replacement',
        workspaceId: WORKSPACE,
        workItemId: 'wi-cert-a',
        decision: 'PARTIAL',
        rationale: 'Revised after reinspection',
        conditions: [],
        status: 'ACTIVE',
        decidedBy: ACTOR,
        decidedAt: stamp,
        supersedesId: 'accept-cert-a',
      });
    });

    const active = await rawInScope(
      database,
      (tx) => tx<{ id: string }[]>`
      SELECT id FROM acceptance_decisions
      WHERE work_item_id = ${'wi-cert-a'} AND status = 'ACTIVE'
    `,
    );
    expect(active.map((row) => row.id)).toEqual(['accept-replacement']);
  }, 300_000);
});
