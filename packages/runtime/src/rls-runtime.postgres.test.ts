import { afterEach, describe, expect, it } from 'vitest';
import { PermissionService, TrustStoreMembershipReader, enforcePermission } from '@assurapay/permissions';
import { certifyRowLevelSecurity, withTrustScope, withoutTrustScope } from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import { createPersistenceRuntime } from './persistence-runtime';
import type { PersistenceRuntime } from './persistence-runtime';
import { loadPersistenceConfig } from './config';

/**
 * integration: the whole application, working against forced Row Level Security.
 *
 * This is the test that decides whether the capability is real or merely present. Policies
 * that deny everything are trivially secure and useless; policies the application bypasses
 * are the defect this capability corrects. Both halves have to hold at once:
 *
 *   a caller inside its own tenant can found a workspace, admit a member, hold a grant and
 *   pass authorization;
 *   the same caller cannot see or touch another tenant's anything;
 *   a caller with no scope sees nothing at all.
 *
 * Composed through `createPersistenceRuntime`, so what is certified is the production path
 * rather than a store a test assembled.
 */

const databaseUrl = requireTestDatabaseUrl();

const disposables: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
});

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b' };

/** A runtime over a schema with both the store and the RLS migrations applied. */
async function rlsRuntime(): Promise<{ runtime: PersistenceRuntime; database: TestDatabase }> {
  // The harness applies the policies by default, because that is the set a host requires.
  const database = await createTestDatabase();
  disposables.push(() => database.dispose());

  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${database.schema}`);

  const runtime = await createPersistenceRuntime({
    config: {
      ...loadPersistenceConfig({
        ASSURAPAY_DEPLOYMENT: 'staging',
        ASSURAPAY_DATABASE_URL: url.toString(),
        ASSURAPAY_DATABASE_SSL: 'require',
      }),
      ssl: 'disable',
    },
  });
  disposables.push(() => runtime.dispose());
  return { runtime, database };
}

const context = (tenant: typeof TENANT_A) => ({
  actorUserId: tenant.userId,
  sessionId: 'session-1',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: tenant.workspaceId,
  tenantId: tenant.tenantId,
  memberships: [tenant.workspaceId],
  correlationId: 'corr-1',
});

const scopeOf = (tenant: typeof TENANT_A) => ({
  tenantId: tenant.tenantId,
  workspaceId: tenant.workspaceId,
  actorId: tenant.userId,
});

/** Founds a tenant's workspace, membership and grant, all inside that tenant's scope. */
async function provision(runtime: PersistenceRuntime, tenant: typeof TENANT_A): Promise<void> {
  await withTrustScope(scopeOf(tenant), async () => {
    await runtime.store.append('trustWorkspaces', {
      id: tenant.workspaceId,
      tenantId: tenant.tenantId,
      name: `Workspace ${tenant.tenantId}`,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      version: 1,
    });
    await runtime.store.append('memberships', {
      id: `membership-${tenant.tenantId}`,
      workspaceId: tenant.workspaceId,
      userId: tenant.userId,
      status: 'ACTIVE',
      role: 'OWNER',
      createdAt: new Date().toISOString(),
      version: 1,
    });
    await new PermissionService(runtime.store).grant(context(tenant), {
      userId: tenant.userId,
      permissionKey: 'settlement:approve',
      effect: 'ALLOW',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: 'OWNER',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
  });
}

describe('integration: the application works with the boundary in force', () => {
  it('provisions and authorizes inside a tenant', async () => {
    // A policy set that denied this would be trivially secure and useless, and the first
    // operator to hit it would drop the policies rather than debug them.
    const { runtime } = await rlsRuntime();
    await provision(runtime, TENANT_A);

    const authorized = await withTrustScope(scopeOf(TENANT_A), () =>
      enforcePermission(
        { ...context(TENANT_A), memberships: [] },
        { permissionKey: 'settlement:approve' },
        {
          memberships: new TrustStoreMembershipReader(runtime.store),
          permissions: new PermissionService(runtime.store),
          store: runtime.store,
        },
      ),
    );

    expect(authorized.memberships).toEqual([TENANT_A.workspaceId]);
  });

  it('certifies the boundary through the same module a deployment gate calls', async () => {
    const { runtime, database } = await rlsRuntime();
    await provision(runtime, TENANT_A);
    await provision(runtime, TENANT_B);

    const certification = await certifyRowLevelSecurity(database.sql, {
      schema: database.schema,
      probe: {
        context: { role: 'assurapay_app', ...TENANT_A, actorId: TENANT_A.userId },
        foreign: TENANT_B,
      },
    });

    expect(certification.findings).toEqual([]);
  });
});

describe('integration: one tenant cannot reach another through the application', () => {
  it('shows a caller only its own workspace, membership and grants', async () => {
    const { runtime } = await rlsRuntime();
    await provision(runtime, TENANT_A);
    await provision(runtime, TENANT_B);

    const seen = await withTrustScope(scopeOf(TENANT_A), async () => ({
      workspaces: await runtime.store.list<{ id: string }>('trustWorkspaces'),
      memberships: await runtime.store.list<{ workspaceId: string }>('memberships'),
      grants: await runtime.store.list<{ workspaceId: string }>('permissionGrants'),
    }));

    expect(seen.workspaces.map((entry) => entry.id)).toEqual([TENANT_A.workspaceId]);
    expect(seen.memberships.map((entry) => entry.workspaceId)).toEqual([TENANT_A.workspaceId]);
    expect(seen.grants.map((entry) => entry.workspaceId)).toEqual([TENANT_A.workspaceId]);
  });

  it('denies authorization for a workspace in another tenant, even with the grant present', async () => {
    // The grant exists and says ALLOW. It belongs to tenant B, so tenant A's connection
    // cannot read it, and membership resolution finds nothing — deny by default, enforced by
    // the database rather than by remembering to filter.
    const { runtime } = await rlsRuntime();
    await provision(runtime, TENANT_B);

    await expect(
      withTrustScope(scopeOf(TENANT_A), () =>
        enforcePermission(
          {
            ...context(TENANT_A),
            activeWorkspaceId: TENANT_B.workspaceId,
            memberships: [],
          },
          { permissionKey: 'settlement:approve' },
          {
            memberships: new TrustStoreMembershipReader(runtime.store),
            permissions: new PermissionService(runtime.store),
            store: runtime.store,
          },
        ),
      ),
    ).rejects.toThrow('ENFORCEMENT_MEMBERSHIP_REQUIRED');
  });

  it('keeps each tenant’s audit history to itself', async () => {
    const { runtime } = await rlsRuntime();
    await provision(runtime, TENANT_A);
    await provision(runtime, TENANT_B);

    const forA = await withTrustScope(scopeOf(TENANT_A), () =>
      runtime.store.list<{ tenantId?: string }>('auditRecords'),
    );
    const forB = await withTrustScope(scopeOf(TENANT_B), () =>
      runtime.store.list<{ tenantId?: string }>('auditRecords'),
    );

    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    expect(forA.every((record) => record.tenantId === TENANT_A.tenantId)).toBe(true);
    expect(forB.every((record) => record.tenantId === TENANT_B.tenantId)).toBe(true);
  });

  it('sees nothing outside a scope, including as the owning role', async () => {
    // FORCE doing its work. Before this capability the same read returned every row.
    const { runtime } = await rlsRuntime();
    await provision(runtime, TENANT_A);

    const unscoped = await withoutTrustScope(async () => ({
      workspaces: await runtime.store.list('trustWorkspaces'),
      grants: await runtime.store.list('permissionGrants'),
      audits: await runtime.store.list('auditRecords'),
    }));

    expect(unscoped.workspaces).toEqual([]);
    expect(unscoped.grants).toEqual([]);
    expect(unscoped.audits).toEqual([]);
  });
});
