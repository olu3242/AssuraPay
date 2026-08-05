import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import {
  CatalogueError,
  PERMISSION_CATALOGUE,
  PermissionService,
  SEGREGATION_CATALOGUE,
  bootstrapWorkspaceGrants,
  catalogueKeys,
  catalogueRoles,
  grantRole,
  heldPermissionKeys,
  loadCatalogueConfig,
  requireRole,
  segregationConflicts,
  type PermissionGrant,
  type SegregationRule,
} from './index';

const TENANT = 'tenant-1';
const WORKSPACE = 'workspace-1';
const FOUNDER = 'user-founder';
const config = loadCatalogueConfig({});

async function ownerMembership(store: InMemoryTrustStore, userId = FOUNDER, status = 'ACTIVE') {
  await store.append('memberships', {
    id: `m-${userId}`,
    workspaceId: WORKSPACE,
    userId,
    membershipType: 'OWNER',
    status,
    invitedBy: userId,
    invitedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  });
}

async function founded() {
  const store = new InMemoryTrustStore();
  await ownerMembership(store);
  const bootstrap = await bootstrapWorkspaceGrants(
    store,
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      founderUserId: FOUNDER,
      correlationId: 'corr-1',
    },
    config,
  );
  return { store, bootstrap };
}

function adminContext(): RequestContext {
  return {
    actorUserId: FOUNDER,
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: WORKSPACE,
    tenantId: TENANT,
    memberships: [WORKSPACE],
    correlationId: 'corr-2',
  };
}

describe('Engine 03 grant catalogue — shape', () => {
  it('names a unique, non-empty role for every definition', () => {
    expect(catalogueRoles()).toEqual([...new Set(catalogueRoles())]);
    for (const definition of PERMISSION_CATALOGUE) {
      expect(definition.role.length, definition.role).toBeGreaterThan(0);
      expect(definition.title.length, definition.role).toBeGreaterThan(0);
      expect(definition.rationale.length, definition.role).toBeGreaterThan(0);
      expect(definition.permissionKeys.length, definition.role).toBeGreaterThan(0);
    }
  });

  it('uses resource:action keys with no empty half and no duplicates in a role', () => {
    for (const definition of PERMISSION_CATALOGUE) {
      expect([...new Set(definition.permissionKeys)], definition.role).toEqual([
        ...definition.permissionKeys,
      ]);
      for (const key of definition.permissionKeys) {
        const [resource, action, ...rest] = key.split(':');
        expect(rest, key).toEqual([]);
        expect(resource.length, key).toBeGreaterThan(0);
        expect(action.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('exposes exactly one bootstrappable role', () => {
    // More than one would mean more than one way to obtain authority with no
    // authorizing caller.
    const bootstrappable = PERMISSION_CATALOGUE.filter(
      (definition) => definition.bootstrappable,
    );
    expect(bootstrappable.map((definition) => definition.role)).toEqual([
      'WORKSPACE_ADMINISTRATOR',
    ]);
  });

  it('refuses to resolve an unknown role rather than returning undefined', () => {
    expect(() => requireRole('ROOT')).toThrow('CATALOGUE_UNKNOWN_ROLE');
    expect(() => requireRole('ROOT')).toThrow(CatalogueError);
  });

  it('reports a sorted, deduplicated key inventory', () => {
    const keys = catalogueKeys();
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(140);
  });
});

describe('Engine 03 grant catalogue — no superuser', () => {
  it('grants no role the whole inventory', () => {
    // A role holding every key would make every segregation rule vacuous.
    const total = catalogueKeys().length;
    for (const definition of PERMISSION_CATALOGUE) {
      expect(definition.permissionKeys.length, definition.role).toBeLessThan(total);
    }
  });

  it('keeps the founding administrator away from money and certification', () => {
    const founder = requireRole('WORKSPACE_ADMINISTRATOR');
    for (const key of founder.permissionKeys) {
      expect(
        /^(payment-instructions|release-requests|fund-reservations|financial-entitlements|funding-commitments|invoices|ledger-entries|final-settlement-accounts|reconciliation-records|completion-certificates|certification-requests|payment-eligibilit)/.test(
          key,
        ),
        `${key} must not be a founding grant`,
      ).toBe(false);
    }
  });

  it('never puts both sides of a duty pair in one role', () => {
    for (const definition of PERMISSION_CATALOGUE) {
      expect(
        segregationConflicts(definition.permissionKeys).map((rule) => rule.ruleKey),
        definition.role,
      ).toEqual([]);
    }
  });

  it('separates release approval from payment execution across roles', () => {
    const approver = requireRole('SETTLEMENT_APPROVER').permissionKeys;
    const operator = requireRole('PAYMENT_OPERATOR').permissionKeys;

    expect(approver).toContain('release-requests:evaluate');
    expect(operator).toContain('payment-instructions:submit');
    expect(approver).not.toContain('payment-instructions:submit');
    expect(operator).not.toContain('release-requests:evaluate');
  });
});

describe('Engine 03 segregation catalogue', () => {
  it('declares a unique rule key and a distinct pair for every rule', () => {
    const keys = SEGREGATION_CATALOGUE.map((rule) => rule.ruleKey);
    expect(keys).toEqual([...new Set(keys)]);
    for (const rule of SEGREGATION_CATALOGUE) {
      expect(rule.firstPermission, rule.ruleKey).not.toBe(rule.conflictingPermission);
      expect(rule.rationale.length, rule.ruleKey).toBeGreaterThan(0);
    }
  });

  it('constrains only permissions the catalogue can actually grant', () => {
    // A rule naming a key no role holds is decoration: it can never fire.
    const known = new Set(catalogueKeys());
    for (const rule of SEGREGATION_CATALOGUE) {
      expect(known, rule.ruleKey).toContain(rule.firstPermission);
      expect(known, rule.ruleKey).toContain(rule.conflictingPermission);
    }
  });

  it('detects a conflict regardless of which side was acquired first', () => {
    const pair = ['release-requests:evaluate', 'payment-instructions:submit'];
    expect(segregationConflicts(pair)).toHaveLength(1);
    expect(segregationConflicts([...pair].reverse())).toHaveLength(1);
    expect(segregationConflicts([pair[0]])).toEqual([]);
  });
});

describe('Engine 03 catalogue configuration', () => {
  it('defaults the founding path on, with the administrator role', () => {
    expect(loadCatalogueConfig({})).toEqual({
      bootstrapEnabled: true,
      bootstrapRole: 'WORKSPACE_ADMINISTRATOR',
    });
  });

  it('reads the flag from configuration', () => {
    expect(loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ENABLED: 'false' }).bootstrapEnabled).toBe(
      false,
    );
    expect(loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ENABLED: '0' }).bootstrapEnabled).toBe(
      false,
    );
    expect(loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ENABLED: 'TRUE' }).bootstrapEnabled).toBe(
      true,
    );
  });

  it('rejects an unparseable flag rather than coercing it to a default', () => {
    // Coercing 'no' to true would enable the founding path in a deployment that
    // tried to turn it off.
    expect(() => loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ENABLED: 'no' })).toThrow(
      'CATALOGUE_CONFIG_INVALID',
    );
  });

  it('refuses a configured role that is unknown or not bootstrappable', () => {
    expect(() => loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ROLE: 'ROOT' })).toThrow(
      'CATALOGUE_CONFIG_INVALID',
    );
    expect(() =>
      loadCatalogueConfig({ PERMISSION_BOOTSTRAP_ROLE: 'PAYMENT_OPERATOR' }),
    ).toThrow('CATALOGUE_CONFIG_INVALID');
  });
});

describe('Engine 03 workspace founding', () => {
  it('grants the founding role and installs every segregation rule', async () => {
    const { store, bootstrap } = await founded();

    expect(bootstrap.role).toBe('WORKSPACE_ADMINISTRATOR');
    expect(bootstrap.grantIds).toHaveLength(
      requireRole('WORKSPACE_ADMINISTRATOR').permissionKeys.length,
    );
    expect(bootstrap.segregationRuleIds).toHaveLength(SEGREGATION_CATALOGUE.length);
    expect(
      (await store
        .list<SegregationRule>('segregationRules'))
        .map((rule) => rule.ruleKey)
        .sort(),
    ).toEqual(SEGREGATION_CATALOGUE.map((rule) => rule.ruleKey).sort());
  });

  it('installs the rules as active and blocking, not advisory', async () => {
    const { store } = await founded();
    for (const rule of await store.list<SegregationRule>('segregationRules')) {
      expect(rule.status, rule.ruleKey).toBe('ACTIVE');
      expect(rule.enforcementMode, rule.ruleKey).toBe('BLOCK');
    }
  });

  it('produces grants the evaluator immediately honours', async () => {
    // The point of founding is that the administrator can act at once; a grant the
    // evaluator rejects would leave the workspace exactly as stuck as before.
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();

    expect((await service.evaluate(context, 'workspaces:create')).allowed).toBe(true);
    expect((await service.evaluate(context, 'payment-instructions:submit')).allowed).toBe(false);
  });

  it('attributes every grant to the role rather than to an anonymous source', async () => {
    const { store } = await founded();
    for (const grant of await store.list<PermissionGrant>('permissionGrants')) {
      expect(grant.sourceType).toBe('ROLE');
      expect(grant.sourceId).toBe('WORKSPACE_ADMINISTRATOR');
      expect(grant.effect).toBe('ALLOW');
      expect(grant.workspaceId).toBe(WORKSPACE);
    }
  });

  it('records the founding act in the audit trail and the outbox', async () => {
    const { store } = await founded();

    const audit = (await store
      .list<{ eventType: string; metadata: Record<string, unknown> }>('auditRecords'))
      .filter((record) => record.eventType === 'WorkspaceGrantsBootstrapped');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      role: 'WORKSPACE_ADMINISTRATOR',
      authorizedBy: 'FOUNDING_MEMBERSHIP',
    });

    expect(
      (await store
        .list<{ eventType: string }>('outboxEvents'))
        .filter((event) => event.eventType === 'WorkspaceGrantsBootstrapped'),
    ).toHaveLength(1);
  });

  it('uses the injected clock rather than wall time', async () => {
    const store = new InMemoryTrustStore();
    await ownerMembership(store);
    await bootstrapWorkspaceGrants(
      store,
      {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        founderUserId: FOUNDER,
        correlationId: 'corr-1',
        now: () => new Date('2026-03-01T00:00:00.000Z'),
      },
      config,
    );

    for (const grant of await store.list<PermissionGrant>('permissionGrants')) {
      expect(grant.createdAt).toBe('2026-03-01T00:00:00.000Z');
      expect(grant.effectiveFrom).toBe('2026-03-01T00:00:00.000Z');
    }
  });
});

describe('Engine 03 workspace founding — refusals', () => {
  it('requires an active owner membership rather than creating one', async () => {
    // Founding must not be able to invent a principal: the workspace owner is
    // established when the workspace is created, and this only grants to them.
    const store = new InMemoryTrustStore();
    await expect(await bootstrapWorkspaceGrants(
        store,
        {
          tenantId: TENANT,
          workspaceId: WORKSPACE,
          founderUserId: FOUNDER,
          correlationId: 'corr-1',
        },
        config,
      )).rejects.toThrow('CATALOGUE_MEMBERSHIP_REQUIRED');
    expect(await store.list('permissionGrants')).toEqual([]);
    expect(await store.list('memberships')).toEqual([]);
  });

  it('refuses a suspended owner and a non-owner member', async () => {
    for (const [userId, status, membershipType] of [
      [FOUNDER, 'SUSPENDED', 'OWNER'],
      [FOUNDER, 'ACTIVE', 'MEMBER'],
    ] as const) {
      const store = new InMemoryTrustStore();
      await store.append('memberships', {
        id: 'm-1',
        workspaceId: WORKSPACE,
        userId,
        membershipType,
        status,
        invitedBy: userId,
        invitedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      });

      await expect(await bootstrapWorkspaceGrants(
          store,
          {
            tenantId: TENANT,
            workspaceId: WORKSPACE,
            founderUserId: FOUNDER,
            correlationId: 'corr-1',
          },
          config,
        )).rejects.toThrow('CATALOGUE_MEMBERSHIP_REQUIRED');
    }
  });

  it('refuses a second founding, so it is not a standing escalation route', async () => {
    const { store } = await founded();
    await ownerMembership(store, 'user-second');

    await expect(await bootstrapWorkspaceGrants(
        store,
        {
          tenantId: TENANT,
          workspaceId: WORKSPACE,
          founderUserId: 'user-second',
          correlationId: 'corr-3',
        },
        config,
      )).rejects.toThrow('CATALOGUE_ALREADY_BOOTSTRAPPED');
  });

  it('refuses any role that is not marked bootstrappable', async () => {
    const store = new InMemoryTrustStore();
    await ownerMembership(store);

    await expect(await bootstrapWorkspaceGrants(
        store,
        {
          tenantId: TENANT,
          workspaceId: WORKSPACE,
          founderUserId: FOUNDER,
          correlationId: 'corr-1',
          role: 'PAYMENT_OPERATOR',
        },
        config,
      )).rejects.toThrow('CATALOGUE_ROLE_NOT_BOOTSTRAPPABLE');
    expect(await store.list('permissionGrants')).toEqual([]);
  });

  it('is unreachable when configuration disables it', async () => {
    const store = new InMemoryTrustStore();
    await ownerMembership(store);

    await expect(await bootstrapWorkspaceGrants(
        store,
        {
          tenantId: TENANT,
          workspaceId: WORKSPACE,
          founderUserId: FOUNDER,
          correlationId: 'corr-1',
        },
        { bootstrapEnabled: false, bootstrapRole: 'WORKSPACE_ADMINISTRATOR' },
      )).rejects.toThrow('CATALOGUE_BOOTSTRAP_DISABLED');
    expect(await store.list('permissionGrants')).toEqual([]);
  });

  it('leaves a tightened existing rule alone rather than rewriting it', async () => {
    const store = new InMemoryTrustStore();
    await ownerMembership(store);
    await store.append('segregationRules', {
      id: 'pre-existing',
      workspaceId: WORKSPACE,
      ruleKey: SEGREGATION_CATALOGUE[0].ruleKey,
      firstPermission: SEGREGATION_CATALOGUE[0].firstPermission,
      conflictingPermission: SEGREGATION_CATALOGUE[0].conflictingPermission,
      severity: 'CRITICAL',
      enforcementMode: 'BLOCK',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      version: 7,
    });

    const bootstrap = await bootstrapWorkspaceGrants(
      store,
      {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        founderUserId: FOUNDER,
        correlationId: 'corr-1',
      },
      config,
    );

    expect(bootstrap.segregationRuleIds).toHaveLength(SEGREGATION_CATALOGUE.length - 1);
    const preserved = (await store
      .list<SegregationRule>('segregationRules'))
      .find((rule) => rule.id === 'pre-existing');
    expect(preserved?.version).toBe(7);
  });
});

describe('Engine 03 role granting', () => {
  it('grants every key in the role and attributes it to the role', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const granted = await grantRole(service, store, adminContext(), {
      userId: 'user-approver',
      role: 'SETTLEMENT_APPROVER',
    });

    expect(granted.map((grant) => grant.permissionKey).sort()).toEqual(
      [...requireRole('SETTLEMENT_APPROVER').permissionKeys].sort(),
    );
    for (const grant of granted) {
      expect(grant.sourceId).toBe('SETTLEMENT_APPROVER');
      expect(grant.userId).toBe('user-approver');
    }
  });

  it('refuses a role that would complete a duty pair, and writes nothing', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();
    await grantRole(service, store, context, {
      userId: 'user-approver',
      role: 'SETTLEMENT_APPROVER',
    });
    const before = (await store.list('permissionGrants')).length;

    await expect(await grantRole(service, store, context, {
        userId: 'user-approver',
        role: 'PAYMENT_OPERATOR',
      })).rejects.toThrow('CATALOGUE_SEGREGATION_CONFLICT');
    expect(await store.list('permissionGrants')).toHaveLength(before);
  });

  it('refuses in both orders, so neither role is a back door to the other', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();
    await grantRole(service, store, context, { userId: 'user-ops', role: 'PAYMENT_OPERATOR' });

    await expect(await grantRole(service, store, context, {
        userId: 'user-ops',
        role: 'SETTLEMENT_APPROVER',
      })).rejects.toThrow('CATALOGUE_SEGREGATION_CONFLICT');
  });

  it('audits the refusal, naming the rule that blocked it', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();
    await grantRole(service, store, context, { userId: 'user-ops', role: 'PAYMENT_OPERATOR' });

    try {
      await grantRole(service, store, context, {
        userId: 'user-ops',
        role: 'SETTLEMENT_APPROVER',
      });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogueError);
    }

    const violation = (await store
      .list<{ eventType: string; metadata: Record<string, unknown> }>('auditRecords'))
      .filter((record) => record.eventType === 'SegregationOfDutiesViolationDetected');
    expect(violation).toHaveLength(1);
    expect(violation[0].metadata.blockedAt).toBe('GRANT');
    expect(violation[0].metadata.ruleKeys).toContain('release-approval-vs-payment-execution');
  });

  it('grants two non-conflicting roles to the same user', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();

    await grantRole(service, store, context, { userId: 'user-a', role: 'CONTRACT_AUTHOR' });
    await expect(await grantRole(service, store, context, { userId: 'user-a', role: 'ASSURANCE_ANALYST' })).resolves.not.toThrow();
  });

  it('does not re-grant a key the user already holds', async () => {
    // Overlapping roles share `contracts:read`; a second grant of it would be a
    // duplicate row that changes no decision.
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();

    await grantRole(service, store, context, { userId: 'user-a', role: 'CONTRACT_AUTHOR' });
    const second = await grantRole(service, store, context, {
      userId: 'user-a',
      role: 'ASSURANCE_ANALYST',
    });

    expect(second.map((grant) => grant.permissionKey)).not.toContain('contracts:read');
    expect(second.map((grant) => grant.permissionKey)).toContain('dashboard-snapshots:create');
  });

  it('is a no-op when the same role is granted twice', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    const context = adminContext();

    await grantRole(service, store, context, { userId: 'user-a', role: 'DISPUTE_MANAGER' });
    expect(
      await grantRole(service, store, context, { userId: 'user-a', role: 'DISPUTE_MANAGER' }),
    ).toEqual([]);
  });

  it('refuses an unknown role', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    await expect(await grantRole(service, store, adminContext(), { userId: 'user-a', role: 'ROOT' })).rejects.toThrow('CATALOGUE_UNKNOWN_ROLE');
  });

  it('requires a workspace context', async () => {
    const { store } = await founded();
    const service = new PermissionService(store);
    await expect(await grantRole(
        service,
        store,
        { ...adminContext(), memberships: [] },
        { userId: 'user-a', role: 'DISPUTE_MANAGER' },
      )).rejects.toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });
});

describe('Engine 03 held permissions', () => {
  it('counts a delegated grant towards a conflict, not only a role grant', async () => {
    // Delegation writes grants with sourceType DELEGATION; ignoring those would let
    // a delegated payment key sit alongside release approval undetected.
    const { store } = await founded();
    await store.append<PermissionGrant>('permissionGrants', {
      id: 'delegated-1',
      workspaceId: WORKSPACE,
      userId: 'user-approver',
      permissionKey: 'payment-instructions:submit',
      effect: 'ALLOW',
      scopeType: 'WORKSPACE',
      sourceType: 'DELEGATION',
      sourceId: 'delegation-1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const service = new PermissionService(store);
    await expect(await grantRole(service, store, adminContext(), {
        userId: 'user-approver',
        role: 'SETTLEMENT_APPROVER',
      })).rejects.toThrow('CATALOGUE_SEGREGATION_CONFLICT');
  });

  it('ignores an expired grant and a grant that is not yet effective', async () => {
    const store = new InMemoryTrustStore();
    const base = {
      workspaceId: WORKSPACE,
      userId: 'user-a',
      effect: 'ALLOW' as const,
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE' as const,
      sourceId: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await store.append<PermissionGrant>('permissionGrants', {
      ...base,
      id: 'expired',
      permissionKey: 'a:read',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-02-01T00:00:00.000Z',
    });
    await store.append<PermissionGrant>('permissionGrants', {
      ...base,
      id: 'future',
      permissionKey: 'b:read',
      effectiveFrom: '2027-01-01T00:00:00.000Z',
    });
    await store.append<PermissionGrant>('permissionGrants', {
      ...base,
      id: 'current',
      permissionKey: 'c:read',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    expect([
      ...await heldPermissionKeys(store, WORKSPACE, 'user-a', new Date('2026-06-01T00:00:00.000Z')),
    ]).toEqual(['c:read']);
  });

  it('ignores a DENY grant, which removes rather than confers a permission', async () => {
    const store = new InMemoryTrustStore();
    await store.append<PermissionGrant>('permissionGrants', {
      id: 'denied',
      workspaceId: WORKSPACE,
      userId: 'user-a',
      permissionKey: 'payment-instructions:submit',
      effect: 'DENY',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: 'r',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect((await heldPermissionKeys(store, WORKSPACE, 'user-a')).size).toBe(0);
  });

  it('scopes held permissions to one workspace and one user', async () => {
    const { store } = await founded();
    expect((await heldPermissionKeys(store, 'other-workspace', FOUNDER)).size).toBe(0);
    expect((await heldPermissionKeys(store, WORKSPACE, 'someone-else')).size).toBe(0);
    expect((await heldPermissionKeys(store, WORKSPACE, FOUNDER)).size).toBeGreaterThan(0);
  });
});
