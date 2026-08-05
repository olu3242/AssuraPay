import { describe, expect, it } from 'vitest';
import { catalogueKeys, requireRole } from '@assurapay/permissions';
import {
  GRANT_ADMINISTRATION_ROUTES,
  listRoles,
} from './grant-administration';
import { ROUTE_PERMISSION_REQUIREMENTS, requirementForRoute } from './route-permissions';

/**
 * These assertions are about policy, not about the composition root: importing the
 * handlers would pull in the whole engine graph and a shared mutable store, which
 * would make one test's grants visible to the next. The behaviour of founding and
 * assignment is covered where it lives, in packages/permissions.
 */

describe('grant administration — the routes are classed as documented', () => {
  it('declares each route with a rationale', () => {
    expect(GRANT_ADMINISTRATION_ROUTES.length).toBeGreaterThanOrEqual(3);
    for (const route of GRANT_ADMINISTRATION_ROUTES) {
      expect(route.template.startsWith('/api/'), route.template).toBe(true);
      expect(['GET', 'POST'], route.template).toContain(route.method);
      expect(route.rationale.length, route.template).toBeGreaterThan(40);
    }
  });

  it('matches the policy table entry for every route it declares', () => {
    // The declaration here is documentation; the table is what enforcement reads.
    // If they disagreed, the rationale would describe a rule that is not in force.
    for (const route of GRANT_ADMINISTRATION_ROUTES) {
      expect(
        requirementForRoute(route.template, route.method).access,
        `${route.method} ${route.template}`,
      ).toBe(route.access);
    }
  });

  it('keeps founding identity-class, because it creates the first grant', () => {
    // Requiring a permission to found would restore exactly the deadlock the
    // catalogue exists to break: no grant can be made in a workspace with no grants.
    expect(requirementForRoute('/api/v1/workspaces/w-1/found', 'POST').access).toBe(
      'identity',
    );
  });

  it('gates reading and assigning roles behind permissions', () => {
    expect(requirementForRoute('/api/v1/roles', 'GET')).toMatchObject({
      access: 'permission',
      permissionKey: 'roles:read',
    });
    expect(requirementForRoute('/api/v1/roles/assignments', 'POST')).toMatchObject({
      access: 'permission',
      permissionKey: 'roles:assign',
    });
  });

  it('exposes no route for revoking or editing a grant directly', () => {
    // Grants are made by assigning a catalogue role. A direct grant surface would
    // bypass the segregation-of-duties check that assignment performs.
    const direct = Object.keys(ROUTE_PERMISSION_REQUIREMENTS).filter((key) =>
      /permission-grants|grants\//.test(key),
    );
    expect(direct).toEqual([]);
  });
});

describe('grant administration — the administrator can actually administer', () => {
  it('grants the founding role the keys its own routes require', () => {
    // Founding a workspace and then being unable to assign a role would leave the
    // deployment exactly as stuck as before.
    const administrator = requireRole('WORKSPACE_ADMINISTRATOR').permissionKeys;
    expect(administrator).toContain('roles:read');
    expect(administrator).toContain('roles:assign');
  });

  it('keeps the new keys inside the catalogue inventory', () => {
    const inventory = new Set(catalogueKeys());
    expect(inventory).toContain('roles:read');
    expect(inventory).toContain('roles:assign');
  });

  it('still gives the administrator no money-movement or certification key', () => {
    // Adding role administration must not quietly turn the founding role into a
    // superuser.
    const administrator = requireRole('WORKSPACE_ADMINISTRATOR').permissionKeys;
    for (const key of administrator) {
      expect(
        /^(payment-instructions|release-requests|fund-reservations|financial-entitlements|invoices|ledger-entries|completion-certificates|certification-requests)/.test(
          key,
        ),
        `${key} must not be a founding grant`,
      ).toBe(false);
    }
  });
});

describe('grant administration — the role listing an operator chooses from', () => {
  it('reports every catalogue role with the reasoning behind it', () => {
    const roles = listRoles();
    expect(roles).toHaveLength(10);
    for (const role of roles) {
      expect(role.rationale.length, role.role).toBeGreaterThan(40);
      expect(role.permissionKeys.length, role.role).toBeGreaterThan(0);
    }
  });

  it('marks exactly one role bootstrappable', () => {
    expect(
      listRoles()
        .filter((role) => role.bootstrappable)
        .map((role) => role.role),
    ).toEqual(['WORKSPACE_ADMINISTRATOR']);
  });

  it('copies the key list, so a caller cannot mutate the catalogue through it', () => {
    const first = listRoles()[0];
    first.permissionKeys.push('payment-instructions:submit');
    expect(listRoles()[0].permissionKeys).not.toContain('payment-instructions:submit');
  });

  it('says which roles are segregated, not just what they hold', () => {
    // An operator choosing between these two needs to know they are exclusive; a
    // bare key list does not say so.
    const summaries = Object.fromEntries(listRoles().map((role) => [role.role, role]));
    expect(summaries.SETTLEMENT_APPROVER.rationale.toLowerCase()).toContain('segregated');
    expect(summaries.PAYMENT_OPERATOR.rationale.toLowerCase()).toContain('segregated');
  });
});
