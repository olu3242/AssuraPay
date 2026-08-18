import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_D_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  REQUIRED_DOMAIN_AGGREGATE_TABLES,
  applyMigrations,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import {
  BATCH_A_TABLES,
  BATCH_B_TABLES,
  BATCH_C_TABLES,
  BATCH_D_AGGREGATES,
  BATCH_D_APPEND_ONLY_COLLECTIONS,
  BATCH_D_TABLES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from '@assurapay/database';
import type { TrustPersistence } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Batch D persists to its own tables, and an active hold actually blocks a release.
 *
 * This suite exists for one assertion above all others. CLAUDE.md hard constraint 2 — "Release
 * requires … **no active hold**" — was enforced nowhere before `202608110002`:
 * `DisputeResolutionEngine.isHeld` computes the right answer and nothing calls it, and
 * `FinalSettlementEngine.close` takes `noOpenDisputes` as a boolean the caller supplies. A hold is a
 * cross-row property, so it can only be proved against a real database, and every refusal below is
 * exercised through a **direct statement** as well as, or instead of, the store — because the point of
 * moving the constraint into PostgreSQL is that it holds for a caller the application never mediated.
 *
 * It also proves the correction to the defect that mattered most in the whole programme: a
 * `dispute_holds` row could not be updated, so a hold could never be lifted, so a disputed release
 * would have been frozen permanently.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-d';
const OTHER_TENANT = 'tenant-d-other';
const WORKSPACE = 'workspace-d';
const OTHER_WORKSPACE = 'workspace-d-other';
const RAISER = 'user-raiser';

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
  return withTrustScope({ tenantId, workspaceId, actorId: RAISER }, () => work(store));
}

/** Raw SQL under a tenant scope. Every Batch D table forces row-level security. */
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
 * The settlement chain a dispute hangs from, through the production store.
 *
 * `id` alone is still the primary key — tenancy adds `UNIQUE (tenant_id, id)` on top, which makes
 * cross-tenant references impossible but does not partition the key space — so a second tenant's
 * chain needs its own ids.
 */
async function foundChain(
  database: TestDatabase,
  tenantId: string = TENANT,
  workspaceId: string = WORKSPACE,
  suffix = '',
): Promise<void> {
  await withTrustScope({ tenantId, workspaceId, actorId: RAISER }, async () => {
    const store = new PostgresTrustStore(database.sql);
    const k = (base: string) => `${base}${suffix}`;
    await store.append('trustWorkspaces', { id: workspaceId, tenantId, status: 'ACTIVE', version: 1 });
    // The authority the eligibility cites, made storable by Batch G. `202608110009` turned
    // `paymentEligibilities.paymentTriggerRuleId` into a foreign key, and the rule hangs off a blueprint
    // milestone, which hangs off a deliverable and a blueprint.
    await store.append('performanceBlueprints', {
      id: k('bp-1'),
      workspaceId,
      contractId: k('c-1'),
      contractVersionId: k('cv-1'),
      agreementIntelligenceVersionId: k('aiv-1'),
      version: 1,
      status: 'ACTIVE',
      createdBy: RAISER,
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
      ownerId: RAISER,
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
      ownerId: RAISER,
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
    await store.append('paymentTriggerRules', {
      id: k('ptr-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      name: 'On milestone completion',
      ruleType: 'MILESTONE_COMPLETION',
      requiredAcceptanceCriterionIds: [],
      amountMinor: 5_000_000,
      currency: 'NGN',
      status: 'ACTIVE',
      createdAt: stamp,
    });
    await store.append('paymentEligibilities', {
      id: k('pe-1'),
      workspaceId,
      milestoneId: k('ms-1'),
      completionCertificateId: k('cert-1'),
      paymentTriggerRuleId: k('ptr-1'),
      eligible: true,
      blockers: [],
      evaluatedBy: RAISER,
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
      submittedBy: RAISER,
      createdAt: stamp,
    });
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
      requestedBy: RAISER,
      createdAt: stamp,
    });
  });
}

function releaseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rr-1',
    workspaceId: WORKSPACE,
    milestoneId: 'ms-1',
    financialEntitlementId: 'fe-1',
    invoiceId: 'inv-1',
    fundReservationId: 'fr-1',
    releaseType: 'FULL',
    requestedAmountMinor: 925_000,
    currency: 'NGN',
    status: 'DRAFT',
    blockers: [],
    requestedBy: RAISER,
    createdAt: stamp,
    ...overrides,
  };
}

function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dsp-1',
    workspaceId: WORKSPACE,
    releaseRequestId: 'rr-1',
    kind: 'PAYMENT_DISPUTE',
    description: 'Beneficiary disputes the settled amount',
    status: 'OPEN',
    raisedBy: RAISER,
    createdAt: stamp,
    ...overrides,
  };
}

function hold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dh-1',
    workspaceId: WORKSPACE,
    disputeId: 'dsp-1',
    releaseRequestId: 'rr-1',
    active: true,
    placedAt: stamp,
    ...overrides,
  };
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

/** Raises a dispute and places its hold, as `DisputeResolutionEngine.raise` does. */
async function raiseWithHold(database: TestDatabase): Promise<void> {
  await as(database, async (store) => {
    await store.append('disputes', dispute());
    await store.append('disputeHolds', hold());
  });
}

/** Closes the dispute and releases the hold, as `DisputeResolutionEngine.close` does. */
async function resolveAndRelease(database: TestDatabase): Promise<void> {
  await as(database, async (store) => {
    await store.append('disputeDecisions', {
      id: 'dd-1',
      workspaceId: WORKSPACE,
      disputeId: 'dsp-1',
      decision: 'REJECTED',
      rationale: 'Retention correctly applied; the disputed line stands',
      decidedBy: 'user-adjudicator',
      decidedAt: stamp,
    });
    await store.replace('disputes', dispute({ status: 'DECIDED' }));
    await store.replace('disputes', dispute({ status: 'CLOSED' }));
    await store.replace('disputeHolds', hold({ active: false, releasedAt: stamp }));
  });
}

describe('integration: Batch D is activated, and it is the last batch', () => {
  it('pairs all five contracts with a relational repository', () => {
    expect(Object.keys(BATCH_D_RELATIONS)).toHaveLength(5);
    expect(BATCH_D_AGGREGATES).toHaveLength(5);
    for (const aggregate of BATCH_D_AGGREGATES) {
      const relation = BATCH_D_RELATIONS[aggregate.collection];
      expect(relation, aggregate.collection).toBeDefined();
      expect(relation.table, aggregate.collection).toBe(aggregate.table);
    }
  });

  it('requires all five tables and reports compatible', async () => {
    for (const aggregate of BATCH_D_AGGREGATES)
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, aggregate.table).toContain(aggregate.table);
    // The wave 4-5 plan's thirty-five, asserted from the batch registries rather than as the length of
    // the union. Batch E has since added six more, and later batches will add the rest of the
    // sixty-seven the durability gap analysis registers — this suite owns Batch D's five and the claim
    // that the wave 4-5 plan is complete, not the size of everything that came after it.
    expect(
      [...BATCH_A_TABLES, ...BATCH_B_TABLES, ...BATCH_C_TABLES, ...BATCH_D_TABLES],
    ).toHaveLength(35);
    for (const table of [...BATCH_A_TABLES, ...BATCH_B_TABLES, ...BATCH_C_TABLES, ...BATCH_D_TABLES])
      expect(REQUIRED_DOMAIN_AGGREGATE_TABLES, table).toContain(table);

    const database = await migratedDatabase();
    const compatible = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatible.missingTables).toEqual([]);
    expect(compatible.pendingRequired).toEqual([]);
    expect(compatible.compatible).toBe(true);

    await database.sql.unsafe('DROP TABLE dispute_holds CASCADE');
    const degraded = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(degraded.missingTables).toEqual(['dispute_holds']);
    expect(degraded.compatible).toBe(false);
  }, 300_000);

  it('keys every Batch D table as TEXT and forces row-level security', async () => {
    const database = await migratedDatabase();
    const tables = BATCH_D_AGGREGATES.map((aggregate) => aggregate.table);
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
  }, 300_000);

  it('guards all three release points with a hold trigger', async () => {
    // Named explicitly rather than counted: a missing trigger on any one of these is a path by which
    // money moves past an active hold, and which path it is matters.
    const database = await migratedDatabase();
    for (const [table, trigger] of [
      ['release_requests', 'release_requests_no_active_hold'],
      ['payment_instructions', 'payment_instructions_no_active_hold'],
      ['final_settlement_accounts', 'final_settlement_accounts_no_active_hold'],
    ]) {
      const [found] = await database.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname = 'public'
          AND c.relname = ${table} AND t.tgname = ${trigger}
      `;
      expect(found.n, `${table}.${trigger}`).toBe(1);
    }
  }, 300_000);

  it('refuses the migration when a dispute table holds rows', async () => {
    const database = await createTestDatabaseInstance();
    databases.push(database);
    const earlier = readMigrations(migrationsDirectory()).filter((entry) => entry.id < '202608110002');
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
    // Through the pre-convergence shape: `disputes.workspace_id` is still a UUID into `workspaces`.
    await database.sql`
      INSERT INTO workspaces (id, tenant_id, name, type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'legacy', 'organization')
    `;
    const [workspace] = await database.sql<{ id: string }[]>`SELECT id FROM workspaces LIMIT 1`;
    await database.sql`
      INSERT INTO disputes (workspace_id, release_request_id, kind, description, status, raised_by)
      VALUES (${workspace.id}::uuid, gen_random_uuid(), 'CLAIM', 'legacy', 'OPEN', gen_random_uuid())
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain('WAVE5_BATCH_D_AUTHORITY_REFUSED');
    expect(message).toContain('disputes=1');
    expect(message).toContain('Nothing has been changed');
  }, 300_000);
});

describe('integration: an active hold blocks a release', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundChain(database);
    await raiseWithHold(database);
  }, 300_000);

  it('refuses a release request reaching CONDITIONS_MET, through the store', async () => {
    const error = await as(database, (store) =>
      store
        .replace('releaseRequests', releaseRequest({ status: 'CONDITIONS_MET' }))
        .catch((caught: unknown) => caught),
    );
    expect(error).toBeInstanceOf(PostgresStoreError);
    // Its own code: this is the constraint working, not a failure. A caller must be able to report
    // "held" rather than "error", and a retry is never the right response — the hold is lifted by
    // resolving the dispute.
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_RELEASE_HELD');
    expect((error as PostgresStoreError).detail ?? '').toContain('ACTIVE_DISPUTE_HOLD');
  }, 300_000);

  it('refuses it on a direct statement the application never mediated', async () => {
    const error = await raw(database, (tx) => tx`
      UPDATE release_requests SET status = 'CONDITIONS_MET', version = version + 1
      WHERE id = ${'rr-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('ACTIVE_DISPUTE_HOLD');
  }, 300_000);

  it('refuses a payment instruction outright, whatever its status', async () => {
    // The money-movement backstop. An instruction could otherwise be issued against a request that
    // reached CONDITIONS_MET before the hold was placed, so this guards any insert at all.
    const error = await as(database, (store) =>
      store.append('paymentInstructions', instruction()).catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_RELEASE_HELD');
  }, 300_000);

  it('refuses closing a settlement account over a live dispute on its milestone', async () => {
    // This is the point that was previously "enforced" by `noOpenDisputes`, a boolean the caller
    // passes in — so the database refusing regardless is the whole improvement.
    const account = {
      id: 'fsa-1',
      workspaceId: WORKSPACE,
      milestoneId: 'ms-1',
      totalEntitlementAmountMinor: 1_000_000,
      totalSettledAmountMinor: 1_000_000,
      outstandingAmountMinor: 0,
      currency: 'NGN',
      status: 'DRAFT',
      createdAt: stamp,
    };
    await as(database, (store) => store.append('finalSettlementAccounts', account));
    const error = await as(database, (store) =>
      store
        .replace('finalSettlementAccounts', { ...account, status: 'CLOSED', closedAt: stamp })
        .catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_RELEASE_HELD');
    expect((error as PostgresStoreError).detail ?? '').toContain('ms-1');
  }, 300_000);

  it('permits a state change that is not a release', async () => {
    // The trigger guards CONDITIONS_MET specifically. A held request must still be able to record
    // that it is blocked, or the hold would prevent the system describing the hold.
    await as(database, (store) =>
      store.replace('releaseRequests', releaseRequest({ status: 'BLOCKED', blockers: ['DISPUTE'] })),
    );
    const [read] = await as(database, (store) =>
      store.list<{ status: string; blockers: string[] }>('releaseRequests'),
    );
    expect(read.status).toBe('BLOCKED');
    expect(read.blockers).toEqual(['DISPUTE']);
  }, 300_000);
});

describe('integration: resolving the dispute lifts the hold, and the release proceeds', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundChain(database);
    await raiseWithHold(database);
  }, 300_000);

  it('releases the hold — the UPDATE the blanket append-only trigger would have refused', async () => {
    // The defect that mattered most in the whole programme. `dispute_holds` carried a blanket
    // append-only trigger while `close` writes `active = false`, so a hold could never be lifted and
    // a disputed release would have been frozen permanently.
    await resolveAndRelease(database);
    const [stored] = await as(database, (store) =>
      store.list<{ active: boolean; releasedAt?: string }>('disputeHolds'),
    );
    expect(stored.active).toBe(false);
    expect(stored.releasedAt).toBe(stamp);
  }, 300_000);

  it('lets the release reach CONDITIONS_MET once no hold is active', async () => {
    await as(database, (store) =>
      store.replace('releaseRequests', releaseRequest({ status: 'CONDITIONS_MET' })),
    );
    const [read] = await as(database, (store) => store.list<{ status: string }>('releaseRequests'));
    expect(read.status).toBe('CONDITIONS_MET');
  }, 300_000);

  it('lets the payment instruction be issued once no hold is active', async () => {
    await as(database, (store) => store.append('paymentInstructions', instruction()));
    const [read] = await as(database, (store) => store.list<{ id: string }>('paymentInstructions'));
    expect(read.id).toBe('pi-1');
  }, 300_000);

  it('refuses re-activating a released hold, because released is terminal', async () => {
    // A hold that can be re-activated is a release that can be blocked with no new dispute behind it.
    const error = await raw(database, (tx) => tx`
      UPDATE dispute_holds SET active = true, released_at = NULL, version = version + 1
      WHERE id = ${'dh-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('AGGREGATE_STATE_IS_TERMINAL');
  }, 300_000);
});

describe('integration: Batch D linkage and mutation boundaries', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await migratedDatabase();
    await foundChain(database);
    await raiseWithHold(database);
  }, 300_000);

  it('round-trips a dispute and its hold exactly', async () => {
    const [storedDispute] = await as(database, (store) =>
      store.list<Record<string, unknown>>('disputes'),
    );
    expect(storedDispute).toEqual(dispute());
    const [storedHold] = await as(database, (store) =>
      store.list<Record<string, unknown>>('disputeHolds'),
    );
    expect(storedHold).toEqual(hold());
  }, 300_000);

  it('refuses a dispute or a hold naming a release request that does not exist', async () => {
    // The fourth and fifth instances of the missing-foreign-key defect. A hold against nothing blocks
    // nothing while reading in every report as protection that was in place.
    const badDispute = await as(database, (store) =>
      store
        .append('disputes', dispute({ id: 'dsp-ghost', releaseRequestId: 'rr-absent' }))
        .catch((caught: unknown) => caught),
    );
    expect((badDispute as PostgresStoreError).detail ?? '').toMatch(/disputes_release_request_fk/);

    const badHold = await as(database, (store) =>
      store
        .append('disputeHolds', hold({ id: 'dh-ghost', releaseRequestId: 'rr-absent' }))
        .catch((caught: unknown) => caught),
    );
    expect((badHold as PostgresStoreError).detail ?? '').toMatch(/dispute_holds_release_request_fk/);
  }, 300_000);

  it('refuses a second active hold for the same dispute and request', async () => {
    const error = await as(database, (store) =>
      store.append('disputeHolds', hold({ id: 'dh-2' })).catch((caught: unknown) => caught),
    );
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a second decision on one dispute', async () => {
    const decision = {
      id: 'dd-1',
      workspaceId: WORKSPACE,
      disputeId: 'dsp-1',
      decision: 'UPHELD',
      rationale: 'The duplicate retention line is reversed',
      decidedBy: 'user-adjudicator',
      decidedAt: stamp,
    };
    await as(database, (store) => store.append('disputeDecisions', decision));
    const error = await as(database, (store) =>
      store
        .append('disputeDecisions', { ...decision, id: 'dd-2', decision: 'REJECTED' })
        .catch((caught: unknown) => caught),
    );
    // Two decisions on one dispute leave which one resolved it undecidable.
    expect((error as PostgresStoreError).code).toBe('PERSISTENCE_DUPLICATE_RECORD');
  }, 300_000);

  it('refuses a released hold with no time it was released', async () => {
    const error = await raw(database, (tx) => tx`
      UPDATE dispute_holds SET active = false, version = version + 1 WHERE id = ${'dh-1'}
    `).catch((caught: unknown) => caught);
    expect(String(error)).toContain('released_at_follows_active');
  }, 300_000);

  it('refuses repointing a dispute at a different release request, and refuses a DELETE', async () => {
    // `disputes` carried no trigger at all before this migration. Deleting a dispute is how a blocked
    // release gets unblocked without anybody resolving anything.
    const immutable = await raw(database, (tx) => tx`
      UPDATE disputes SET release_request_id = 'rr-other', version = version + 1
      WHERE id = ${'dsp-1'}
    `).catch((caught: unknown) => caught);
    expect(String(immutable)).toContain('AGGREGATE_FACT_IS_IMMUTABLE');

    const deleted = await raw(database, (tx) => tx`
      DELETE FROM disputes WHERE id = ${'dsp-1'}
    `).catch((caught: unknown) => caught);
    expect(String(deleted)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');

    const heldDelete = await raw(database, (tx) => tx`
      DELETE FROM dispute_holds WHERE id = ${'dh-1'}
    `).catch((caught: unknown) => caught);
    expect(String(heldDelete)).toContain('AGGREGATE_ROW_IS_NOT_DELETABLE');
  }, 300_000);

  it('keeps evidence, positions and decisions append-only, in the store and the database', async () => {
    const appendOnly = Object.values(BATCH_D_RELATIONS)
      .filter((relation) => relation.appendOnly)
      .map((relation) => relation.collection)
      .sort();
    expect(appendOnly).toEqual([...BATCH_D_APPEND_ONLY_COLLECTIONS].sort());

    const evidence = {
      id: 'de-1',
      workspaceId: WORKSPACE,
      disputeId: 'dsp-1',
      reference: 'EVIDENCE-PACK-77',
      description: 'Signed acceptance certificate for the disputed milestone',
      submittedBy: RAISER,
      submittedAt: stamp,
    };
    await as(database, (store) => store.append('disputeEvidence', evidence));

    const refused = await as(database, (store) =>
      store
        .replace('disputeEvidence', { ...evidence, description: 'edited after the fact' })
        .catch((caught: unknown) => caught),
    );
    expect((refused as PostgresStoreError).code).toBe('PERSISTENCE_HISTORY_IMMUTABLE');

    const direct = await raw(database, (tx) => tx`
      UPDATE dispute_evidence SET description = 'edited by hand' WHERE id = ${'de-1'}
    `).catch((caught: unknown) => caught);
    expect(String(direct)).toContain('append-only table');
  }, 300_000);

  it('refuses a dispute referencing a release request in another tenant', async () => {
    await foundChain(database, OTHER_TENANT, OTHER_WORKSPACE, '-other');
    // `rr-1` exists, but in TENANT. Foreign key checks run as the table owner and are not subject to
    // row-level security, so only the composite key closes this.
    const error = await raw(
      database,
      (tx) => tx`
        INSERT INTO disputes
          (id, tenant_id, workspace_id, release_request_id, kind, description, status, raised_by,
           created_at, version, schema_version, updated_at)
        VALUES ('dsp-cross', ${OTHER_TENANT}, ${OTHER_WORKSPACE}, 'rr-1', 'CLAIM', 'reaching across',
                'OPEN', ${RAISER}, ${stamp}, 1, 1, ${stamp})
      `,
      OTHER_TENANT,
      OTHER_WORKSPACE,
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/disputes_release_request_fk/);
  }, 300_000);

  it('shows another tenant no disputes and no holds', async () => {
    for (const collection of ['disputes', 'disputeHolds']) {
      const seen = await as(
        database,
        (store) => store.list(collection),
        OTHER_TENANT,
        OTHER_WORKSPACE,
      );
      expect(seen, collection).toEqual([]);
    }
  }, 300_000);
});
