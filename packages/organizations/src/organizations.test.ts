import { describe, expect, it } from 'vitest'; import { InMemoryTrustStore } from '@assurapay/database'; import { OrganizationService } from './index';

/**
 * `tenantId` is now an input to `createWorkspace` rather than a fresh `randomUUID()` per workspace, so this
 * suite can do what it could not before: put two workspaces in **one** tenant. That is the case worth
 * testing, because row-level security is tenant-scoped — it does not separate two workspaces of the same
 * tenant, and `requireMembership` is the only thing that does. When every workspace minted its own tenant the
 * cross-workspace assertion below was being carried by the tenancy boundary rather than by the membership
 * check it names.
 */
describe('Engine 02 multi-tenancy', () => { it('creates owner membership, validates active context, denies cross-workspace access inside one tenant, and blocks hierarchy cycles', async () => { const store = new InMemoryTrustStore(); const service = new OrganizationService(store); const tenantId = 'tenant-shared'; const a = await service.createWorkspace({ tenantId, workspaceType: 'ORGANIZATION', name: 'A', slug: 'a', ownerUserId: 'owner-a', defaultCurrency: 'NGN', timezone: 'Africa/Lagos', countryCode: 'NG', correlationId: 'c1' }); const b = await service.createWorkspace({ tenantId, workspaceType: 'ORGANIZATION', name: 'B', slug: 'b', ownerUserId: 'owner-b', defaultCurrency: 'NGN', timezone: 'Africa/Lagos', countryCode: 'NG', correlationId: 'c2' });
  // Both in one tenant, which is what the composite (tenant_id, workspace_id) keys every batch carries have
  // always assumed and the identity model previously made impossible.
  expect(a.tenantId).toBe(tenantId); expect(b.tenantId).toBe(tenantId);
  // `correlationId` identifies the request, not the workspace, and `...input` had been persisting it onto the
  // aggregate.
  expect(a).not.toHaveProperty('correlationId');
  expect((await service.listAuthorizedWorkspaces('owner-a')).map((x) => x.id)).toEqual([a.id]); await expect(service.activateContext('owner-a', b.id, 's', 'IAL1_BASIC')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
  // Same slug, different tenant, accepted: the rule is per tenant, so one tenant cannot hold a name against
  // every other tenant on the deployment.
  const elsewhere = await service.createWorkspace({ tenantId: 'tenant-other', workspaceType: 'ORGANIZATION', name: 'A', slug: 'a', ownerUserId: 'owner-c', defaultCurrency: 'NGN', timezone: 'Africa/Lagos', countryCode: 'NG', correlationId: 'c3' }); expect(elsewhere.slug).toBe('a');
  const context = await service.activateContext('owner-a', a.id, 's', 'IAL1_BASIC'); const org = await service.createOrganization(context, { legalName: 'A Ltd', organizationType: 'LIMITED', industry: 'Tech', businessSize: 'SME', countryCode: 'NG', registeredAddress: 'Test address' }); const parent = await service.createUnit(context, { organizationId: org.id, unitType: 'DEPARTMENT', name: 'Parent', code: 'P' }); const child = await service.createUnit(context, { organizationId: org.id, parentUnitId: parent.id, unitType: 'TEAM', name: 'Child', code: 'C' }); await expect(service.moveUnit(parent.id, child.id, context)).rejects.toThrow('ORGANIZATION_HIERARCHY_CYCLE'); }); });
