import { LegalService } from '@assurapay/legal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  PostgresTrustStore,
  withTrustScope,
  createPostgresPool,
} from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';
import type { TestDatabase } from './index';

requireTestDatabaseUrl();
let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabaseInstance();
  await applyMigrations(database.sql, migrationsDirectory(), {
    appliedBy: 'notification-boundary-test',
  });
}, 300_000);
afterAll(async () => {
  await database?.dispose();
});

describe('integration: notification metadata respects forced RLS', () => {
  it('allows the identity owner and refuses unscoped, other-identity and tenant discovery', async () => {
    const store = new PostgresTrustStore(database.sql);
    await withTrustScope({ actorId: 'identity-a' }, () =>
      store.append('notificationDeliveries', {
        id: 'delivery-a',
        userId: 'identity-a',
        purpose: 'LOGIN',
        status: 'PENDING',
      }),
    );
    expect(
      await withTrustScope({ actorId: 'identity-a' }, () =>
        store.list('notificationDeliveries'),
      ),
    ).toHaveLength(1);
    for (const scope of [
      {},
      { actorId: 'identity-b' },
      { actorId: 'identity-a', tenantId: 'foreign-tenant' },
    ]) {
      expect(
        await withTrustScope(scope, () => store.list('notificationDeliveries')),
      ).toEqual([]);
      await expect(
        withTrustScope(scope, () =>
          store.append('notificationDeliveries', {
            id: 'forged-' + JSON.stringify(scope),
            userId: 'identity-a',
            purpose: 'LOGIN',
            status: 'PENDING',
          }),
        ),
      ).rejects.toThrow();
    }
  });
  it('refuses a pre-tenant business notification or missing purpose', async () => {
    const store = new PostgresTrustStore(database.sql);
    for (const purpose of ['PAYMENT_APPROVAL', undefined]) {
      await expect(
        withTrustScope({ actorId: 'identity-a' }, () =>
          store.append('notificationDeliveries', {
            id: 'invalid-' + purpose,
            userId: 'identity-a',
            purpose,
            status: 'PENDING',
          }),
        ),
      ).rejects.toThrow();
    }
  });
});

describe('integration: calendar dates are independent of session timezone', () => {
  it('preserves PostgreSQL DATE wire values in western and eastern timezones', async () => {
    const pool = createPostgresPool({
      databaseUrl: requireTestDatabaseUrl(),
      max: 1,
    });
    try {
      for (const zone of ['America/Chicago', 'Pacific/Auckland', 'UTC']) {
        await pool.sql.begin(async (sql) => {
          await sql`SELECT set_config('TimeZone', ${zone}, true)`;
          const [row] = await sql<
            { day: string }[]
          >`SELECT DATE '2026-07-31' AS day`;
          expect(row.day).toBe('2026-07-31');
        });
      }
    } finally {
      await pool.dispose();
    }
  });
});

describe('integration: canonical agreement intake persistence', () => {
  it('round trips through the production store, isolates workspaces and freezes reviewed facts', async () => {
    const scope = {tenantId: 'intake-tenant', workspaceId: 'intake-workspace', actorId: 'intake-author'};
    const store = new PostgresTrustStore(database.sql);
    const record = {id: 'intake-1', workspaceId: scope.workspaceId, sourceType: 'DIRECT_DESCRIPTION', sourceArtifactIds: [], sourceHash: 'a'.repeat(64), proposedTerms: [{key: 'title', value: 'Reviewed work'}], clarifications: [], clarityScore: 100, status: 'READY_FOR_REVIEW', createdBy: scope.actorId, createdAt: '2026-09-15T00:00:00.000Z'};
    await withTrustScope(scope, async () => {
      await store.append('trustWorkspaces', {id: scope.workspaceId, tenantId: scope.tenantId, status: 'ACTIVE', version: 1});
      await store.append('agreementIntakes', record);
      expect(await store.list('agreementIntakes')).toEqual([record]);
      await store.replace('agreementIntakes', {...record, status: 'REVIEWED', reviewedBy: 'reviewer', reviewedAt: '2026-09-15T01:00:00.000Z'});
    });
    for (const foreign of [{}, {...scope, tenantId: 'foreign'}, {...scope, workspaceId: 'foreign'}]) {
      expect(await withTrustScope(foreign, () => store.list('agreementIntakes'))).toEqual([]);
      await expect(withTrustScope(foreign, () => store.append('agreementIntakes', {...record, id: 'forged'}))).rejects.toThrow();
    }
    await withTrustScope(scope, async () => {
      const [reviewed] = await store.list<typeof record & {reviewedBy: string; reviewedAt: string}>('agreementIntakes');
      await expect(store.replace('agreementIntakes', {...reviewed, proposedTerms: []})).rejects.toThrow('PERSISTENCE_HISTORY_IMMUTABLE');
      await store.replace('agreementIntakes', {...reviewed, status: 'CONVERTED', convertedAgreementId: 'agreement-1'});
      await expect(store.replace('agreementIntakes', {...reviewed, status: 'CONVERTED', convertedAgreementId: 'agreement-2'})).rejects.toThrow('PERSISTENCE_HISTORY_IMMUTABLE');
      expect((await store.list<{convertedAgreementId: string}>('agreementIntakes'))[0].convertedAgreementId).toBe('agreement-1');
    });
  });
});


describe('integration: legal policies have explicit workspace scope', () => {
  it('keeps versions private, refuses global creation and retains exact-version acceptance', async () => {
    const scope = {tenantId: 'legal-tenant', workspaceId: 'legal-workspace', actorId: 'legal-author'};
    const context = {tenantId: scope.tenantId, activeWorkspaceId: scope.workspaceId, actorUserId: scope.actorId, sessionId: 'legal-session', identityAssuranceLevel: 'IAL2_VERIFIED' as const, memberships: [scope.workspaceId], correlationId: 'legal-scope-test'};
    const store = new PostgresTrustStore(database.sql);
    const service = new LegalService(store);
    await withTrustScope(scope, async () => {
      await store.append('trustWorkspaces', {id: scope.workspaceId, tenantId: scope.tenantId, status: 'ACTIVE', version: 1});
      await expect(service.createPolicy(context, {policyKey: 'global', name: 'Global', policyType: 'TERMS', global: true})).rejects.toThrow('GLOBAL_POLICY_ADMINISTRATION_UNAVAILABLE');
      const policy = await service.createPolicy(context, {policyKey: 'terms', name: 'Terms', policyType: 'TERMS'});
      const draft = await service.createVersion(context, policy.id, {contentReference: 'policy://terms/1', content: 'Reviewed terms', effectiveFrom: '2026-09-15T00:00:00.000Z'});
      const published = await service.publishVersion(context, draft.id);
      expect(published.workspaceId).toBe(scope.workspaceId);
      await expect(store.replace('legalPolicyVersions', {...published, contentHash: 'b'.repeat(64)})).rejects.toThrow('PERSISTENCE_HISTORY_IMMUTABLE');
      const accepted = await service.acceptPolicy(context, published.id, {principalType: 'USER', principalId: scope.actorId, acceptanceMethod: 'CLICKWRAP', sourceContext: 'web', evidenceReference: 'audit://acceptance'});
      expect(accepted.legalPolicyVersionId).toBe(published.id);
    });
    for (const foreign of [{}, {...scope, tenantId: 'foreign'}, {...scope, workspaceId: 'foreign'}]) {
      expect(await withTrustScope(foreign, () => store.list('legalPolicies'))).toEqual([]);
      expect(await withTrustScope(foreign, () => store.list('legalPolicyVersions'))).toEqual([]);
    }
  });
});
