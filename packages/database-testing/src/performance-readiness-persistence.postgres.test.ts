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

describe('integration: Production MVP Performance Readiness persistence', () => {
  it('routes exactly the six Production MVP Performance Readiness collections', () => {
    expect(Object.keys(P1_RELATIONS)).toEqual([
      'acceptanceCriteria', 'successMetrics', 'dependencies', 'paymentTriggerRules',
      'performanceBaselines', 'baselineVariances',
    ]);
  });

  it('round-trips all six Performance Readiness collections through PostgreSQL', async () => {
    const store = await migratedStore();
    const records = [
      ['acceptanceCriteria', {
        id: 'criterion-p1', workspaceId: WORKSPACE, deliverableId: 'deliverable-p1',
        description: 'Inspected', testMethod: 'INSPECTION', metric: 'pass',
        tolerance: { operator: 'EQ', target: 1, unit: 'boolean' }, validatorRole: 'APPROVER',
        retestAllowed: false, maxRetests: 0, status: 'DRAFT', createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['successMetrics', {
        id: 'metric-p1', workspaceId: WORKSPACE, milestoneId: 'milestone-p1', kind: 'KPI',
        name: 'Quality', targetValue: 95, unit: 'percent', direction: 'HIGHER_IS_BETTER',
        weightPercent: 100, status: 'DRAFT', createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['dependencies', {
        id: 'dependency-p1', workspaceId: WORKSPACE, milestoneId: 'milestone-p1', kind: 'INTERNAL',
        description: 'Permit', ownerId: ACTOR, dueDate: '2026-08-20', criticality: 'BLOCKING',
        status: 'OPEN', createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['paymentTriggerRules', {
        id: 'trigger-p1', workspaceId: WORKSPACE, milestoneId: 'milestone-p1', name: 'Completion',
        ruleType: 'MILESTONE_COMPLETION', requiredAcceptanceCriterionIds: [], amountMinor: 1000,
        currency: 'USD', status: 'DRAFT', createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['performanceBaselines', {
        id: 'baseline-p1', workspaceId: WORKSPACE, blueprintId: 'blueprint-p1', milestoneId: 'milestone-p1',
        plannedStartDate: '2026-08-12', plannedDueDate: '2026-08-20', plannedBudgetAmountMinor: 1000,
        plannedScopeItemCount: 1, plannedQualityScore: 95, plannedRiskScore: 5,
        status: 'BASELINED', createdAt: '2026-08-12T00:00:00.000Z',
      }],
      ['baselineVariances', {
        id: 'variance-p1', workspaceId: WORKSPACE, baselineId: 'baseline-p1',
        scheduleVarianceDays: 0, costVarianceMinor: 0, scopeVarianceCount: 0,
        recordedBy: ACTOR, recordedAt: '2026-08-12T00:01:00.000Z',
      }],
    ] as const;

    await withTrustScope(scope, async () => {
      for (const [collection, record] of records) {
        await store.append(collection, record);
        const [actual] = await store.list<Record<string, unknown>>(collection);
        const expected = { ...record } as Record<string, unknown>;
        for (const timestamp of ['createdAt', 'recordedAt']) {
          if (typeof expected[timestamp] === 'string') {
            expect(Date.parse(actual?.[timestamp] as string)).toBe(Date.parse(expected[timestamp]));
            delete expected[timestamp];
          }
        }
        expect(actual).toEqual(expect.objectContaining(expected));
      }
    });
  }, 300_000);

  it('enforces tenant isolation, append-only history and optimistic concurrency', async () => {
    const store = await migratedStore();
    const dependency = {
      id: 'dependency-concurrency', workspaceId: WORKSPACE, milestoneId: 'milestone-p1', kind: 'INTERNAL',
      description: 'Permit', ownerId: ACTOR, dueDate: '2026-08-20', criticality: 'BLOCKING',
      status: 'OPEN', createdAt: '2026-08-12T00:00:00.000Z',
    };
    const baseline = {
      id: 'baseline-append-only', workspaceId: WORKSPACE, blueprintId: 'blueprint-p1', milestoneId: 'milestone-p1',
      plannedStartDate: '2026-08-12', plannedDueDate: '2026-08-20', plannedBudgetAmountMinor: 1000,
      plannedScopeItemCount: 1, plannedQualityScore: 95, plannedRiskScore: 5,
      status: 'BASELINED', createdAt: '2026-08-12T00:00:00.000Z',
    };

    const stored = await withTrustScope(scope, async () => {
      await store.append('dependencies', dependency);
      await store.append('performanceBaselines', baseline);
      return (await store.list<{ id: string; [key: string]: unknown }>('dependencies'))[0]!;
    });
    expect(stored.rowVersion).toBe(1);

    expect(
      await withTrustScope(
        { tenantId: OTHER_TENANT, workspaceId: OTHER_WORKSPACE, actorId: ACTOR },
        () => store.list('dependencies'),
      ),
    ).toEqual([]);

    await withTrustScope(scope, () =>
      store.replace('dependencies', {
        ...stored,
        status: 'RESOLVED',
        resolvedAt: '2026-08-12T00:01:00.000Z',
      } as { id: string }),
    );
    await expect(
      withTrustScope(scope, () => store.replace('dependencies', stored as { id: string })),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' } satisfies Partial<PostgresStoreError>);
    await expect(
      withTrustScope(scope, () => store.replace('performanceBaselines', { ...baseline, rowVersion: 1 })),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_HISTORY_IMMUTABLE' } satisfies Partial<PostgresStoreError>);
  }, 300_000);
});
