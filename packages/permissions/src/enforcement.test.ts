import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import {
  PermissionEnforcementError,
  PermissionService,
  TrustStoreMembershipReader,
  enforcePermission,
  resolveMemberships,
  type EnforcementAuthorities,
  type PermissionAuthority,
} from './index';

const WORKSPACE = 'workspace-1';

/** Identity as the gateway produces it: verified, with memberships deliberately empty. */
function gatewayIdentity(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-1',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: WORKSPACE,
    tenantId: 'tenant-1',
    memberships: [],
    correlationId: 'correlation-1',
    ...overrides,
  };
}

async function activeMembership(store: InMemoryTrustStore, userId = 'user-1', workspaceId = WORKSPACE) {
  await store.append('memberships', {
    id: `m-${userId}-${workspaceId}`,
    workspaceId,
    userId,
    status: 'ACTIVE',
  });
}

/** Grants a permission directly, bypassing the granting path's own authorization. */
async function grant(store: InMemoryTrustStore, permissionKey: string, userId = 'user-1') {
  await store.append('permissionGrants', {
    id: `g-${permissionKey}-${userId}`,
    workspaceId: WORKSPACE,
    userId,
    permissionKey,
    effect: 'ALLOW',
    scopeType: 'WORKSPACE',
    sourceType: 'ROLE',
    sourceId: 'role-1',
    effectiveFrom: new Date(Date.now() - 1000).toISOString(),
    createdAt: new Date().toISOString(),
  });
}

function authorities(store: InMemoryTrustStore): EnforcementAuthorities {
  return {
    memberships: new TrustStoreMembershipReader(store),
    permissions: new PermissionService(store),
    store,
  };
}

describe('Engine 03 permission enforcement — membership resolution', () => {
  it('resolves active memberships from the authoritative record', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    expect((await resolveMemberships(gatewayIdentity(), new TrustStoreMembershipReader(store))).memberships).toEqual(
      [WORKSPACE],
    );
  });

  it('ignores memberships that are not active', async () => {
    const store = new InMemoryTrustStore();
    for (const status of ['INVITED', 'SUSPENDED', 'ENDED', 'REVOKED']) {
      await store.append('memberships', {
        id: `m-${status}`,
        workspaceId: `workspace-${status}`,
        userId: 'user-1',
        status,
      });
    }
    expect((await resolveMemberships(gatewayIdentity(), new TrustStoreMembershipReader(store))).memberships).toEqual(
      [],
    );
  });

  it('reads only the requesting user’s memberships', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store, 'someone-else', 'workspace-9');
    expect((await resolveMemberships(gatewayIdentity(), new TrustStoreMembershipReader(store))).memberships).toEqual(
      [],
    );
  });

  it('discards any membership list supplied on the incoming context', async () => {
    // Trusting a caller-supplied membership list would reintroduce exactly the
    // bypass the identity gateway removed.
    const store = new InMemoryTrustStore();
    const forged = gatewayIdentity({ memberships: ['workspace-1', 'workspace-9'] });
    expect((await resolveMemberships(forged, new TrustStoreMembershipReader(store))).memberships).toEqual([]);
  });

  it('rejects an unauthenticated context', async () => {
    const store = new InMemoryTrustStore();
    await expect(await resolveMemberships(
        gatewayIdentity({ actorUserId: '' }),
        new TrustStoreMembershipReader(store),
      )).rejects.toThrow('ENFORCEMENT_UNAUTHENTICATED');
  });
});

describe('Engine 03 permission enforcement — deny by default', () => {
  it('denies when the user holds no grant', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_PERMISSION_DENIED');
  });

  it('allows when an applicable grant exists, returning resolved memberships', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');

    const authorized = await enforcePermission(
      gatewayIdentity(),
      { permissionKey: 'contract:read' },
      authorities(store),
    );
    expect(authorized.memberships).toEqual([WORKSPACE]);
    expect(authorized.actorUserId).toBe('user-1');
  });

  it('denies a permission granted to a different user', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read', 'someone-else');

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_PERMISSION_DENIED');
  });

  it('denies an expired grant', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await store.append('permissionGrants', {
      id: 'g-expired',
      workspaceId: WORKSPACE,
      userId: 'user-1',
      permissionKey: 'contract:read',
      effect: 'ALLOW',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: 'role-1',
      effectiveFrom: new Date(Date.now() - 2000).toISOString(),
      effectiveTo: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_PERMISSION_DENIED');
  });

  it('honours an explicit DENY over an ALLOW', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');
    await store.append('permissionGrants', {
      id: 'g-deny',
      workspaceId: WORKSPACE,
      userId: 'user-1',
      permissionKey: 'contract:read',
      effect: 'DENY',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: 'role-2',
      effectiveFrom: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_PERMISSION_DENIED');
  });
});

describe('Engine 03 permission enforcement — membership is required, not claimed', () => {
  it('denies a caller with no active membership even when the permission is granted', async () => {
    const store = new InMemoryTrustStore();
    await grant(store, 'contract:read');

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_MEMBERSHIP_REQUIRED');
  });

  it('denies membership in a different workspace than the one in context', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store, 'user-1', 'workspace-other');
    await grant(store, 'contract:read');

    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow('ENFORCEMENT_MEMBERSHIP_REQUIRED');
  });

  it('audits a membership denial with a bounded reason', async () => {
    const store = new InMemoryTrustStore();
    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'contract:read' }, authorities(store))).rejects.toThrow(PermissionEnforcementError);

    const records = await store.list<{ eventType: string; metadata: Record<string, unknown> }>(
      'auditRecords',
    );
    expect(records).toHaveLength(1);
    expect(records[0].eventType).toBe('WorkspaceMembershipDenied');
    expect(records[0].metadata.reason).toBe('NO_ACTIVE_MEMBERSHIP');
  });

  it('requires workspace and tenant context before consulting any authority', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');

    for (const missing of [{ activeWorkspaceId: undefined }, { tenantId: undefined }]) {
      await expect(await enforcePermission(
          gatewayIdentity(missing),
          { permissionKey: 'contract:read' },
          authorities(store),
        )).rejects.toThrow('ENFORCEMENT_WORKSPACE_CONTEXT_REQUIRED');
    }
  });
});

describe('Engine 03 permission enforcement — segregation of duties', () => {
  async function blockingRule(store: InMemoryTrustStore) {
    await store.append('segregationRules', {
      id: 'sod-1',
      workspaceId: WORKSPACE,
      ruleKey: 'approve-vs-release',
      firstPermission: 'settlement:approve',
      conflictingPermission: 'settlement:release',
      severity: 'HIGH',
      enforcementMode: 'BLOCK',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      version: 1,
    });
  }

  it('blocks a caller who holds both sides of the pair', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'settlement:approve');
    await grant(store, 'settlement:release');
    await blockingRule(store);

    await expect(await enforcePermission(
        gatewayIdentity(),
        { permissionKey: 'settlement:approve', segregatedFrom: ['settlement:release'] },
        authorities(store),
      )).rejects.toThrow('ENFORCEMENT_SEGREGATION_VIOLATION');
  });

  it('allows a caller who holds only one side, even with the rule active', async () => {
    // Segregation of duties constrains what one principal may hold, so the caller
    // with a single side is the compliant case. Refusing them too would make the
    // permission unusable and invite an operator to delete the rule.
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'settlement:approve');
    await blockingRule(store);

    expect(
      (await enforcePermission(
        gatewayIdentity(),
        { permissionKey: 'settlement:approve', segregatedFrom: ['settlement:release'] },
        authorities(store),
      )).memberships,
    ).toEqual([WORKSPACE]);
  });

  it('blocks in either order, so neither key is the safe one to hold first', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'settlement:approve');
    await grant(store, 'settlement:release');
    await blockingRule(store);

    await expect(await enforcePermission(
        gatewayIdentity(),
        { permissionKey: 'settlement:release', segregatedFrom: ['settlement:approve'] },
        authorities(store),
      )).rejects.toThrow('ENFORCEMENT_SEGREGATION_VIOLATION');
  });

  it('allows when no conflicting rule applies', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'settlement:approve');
    await grant(store, 'settlement:release');

    expect(
      (await enforcePermission(
        gatewayIdentity(),
        { permissionKey: 'settlement:approve', segregatedFrom: ['settlement:release'] },
        authorities(store),
      )).memberships,
    ).toEqual([WORKSPACE]);
  });

  it('does not consult the conflicting permission when none is declared', async () => {
    // A requirement with no declared conflict must not pay for an evaluation, and
    // must not be able to fail on one.
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'settlement:approve');
    await blockingRule(store);

    const consulted: string[] = [];
    const service = new PermissionService(store);
    const stub: PermissionAuthority = {
      requirePermission: async (context, key, scope) => await service.requirePermission(context, key, scope),
      evaluate: async (context, key, scope) => {
        consulted.push(key);
        return await service.evaluate(context, key, scope);
      },
      assertNoSegregationConflict: async (context, keys) =>
        await service.assertNoSegregationConflict(context, keys),
    };

    await enforcePermission(
      gatewayIdentity(),
      { permissionKey: 'settlement:approve' },
      { memberships: new TrustStoreMembershipReader(store), permissions: stub, store },
    );
    expect(consulted).toEqual([]);
  });
});

describe('Engine 03 permission enforcement — authority delegation', () => {
  it('delegates the decision rather than reimplementing it', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);

    const calls: string[] = [];
    const stub: PermissionAuthority = {
      async requirePermission(_context, permissionKey) {
        calls.push(permissionKey);
        return { allowed: true, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async evaluate(_context, permissionKey) {
        calls.push(`evaluate:${permissionKey}`);
        return { allowed: true, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async assertNoSegregationConflict() {
        calls.push('segregation');
      },
    };

    await enforcePermission(
      gatewayIdentity(),
      { permissionKey: 'contract:read', segregatedFrom: ['contract:delete'] },
      { memberships: new TrustStoreMembershipReader(store), permissions: stub, store },
    );

    expect(calls).toEqual(['contract:read', 'evaluate:contract:delete', 'segregation']);
  });

  it('passes the resolved context to the authority, not the incoming one', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);

    let seen: string[] = ['unset'];
    const stub: PermissionAuthority = {
      async requirePermission(context, permissionKey) {
        seen = context.memberships;
        return { allowed: true, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async evaluate(_context, permissionKey) {
        return { allowed: false, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async assertNoSegregationConflict() {},
    };

    await enforcePermission(
      gatewayIdentity(),
      { permissionKey: 'contract:read' },
      { memberships: new TrustStoreMembershipReader(store), permissions: stub, store },
    );

    expect(seen).toEqual([WORKSPACE]);
  });

  it('does not consult the permission authority when membership fails', async () => {
    const store = new InMemoryTrustStore();
    let consulted = false;
    const stub: PermissionAuthority = {
      async requirePermission(_context, permissionKey) {
        consulted = true;
        return { allowed: true, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async evaluate(_context, permissionKey) {
        return { allowed: false, permissionKey, reasons: [], grants: [], denials: [] };
      },
      async assertNoSegregationConflict() {},
    };

    await expect(await enforcePermission(
        gatewayIdentity(),
        { permissionKey: 'contract:read' },
        { memberships: new TrustStoreMembershipReader(store), permissions: stub, store },
      )).rejects.toThrow('ENFORCEMENT_MEMBERSHIP_REQUIRED');
    expect(consulted).toBe(false);
  });
});

describe('Engine 03 permission enforcement — boundary invariants', () => {
  it('adds no authorization data to the returned context beyond resolved memberships', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');

    const identity = gatewayIdentity();
    const authorized = await enforcePermission(
      identity,
      { permissionKey: 'contract:read' },
      authorities(store),
    );

    for (const forbidden of [
      'roles',
      'role',
      'permissions',
      'grants',
      'scopes',
      'policies',
      'entitlements',
      'capabilities',
      'authorization',
    ]) {
      expect(authorized).not.toHaveProperty(forbidden);
    }

    // Identity fields are carried through untouched; only memberships change.
    expect(Object.keys(authorized).sort()).toEqual(Object.keys(identity).sort());
    expect(authorized.identityAssuranceLevel).toBe(identity.identityAssuranceLevel);
  });

  it('never elevates assurance while authorizing', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');

    const identity = gatewayIdentity({ identityAssuranceLevel: 'IAL1_BASIC' });
    expect(
      (await enforcePermission(identity, { permissionKey: 'contract:read' }, authorities(store)))
        .identityAssuranceLevel,
    ).toBe('IAL1_BASIC');
  });

  it('does not mutate the context it was given', async () => {
    const store = new InMemoryTrustStore();
    await activeMembership(store);
    await grant(store, 'contract:read');

    const identity = gatewayIdentity();
    await enforcePermission(identity, { permissionKey: 'contract:read' }, authorities(store));
    expect(identity.memberships).toEqual([]);
  });

  it('raises a typed error for every denial path', async () => {
    const store = new InMemoryTrustStore();
    await expect(await enforcePermission(gatewayIdentity(), { permissionKey: 'x' }, authorities(store))).rejects.toThrow(PermissionEnforcementError);
  });
});
