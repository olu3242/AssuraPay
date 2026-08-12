import { afterAll, describe, expect, it } from 'vitest';
import {
  P1_RELATIONS,
  PostgresStoreError,
  PostgresTrustStore,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

requireTestDatabaseUrl();

const TENANT = 'tenant-p1';
const WORKSPACE = 'workspace-p1';
const OTHER_TENANT = 'tenant-p1-other';
const OTHER_WORKSPACE = 'workspace-p1-other';
const ACTOR = 'user-p1';
const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedStore(): Promise<PostgresTrustStore> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  const store = new PostgresTrustStore(database.sql);
  await withTrustScope({ tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR }, () =>
    store.append('trustWorkspaces', { id: WORKSPACE, tenantId: TENANT, status: 'ACTIVE', version: 1 }),
  );
  await withTrustScope(
    { tenantId: OTHER_TENANT, workspaceId: OTHER_WORKSPACE, actorId: ACTOR },
    () =>
      store.append('trustWorkspaces', {
        id: OTHER_WORKSPACE,
        tenantId: OTHER_TENANT,
        status: 'ACTIVE',
        version: 1,
      }),
  );
  return store;
}

const scope = { tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR };

describe('integration: P1 persistence completion', () => {
  it('routes every authorized collection and leaves only Performance Readiness unmapped', () => {
    expect(Object.keys(P1_RELATIONS)).toHaveLength(41);
    expect(P1_RELATIONS.contractVersionsV2.table).toBe('contract_versions_v2');
    expect(P1_RELATIONS.agentExecutions.table).toBe('agent_runtime.records');
  });

  it('round-trips governance, agreement, intelligence and agent records through PostgreSQL', async () => {
    const store = await migratedStore();
    const records = [
      ['governedExecutions', {
        id: 'execution-p1', workspaceId: WORKSPACE, contractId: 'contract-p1', title: 'P1',
        ownerUserId: ACTOR, state: 'DRAFT', createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z', version: 1,
      }],
      ['analysisReviews', {
        id: 'review-p1', workspaceId: WORKSPACE, runId: 'run-p1', findingId: 'finding-p1',
        decision: 'ACCEPTED', notes: 'reviewed', reviewerId: ACTOR,
        createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['dashboardSnapshots', {
        id: 'dashboard-p1', workspaceId: WORKSPACE, role: 'EXECUTIVE', widgets: [],
        generatedFor: ACTOR, generatedAt: '2026-08-12T00:00:00.000Z',
      }],
      ['portfolioSnapshots', {
        id: 'portfolio-p1', workspaceId: WORKSPACE, scopeId: 'portfolio', atRiskCount: 0,
        blockedCount: 0, unpaidAmountMinor: 0, disputedCount: 0, retainedAmountMinor: 0,
        concentrationTopPartyPercent: 0, currency: 'NGN', computedAt: '2026-08-12T00:00:00.000Z',
      }],
      ['agentCapabilities', {
        id: 'capability-p1', workspaceId: WORKSPACE, name: 'advisory-only', version: 1,
        status: 'ACTIVE', createdBy: ACTOR, createdAt: '2026-08-12T00:00:00.000Z',
      }],
    ] as const;

    await withTrustScope(scope, async () => {
      for (const [collection, record] of records) {
        await store.append(collection, record);
        expect(await store.list(collection)).toEqual([expect.objectContaining(record)]);
      }
    });
  }, 300_000);

  it('enforces tenant isolation, append-only history and optimistic concurrency', async () => {
    const store = await migratedStore();
    const execution = {
      id: 'execution-concurrency', workspaceId: WORKSPACE, contractId: 'contract-p1', title: 'P1',
      ownerUserId: ACTOR, state: 'DRAFT', createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z', version: 1,
    };
    const review = {
      id: 'review-append-only', workspaceId: WORKSPACE, runId: 'run-p1', findingId: 'finding-p1',
      decision: 'ACCEPTED', notes: 'reviewed', reviewerId: ACTOR,
      createdAt: '2026-08-12T00:00:00.000Z',
    };

    const stored = await withTrustScope(scope, async () => {
      await store.append('governedExecutions', execution);
      await store.append('analysisReviews', review);
      return (await store.list<{ id: string; [key: string]: unknown }>('governedExecutions'))[0]!;
    });
    expect(stored.rowVersion).toBe(1);

    expect(
      await withTrustScope(
        { tenantId: OTHER_TENANT, workspaceId: OTHER_WORKSPACE, actorId: ACTOR },
        () => store.list('governedExecutions'),
      ),
    ).toEqual([]);

    await withTrustScope(scope, () =>
      store.replace('governedExecutions', {
        ...stored,
        state: 'PLANNED',
        version: 2,
        updatedAt: '2026-08-12T00:01:00.000Z',
      } as { id: string }),
    );
    await expect(
      withTrustScope(scope, () => store.replace('governedExecutions', stored as { id: string })),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' } satisfies Partial<PostgresStoreError>);
    await expect(
      withTrustScope(scope, () => store.replace('analysisReviews', { ...review, rowVersion: 1 })),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_HISTORY_IMMUTABLE' } satisfies Partial<PostgresStoreError>);
  }, 300_000);
});
