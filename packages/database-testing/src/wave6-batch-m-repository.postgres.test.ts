import { afterAll, describe, expect, it } from 'vitest';
import {
  BATCH_M_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  REQUIRED_STORE_TABLES,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_M_AGGREGATES,
  BATCH_M_APPEND_ONLY_COLLECTIONS,
  BATCH_M_TABLES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch M persists the governed agent surface, and closes the durability register.
 *
 * The nine agent-runtime aggregates of canonical Engines 61-70. The only batch since Batch A whose migration
 * creates its tables — but not for want of prior art, and the prior art is what this suite exists to be
 * measured against.
 *
 * `202608030012` had put all nine aggregates in one untyped envelope, `agent_runtime.records`, in a schema of
 * its own. Nothing read it or wrote it, and nothing could see it either: `certifySchemaOwnership` and the RLS
 * certification both enumerate `current_schema()`, so an object outside it was governed by none of the gates
 * built to notice exactly its problems. Three of those problems were proved by statement against a live
 * instance before any of this was written:
 *
 *   * a `capability` record could be edited into `EXECUTE_DETERMINISTIC` with `protectedState` true — the shape
 *     `CapabilityRegistryEngine.register` exists to refuse, and the one row standing between an agent
 *     proposing a protected-state change and performing one. `UPDATE 1`;
 *   * an `execution` record could not transition at all: `QUEUED → RUNNING` raised "agent runtime history is
 *     append-only", so Engine 61's whole lifecycle was unperformable;
 *   * a `DELETE` reported `DELETE 0` and left the row in place, because the trigger returned `NEW` from a
 *     `BEFORE DELETE` — neither performing nor refusing the statement.
 *
 * Every test below that begins "refuses" is the inverse of one of those, and none of it is checkable against
 * `InMemoryTrustStore`: there is no constraint to violate and no trigger to refuse the statement.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-m';
const OTHER_TENANT = 'tenant-m-other';
const WORKSPACE = 'workspace-m';
const OTHER_WORKSPACE = 'workspace-m-other';
const ACTOR = 'user-agent-steward';

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
const latest = '2026-08-18T13:00:00.000Z';
const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

function as<T>(
  database: TestDatabase,
  work: (store: TrustPersistence) => Promise<T>,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
): Promise<T> {
  const store: TrustPersistence = new PostgresTrustStore(database.sql);
  return withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch M table forces row-level security from its first statement. */
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
  capability: (o: Record<string, unknown> = {}) => ({
    id: 'cap-1',
    workspaceId: WORKSPACE,
    name: 'Propose a milestone certification',
    owner: 'completion-assurance',
    permission: 'completion-certificates:create',
    mode: 'PROPOSE',
    deterministicContract: 'CompletionCertification.propose',
    aiAllowed: true,
    humanApprovalRequired: true,
    // The combination the retired envelope allowed to be edited into an executing one.
    protectedState: true,
    active: true,
    createdAt: stamp,
    ...o,
  }),
  agent: (o: Record<string, unknown> = {}) => ({
    id: 'ag-1',
    workspaceId: WORKSPACE,
    name: 'Atlas',
    version: 1,
    owner: 'execution-assurance',
    promptIds: ['prompt-assess'],
    allowedCapabilityIds: ['cap-1'],
    active: true,
    createdAt: stamp,
    ...o,
  }),
  prompt: (o: Record<string, unknown> = {}) => ({
    id: 'pv-1',
    workspaceId: WORKSPACE,
    promptId: 'prompt-assess',
    version: 1,
    template: 'Assess {{milestone}} against {{evidence}}',
    requiredVariables: ['evidence', 'milestone'],
    outputContract: 'certification.assessment.v1',
    status: 'PUBLISHED',
    checksum: digest,
    createdAt: stamp,
    ...o,
  }),
  snapshot: (o: Record<string, unknown> = {}) => ({
    id: 'cs-1',
    workspaceId: WORKSPACE,
    agreementId: 'agr-1',
    milestoneIds: ['gm-1'],
    definitionOfDoneIds: ['dv-1'],
    historyRefs: ['evidence-package:ep-1'],
    tenantId: TENANT,
    userId: ACTOR,
    permissions: ['completion-certificates:create', 'milestones:read'],
    checksum: digest,
    createdAt: stamp,
    ...o,
  }),
  execution: (o: Record<string, unknown> = {}) => ({
    id: 'ex-1',
    workspaceId: WORKSPACE,
    agentId: 'ag-1',
    capabilityId: 'cap-1',
    promptVersionId: 'pv-1',
    contextSnapshotId: 'cs-1',
    status: 'QUEUED',
    attempts: 0,
    createdAt: stamp,
    ...o,
  }),
  memory: (o: Record<string, unknown> = {}) => ({
    id: 'mem-1',
    workspaceId: WORKSPACE,
    executionId: 'ex-1',
    agentId: 'ag-1',
    sequence: 1,
    kind: 'USER',
    content: { milestoneId: 'gm-1', evidence: 'ep-1' },
    contentHash: digest,
    createdAt: stamp,
    ...o,
  }),
  approval: (o: Record<string, unknown> = {}) => ({
    id: 'ap-1',
    workspaceId: WORKSPACE,
    executionId: 'ex-1',
    requestedByAgentId: 'ag-1',
    // The action that makes the self-approval rule a CLAUDE.md constraint rather than a nicety.
    action: 'CERTIFICATION',
    proposalHash: digest,
    status: 'PENDING',
    createdAt: stamp,
    ...o,
  }),
  telemetry: (o: Record<string, unknown> = {}) => ({
    id: 'tel-1',
    workspaceId: WORKSPACE,
    executionId: 'ex-1',
    agentId: 'ag-1',
    provider: 'anthropic',
    latencyMs: 1_820,
    // Integer minor units — kobo — per CLAUDE.md's fourth constraint.
    costMinor: 4_150,
    inputTokens: 2_400,
    outputTokens: 610,
    errors: 0,
    qualityScore: 92.5,
    hallucinationFlag: false,
    approvalRequested: true,
    createdAt: stamp,
    ...o,
  }),
  policy: (o: Record<string, unknown> = {}) => ({
    id: 'gp-1',
    workspaceId: WORKSPACE,
    version: 1,
    allowedRoles: ['assurance-lead'],
    allowedPromptIds: ['prompt-assess'],
    allowedCapabilityIds: ['cap-1'],
    allowedModels: ['claude-sonnet'],
    requireApprovalFor: ['CERTIFICATION'],
    active: true,
    createdAt: stamp,
    ...o,
  }),
};

/** All nine, in dependency order — an execution references four of them, and two reference it. */
async function foundAgentRuntime(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  const k = (base: string) => `${base}${suffix}`;
  await withTrustScope({ tenantId, workspaceId, actorId: ACTOR }, async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    await store.append('agentCapabilities', record.capability({ id: k('cap-1'), workspaceId }));
    await store.append(
      'registeredAgents',
      record.agent({ id: k('ag-1'), workspaceId, allowedCapabilityIds: [k('cap-1')] }),
    );
    await store.append('promptVersions', record.prompt({ id: k('pv-1'), workspaceId }));
    await store.append('agentContextSnapshots', record.snapshot({ id: k('cs-1'), workspaceId, tenantId }));
    await store.append('agentGovernancePolicies', record.policy({ id: k('gp-1'), workspaceId }));
    await store.append(
      'agentExecutions',
      record.execution({
        id: k('ex-1'),
        workspaceId,
        agentId: k('ag-1'),
        capabilityId: k('cap-1'),
        promptVersionId: k('pv-1'),
        contextSnapshotId: k('cs-1'),
      }),
    );
    await store.append(
      'agentMemory',
      record.memory({ id: k('mem-1'), workspaceId, executionId: k('ex-1'), agentId: k('ag-1') }),
    );
    await store.append(
      'agentTelemetry',
      record.telemetry({ id: k('tel-1'), workspaceId, executionId: k('ex-1'), agentId: k('ag-1') }),
    );
    await store.append(
      'agentApprovalRequests',
      record.approval({ id: k('ap-1'), workspaceId, executionId: k('ex-1'), requestedByAgentId: k('ag-1') }),
    );
  });
}

describe('integration: Batch M is activated and the agent surface becomes durable', () => {
  const seeded = sharedDatabase(foundAgentRuntime);

  it('pairs all nine contracts with a relational repository', () => {
    expect(Object.keys(BATCH_M_RELATIONS).sort()).toEqual(
      BATCH_M_AGGREGATES.map((aggregate) => aggregate.collection).sort(),
    );
    expect(BATCH_M_AGGREGATES).toHaveLength(9);
  });

  it('requires all nine tables at startup and routes to them', async () => {
    await seeded();
    const required = new Set(REQUIRED_STORE_TABLES);
    const routed = new Set(POSTGRES_ROUTED_TABLES);
    for (const table of BATCH_M_TABLES) {
      expect(required.has(table), table).toBe(true);
      expect(routed.has(table), table).toBe(true);
    }
  }, 300_000);

  it('keys every table as TEXT and forces row-level security from the first migration', async () => {
    const database = await seeded();
    const uuid = await raw(database, (tx) =>
      tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${BATCH_M_TABLES as string[]})
          AND data_type = 'uuid'
      `,
    );
    // The retired envelope keyed everything as UUID, which is why its own policy raised
    // `invalid input syntax for type uuid` under the runtime's TEXT tenant identity — an error naming a type
    // rather than a permission.
    expect(uuid).toEqual([]);

    const security = await raw(database, (tx) =>
      tx<{ relname: string; relforcerowsecurity: boolean }[]>`
        SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${BATCH_M_TABLES as string[]}) AND relkind = 'r'
      `,
    );
    expect(security).toHaveLength(BATCH_M_TABLES.length);
    // FORCE rather than merely ENABLE, which does not constrain the table owner. Batch A through L had to
    // convert 59 tables; these nine were created this way.
    for (const row of security) expect(row.relforcerowsecurity, row.relname).toBe(true);
  }, 300_000);

  it('stores and reads back all nine aggregates exactly', async () => {
    const database = await seeded();
    const seen = await as(database, async (store) => ({
      agentCapabilities: await store.list('agentCapabilities'),
      registeredAgents: await store.list('registeredAgents'),
      promptVersions: await store.list('promptVersions'),
      agentContextSnapshots: await store.list('agentContextSnapshots'),
      agentGovernancePolicies: await store.list('agentGovernancePolicies'),
      agentExecutions: await store.list('agentExecutions'),
      agentMemory: await store.list('agentMemory'),
      agentTelemetry: await store.list('agentTelemetry'),
      agentApprovalRequests: await store.list('agentApprovalRequests'),
    }));

    expect(seen.agentCapabilities[0]).toEqual(record.capability());
    // `jsonb` arrays, read back as arrays rather than passed through: these lists bound what an agent may do.
    expect(seen.registeredAgents[0]).toEqual(record.agent());
    expect(seen.promptVersions[0]).toEqual(record.prompt());
    // `blueprintId` is optional and absent here, and `tenantId` is read from the routing column.
    expect(seen.agentContextSnapshots[0]).toEqual(record.snapshot());
    expect(seen.agentGovernancePolicies[0]).toEqual(record.policy());
    // `proposal`, `error`, `startedAt` and `completedAt` are all absent on a queued run.
    expect(seen.agentExecutions[0]).toEqual(record.execution());
    expect(seen.agentMemory[0]).toEqual(record.memory());
    // BIGINT model spend and a NUMERIC quality score, both of which arrive from the driver as strings — a
    // round trip is where that is either parsed or silently returned as text the schema rejects.
    expect(seen.agentTelemetry[0]).toEqual(record.telemetry());
    expect(seen.agentApprovalRequests[0]).toEqual(record.approval());
  }, 300_000);

  it('retires the untyped envelope the first scan missed', async () => {
    const database = await seeded();
    const survivors = await raw(database, (tx) =>
      tx<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname = 'agent_runtime'`,
    );
    // Schema and all. It held one table, one trigger function and no reader — and being outside
    // `current_schema()`, no gate in this repository could see any of it.
    expect(survivors).toEqual([]);

    const functions = await raw(database, (tx) =>
      tx<{ proname: string }[]>`
        SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'agent_runtime'
      `,
    );
    expect(functions).toEqual([]);
  }, 300_000);
});

describe('integration: the capability row an agent cannot edit its way past', () => {
  const seeded = sharedDatabase(foundAgentRuntime);

  it('refuses a capability that would let an agent execute a protected-state change', async () => {
    const database = await seeded();
    const refused = await as(database, (store) =>
      attempt(
        store.append(
          'agentCapabilities',
          record.capability({ id: 'cap-bad', mode: 'EXECUTE_DETERMINISTIC', protectedState: true }),
        ),
      ),
    );
    // The schema refuses it before the statement…
    expect(refused).toBeInstanceOf(PostgresStoreError);
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_SCHEMA_VIOLATION');

    // …and so does the column, for a caller that bypasses the repository entirely. `execute()` invokes the
    // deterministic gateway on this mode, so a row in this shape is an agent performing a protected-state
    // change rather than proposing one.
    const direct = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_capabilities
            (id, tenant_id, workspace_id, name, owner, permission, mode, deterministic_contract, ai_allowed,
             human_approval_required, protected_state, active, created_at)
          VALUES ('cap-bad-direct', ${TENANT}, ${WORKSPACE}, 'issue', 'assurance', 'certificate:issue',
                  'EXECUTE_DETERMINISTIC', 'CompletionCertification.issue', true, true, true, true, now())
        `,
      ),
    );
    expect(String(direct)).toContain('agent_capabilities_protected_state_may_only_propose');
  }, 300_000);

  it('refuses editing a registered capability into an executing one', async () => {
    const database = await seeded();
    // The statement that returned `UPDATE 1` against the retired envelope, and the reason `mode` and
    // `protected_state` are immutable columns: `deactivate()` is a `replace`, so without immutability the
    // refused shape could still be reached one write after the row was created.
    const mode = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_capabilities SET mode = 'EXECUTE_DETERMINISTIC', row_version = row_version + 1
           WHERE id = 'cap-1'`,
      ),
    );
    expect(String(mode)).toContain('AGGREGATE_FACT_IS_IMMUTABLE: agent_capabilities.mode');

    const flag = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_capabilities SET protected_state = false, row_version = row_version + 1
           WHERE id = 'cap-1'`,
      ),
    );
    expect(String(flag)).toContain('AGGREGATE_FACT_IS_IMMUTABLE: agent_capabilities.protected_state');
  }, 300_000);

  it('deactivates a capability, and refuses to bring it back', async () => {
    const database = await seeded();
    await as(database, async (store) => {
      await store.replace('agentCapabilities', record.capability({ active: false }));
    });
    const after = await as(database, (store) => store.list('agentCapabilities'));
    expect((after[0] as { active: boolean }).active).toBe(false);

    // `CapabilityRegistryEngine` has `deactivate` and no reactivation, so a capability turned back on is a
    // state no engine can produce.
    const revived = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_capabilities SET active = true, row_version = row_version + 1 WHERE id = 'cap-1'`,
      ),
    );
    expect(String(revived)).toContain('AGGREGATE_CANNOT_BE_REACTIVATED');
  }, 300_000);

  it('refuses deleting a capability, rather than silently ignoring the statement', async () => {
    const database = await seeded();
    const deleted = await attempt(
      raw(database, (tx) => tx`DELETE FROM agent_capabilities WHERE id = 'cap-1'`),
    );
    // The envelope's trigger returned `NEW` from a `BEFORE DELETE`, which PL/pgSQL reads as "skip this row":
    // the statement reported `DELETE 0` and the row stayed. Reporting nothing matched, when the row is there
    // and protected, is worse than either allowing or refusing.
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);
});

describe('integration: the execution lifecycle the envelope refused outright', () => {
  const seeded = sharedDatabase(foundAgentRuntime);

  it('runs an execution through its whole lifecycle', async () => {
    const database = await seeded();
    // Every one of these statements raised "agent runtime history is append-only" before `202608110017`.
    const finished = await as(database, async (store) => {
      await store.replace('agentExecutions', record.execution({ status: 'RUNNING', startedAt: later }));
      await store.replace(
        'agentExecutions',
        record.execution({
          status: 'SUCCEEDED',
          attempts: 1,
          proposal: { assessment: 'PASS', rationale: 'evidence complete' },
          startedAt: later,
          completedAt: latest,
        }),
      );
      return await store.list('agentExecutions');
    });
    expect(finished[0]).toEqual(
      record.execution({
        status: 'SUCCEEDED',
        attempts: 1,
        proposal: { assessment: 'PASS', rationale: 'evidence complete' },
        startedAt: later,
        completedAt: latest,
      }),
    );
  }, 300_000);

  it('refuses re-attributing a finished run to a different capability or prompt', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.append(
        'agentCapabilities',
        record.capability({ id: 'cap-2', name: 'Read a milestone', mode: 'READ', protectedState: false }),
      ),
    );
    const moved = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_executions SET capability_id = 'cap-2', row_version = row_version + 1
           WHERE id = 'ex-1'`,
      ),
    );
    expect(String(moved)).toContain('AGGREGATE_FACT_IS_IMMUTABLE: agent_executions.capability_id');

    const reprompted = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_executions SET prompt_version_id = 'pv-other', row_version = row_version + 1
           WHERE id = 'ex-1'`,
      ),
    );
    expect(String(reprompted)).toContain('AGGREGATE_FACT_IS_IMMUTABLE: agent_executions.prompt_version_id');
  }, 300_000);

  it('keeps a run’s status and its timestamps in step', async () => {
    const database = await seeded();
    const queuedButStarted = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_executions
            (id, tenant_id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id,
             status, attempts, started_at, created_at)
          VALUES ('ex-queued-started', ${TENANT}, ${WORKSPACE}, 'ag-1', 'cap-1', 'pv-1', 'cs-1',
                  'QUEUED', 0, now(), now())
        `,
      ),
    );
    // A QUEUED row carrying a start time reads as started to anything sorting by it.
    expect(String(queuedButStarted)).toContain('agent_executions_start_follows_status');

    const failedSilently = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_executions
            (id, tenant_id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id,
             status, attempts, started_at, completed_at, created_at)
          VALUES ('ex-mute-failure', ${TENANT}, ${WORKSPACE}, 'ag-1', 'cap-1', 'pv-1', 'cs-1',
                  'FAILED', 1, now(), now(), now())
        `,
      ),
    );
    // `execute()` always records `lastError`. A failed run with no error is one nobody can diagnose.
    expect(String(failedSilently)).toContain('agent_executions_failure_is_explained');
  }, 300_000);

  it('refuses an execution citing an agent that does not exist', async () => {
    const database = await seeded();
    const orphan = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_executions
            (id, tenant_id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id,
             status, attempts, created_at)
          VALUES ('ex-orphan', ${TENANT}, ${WORKSPACE}, 'ag-nope', 'cap-1', 'pv-1', 'cs-1',
                  'QUEUED', 0, now())
        `,
      ),
    );
    expect(String(orphan)).toContain('agent_executions_agent_fk');
  }, 300_000);

  it('refuses a transition that does not advance the row counter', async () => {
    const database = await seeded();
    const stale = await attempt(
      raw(database, (tx) => tx`UPDATE agent_executions SET status = 'CANCELLED' WHERE id = 'ex-1'`),
    );
    // Two writers that both read version 1 and both write version 1 would otherwise both succeed, and the
    // second would silently discard the first.
    expect(String(stale)).toContain('AGGREGATE_VERSION_MUST_ADVANCE');
  }, 300_000);
});

describe('integration: an agent cannot approve its own proposal', () => {
  const seeded = sharedDatabase(foundAgentRuntime);

  it('refuses an agent approving its own request', async () => {
    const database = await seeded();
    const selfApproved = await attempt(
      raw(database, (tx) =>
        tx`
          UPDATE agent_approval_requests
          SET status = 'APPROVED', decided_by = 'ag-1', decided_at = now(), row_version = row_version + 1
          WHERE id = 'ap-1'
        `,
      ),
    );
    // A CHECK rather than only an engine guard, because `action` may be CERTIFICATION: an agent approving its
    // own request could manufacture certified work, and CLAUDE.md's second hard constraint is that every
    // release is certified-work-backed.
    expect(String(selfApproved)).toContain('agent_approval_requests_no_self_approval');
  }, 300_000);

  it('decides once, consumes once, and refuses both a second time', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.replace(
        'agentApprovalRequests',
        record.approval({ status: 'APPROVED', decidedBy: 'user-reviewer', decidedAt: later }),
      ),
    );

    const revised = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET status = 'REJECTED', row_version = row_version + 1
           WHERE id = 'ap-1'`,
      ),
    );
    // Without this a REJECTED request could be flipped to APPROVED and then consumed — every CHECK would
    // still hold, because the decider and the decision time are already recorded.
    expect(String(revised)).toContain('AGENT_APPROVAL_DECISION_IS_FINAL');

    const reassigned = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET decided_by = 'user-someone-else',
           row_version = row_version + 1 WHERE id = 'ap-1'`,
      ),
    );
    expect(String(reassigned)).toContain('AGENT_APPROVAL_DECIDER_IS_WRITE_ONCE');

    await as(database, (store) =>
      store.replace(
        'agentApprovalRequests',
        record.approval({
          status: 'APPROVED',
          decidedBy: 'user-reviewer',
          decidedAt: later,
          consumedAt: latest,
        }),
      ),
    );

    const reused = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET consumed_at = now(), row_version = row_version + 1
           WHERE id = 'ap-1'`,
      ),
    );
    // An approval authorises one protected action, once.
    expect(String(reused)).toContain('AGENT_APPROVAL_IS_SINGLE_USE');

    const cleared = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET consumed_at = NULL, row_version = row_version + 1
           WHERE id = 'ap-1'`,
      ),
    );
    expect(String(cleared)).toContain('AGENT_APPROVAL_IS_SINGLE_USE');
  }, 300_000);

  it('refuses changing what an approval was for', async () => {
    const database = await seeded();
    const substituted = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET proposal_hash = ${otherDigest},
           row_version = row_version + 1 WHERE id = 'ap-1'`,
      ),
    );
    // `consume()` matches this digest against the proposal being executed. A mutable one would let an approval
    // for one proposal authorise a different one, which is the whole of what it exists to prevent.
    expect(String(substituted)).toContain('AGGREGATE_FACT_IS_IMMUTABLE: agent_approval_requests.proposal_hash');
  }, 300_000);

  it('refuses a proposal hash that cannot be recomputed', async () => {
    const database = await seeded();
    const weak = await as(database, (store) =>
      attempt(store.append('agentApprovalRequests', record.approval({ id: 'ap-weak', proposalHash: 'abc' }))),
    );
    expect(weak).toBeInstanceOf(PostgresStoreError);
    expect((weak as PostgresStoreError).code).toBe('PERSISTENCE_SCHEMA_VIOLATION');

    const direct = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_approval_requests
            (id, tenant_id, workspace_id, execution_id, requested_by_agent_id, action, proposal_hash,
             status, created_at)
          VALUES ('ap-weak-direct', ${TENANT}, ${WORKSPACE}, 'ex-1', 'ag-1', 'CERTIFICATION', 'abc',
                  'PENDING', now())
        `,
      ),
    );
    expect(String(direct)).toContain('agent_approval_requests_proposal_hash_check');
  }, 300_000);

  it('refuses consuming a request nobody has approved', async () => {
    const database = await seeded();
    // Its own row rather than `ap-1`: the test above decides and consumes that one, and these suites share a
    // database per describe block. Reusing it would make this assertion depend on execution order and pass for
    // the wrong reason — the single-use trigger rather than the constraint under test.
    await as(database, (store) =>
      store.append('agentApprovalRequests', record.approval({ id: 'ap-pending' })),
    );
    const premature = await attempt(
      raw(database, (tx) =>
        tx`UPDATE agent_approval_requests SET consumed_at = now(), row_version = row_version + 1
           WHERE id = 'ap-pending'`,
      ),
    );
    expect(String(premature)).toContain('agent_approval_requests_consumption_requires_approval');
  }, 300_000);
});

describe('integration: rows that cannot contradict themselves', () => {
  const seeded = sharedDatabase(foundAgentRuntime);

  it('orders an agent’s reasoning, and refuses two entries at the same position', async () => {
    const database = await seeded();
    await as(database, (store) =>
      store.append('agentMemory', record.memory({ id: 'mem-2', sequence: 2, kind: 'RESULT' })),
    );

    const collision = await as(database, (store) =>
      attempt(store.append('agentMemory', record.memory({ id: 'mem-3', sequence: 2, kind: 'AGENT' }))),
    );
    // `append` derives the sequence from `prior.length + 1`, which two concurrent callers both compute
    // identically. Without the key a conversation holds two entries claiming the same position and nothing to
    // say which came first — for an inspectable audit of an agent's reasoning, the whole point lost.
    expect(collision).toBeInstanceOf(PostgresStoreError);

    const history = await as(database, (store) => store.list('agentMemory'));
    expect(history.map((entry) => (entry as { sequence: number }).sequence)).toEqual([1, 2]);
  }, 300_000);

  it('refuses rewriting or deleting an agent’s reasoning and its telemetry', async () => {
    const database = await seeded();
    for (const table of ['agent_memory', 'agent_telemetry', 'agent_context_snapshots']) {
      const edited = await attempt(
        raw(database, (tx) => tx.unsafe(`UPDATE ${table} SET row_version = row_version + 1`)),
      );
      expect(String(edited), table).toContain('append-only');
      const deleted = await attempt(raw(database, (tx) => tx.unsafe(`DELETE FROM ${table}`)));
      expect(String(deleted), table).toContain('append-only');
    }
  }, 300_000);

  it('reports the store’s own refusal for an append-only collection', async () => {
    const database = await seeded();
    for (const collection of BATCH_M_APPEND_ONLY_COLLECTIONS) {
      const refused = await as(database, (store) =>
        attempt(store.replace(collection, { id: 'x', workspaceId: WORKSPACE })),
      );
      expect(refused, collection).toBeInstanceOf(PostgresStoreError);
      expect((refused as PostgresStoreError).code, collection).toBe('PERSISTENCE_HISTORY_IMMUTABLE');
    }
  }, 300_000);

  it('refuses a prompt requiring a variable its own template lacks', async () => {
    const database = await seeded();
    const unrenderable = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO prompt_versions
            (id, tenant_id, workspace_id, prompt_id, version, template, required_variables,
             output_contract, status, checksum, created_at)
          VALUES ('pv-unrenderable', ${TENANT}, ${WORKSPACE}, 'prompt-assess', 9,
                  'Assess {{milestone}}', ${tx.json(['milestone', 'evidence'] as never)},
                  'assessment.v1', 'DRAFT', ${digest}, now())
        `,
      ),
    );
    // `render` raises `PROMPT_VALUE_MISSING` for a variable it cannot substitute, and the template is
    // immutable — so a row where the two disagree is a prompt that can never be rendered, permanently.
    expect(String(unrenderable)).toContain('prompt_versions_variables_appear_in_template');
  }, 300_000);

  it('keeps one published version per prompt and one active policy per workspace', async () => {
    const database = await seeded();
    const secondPublished = await as(database, (store) =>
      attempt(store.append('promptVersions', record.prompt({ id: 'pv-2', version: 2, status: 'PUBLISHED' }))),
    );
    // `render()` resolves the governing version with a single `find`, so a second published row would make
    // which prompt ran depend on row order.
    expect(secondPublished).toBeInstanceOf(PostgresStoreError);

    const secondPolicy = await as(database, (store) =>
      attempt(store.append('agentGovernancePolicies', record.policy({ id: 'gp-2', version: 2 }))),
    );
    // And `authorize()` the same, for the policy that decides which models, prompts and capabilities an agent
    // may use at all.
    expect(secondPolicy).toBeInstanceOf(PostgresStoreError);
  }, 300_000);

  it('publishes a new prompt version once the incumbent is retired, as the engine does', async () => {
    const database = await seeded();
    // `publish` retires the current published version *before* claiming the status, which is what makes the
    // partial unique index compatible with the engine rather than an obstacle to it.
    const published = await as(database, async (store) => {
      await store.replace('promptVersions', record.prompt({ status: 'RETIRED' }));
      await store.append('promptVersions', record.prompt({ id: 'pv-3', version: 3, status: 'PUBLISHED' }));
      return await store.list('promptVersions');
    });
    const statuses = Object.fromEntries(
      published.map((row) => [(row as { id: string }).id, (row as { status: string }).status]),
    );
    expect(statuses).toEqual({ 'pv-1': 'RETIRED', 'pv-3': 'PUBLISHED' });
  }, 300_000);

  it('holds model spend to integer minor units before the statement', async () => {
    const database = await seeded();
    const fractional = await as(database, (store) =>
      attempt(store.append('agentTelemetry', record.telemetry({ id: 'tel-2', costMinor: 4_150.5 }))),
    );
    expect(fractional).toBeInstanceOf(PostgresStoreError);
    expect((fractional as PostgresStoreError).code).toBe('PERSISTENCE_SCHEMA_VIOLATION');

    // And the column refuses it too, which it did not when this test was written.
    //
    // Batch M recorded the gap rather than closing it: `cost_minor` was BIGINT, an integer column *rounds* a
    // fractional value rather than refusing it — the cast happens before any CHECK can see it — so a direct
    // statement writing 4150.5 kobo stored 4151, silently, and this assertion asserted exactly that. Closing
    // it meant NUMERIC with an integrality CHECK on every money column in the platform, which `202608110018`
    // does for all thirty-one. So the assertion is inverted: the statement that used to succeed with a
    // rounded value is now refused, and the test that documented the gap is the test that proves it closed.
    const direct = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_telemetry
            (id, tenant_id, workspace_id, execution_id, agent_id, latency_ms, cost_minor, input_tokens,
             output_tokens, errors, hallucination_flag, approval_requested, created_at)
          VALUES ('tel-rounded', ${TENANT}, ${WORKSPACE}, 'ex-1', 'ag-1', 10, 4150.5, 1, 1, 0, false, false,
                  now())
        `,
      ),
    );
    expect(String(direct)).toContain('cost_minor_is_integral');
    const absent = await raw(database, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM agent_telemetry WHERE id = 'tel-rounded'`,
    );
    expect(absent).toEqual([]);
  }, 300_000);
});

describe('integration: Batch M tenancy', () => {
  const seeded = sharedDatabase(async (database) => {
    await foundAgentRuntime(database);
    await foundAgentRuntime(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
  });

  it('shows another tenant only its own agents', async () => {
    const database = await seeded();
    const mine = await as(database, (store) => store.list('registeredAgents'));
    const theirs = await as(
      database,
      (store) => store.list('registeredAgents'),
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    expect(mine.map((row) => (row as { id: string }).id)).toEqual(['ag-1']);
    expect(theirs.map((row) => (row as { id: string }).id)).toEqual(['ag-1-other']);
  }, 300_000);

  it('lets two tenants register an agent of the same name at the same version', async () => {
    const database = await seeded();
    const versions = await raw(
      database,
      (tx) => tx<{ count: string }[]>`SELECT count(*) FROM registered_agents WHERE name = 'Atlas'`,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    );
    // One visible per tenant, two in the table: every key in this batch is tenant-scoped from its first
    // statement, which is the shape `202608110010` had to retrofit onto six earlier ones.
    expect(Number(versions[0]?.count)).toBe(1);
  }, 300_000);

  it('refuses an execution referencing an agent in another tenant', async () => {
    const database = await seeded();
    const crossed = await attempt(
      raw(database, (tx) =>
        tx`
          INSERT INTO agent_executions
            (id, tenant_id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id,
             status, attempts, created_at)
          VALUES ('ex-crossed', ${TENANT}, ${WORKSPACE}, 'ag-1-other', 'cap-1', 'pv-1', 'cs-1',
                  'QUEUED', 0, now())
        `,
      ),
    );
    // Foreign keys are checked by the system rather than through row-level security, so the reference has to
    // carry the tenant and the workspace itself.
    expect(String(crossed)).toContain('agent_executions_agent_fk');
  }, 300_000);

  it('refuses a snapshot claiming a tenant other than the scope it is written under', async () => {
    const database = await seeded();
    const mismatched = await as(database, (store) =>
      attempt(
        store.append('agentContextSnapshots', record.snapshot({ id: 'cs-x', tenantId: OTHER_TENANT })),
      ),
    );
    // The only aggregate carrying a tenant of its own. A snapshot is the record of what an agent was entitled
    // to see, so one naming a different tenant is a scope error rather than a schema one.
    expect(mismatched).toBeInstanceOf(PostgresStoreError);
    expect((mismatched as PostgresStoreError).code).toBe('PERSISTENCE_SCOPE_INVALID');
  }, 300_000);

  it('leaves no table carrying ENABLE without FORCE', async () => {
    const database = await seeded();
    const weak = await raw(database, (tx) =>
      tx<{ relname: string }[]>`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND c.relrowsecurity AND NOT c.relforcerowsecurity
      `,
    );
    // Zero since Batch L, and still zero with nine tables added — which is the point of creating them with
    // FORCE rather than converting them later. The retired envelope was the last object anywhere with ENABLE
    // alone, and it was invisible to this query because it lived outside `current_schema()`.
    expect(weak).toEqual([]);
  }, 300_000);
});
