import { describe, expect, it } from 'vitest';
import { SEGREGATION_CATALOGUE, catalogueKeys } from '@assurapay/permissions';
import {
  ROUTE_PERMISSION_REQUIREMENTS,
  RouteAccessError,
  requirementForRoute,
  routePermissionKeys,
} from './route-permissions';

function permissionEntries() {
  return Object.entries(ROUTE_PERMISSION_REQUIREMENTS).filter(
    ([, entry]) => entry.access === 'permission',
  );
}

describe('route permission policy — coverage', () => {
  it('classifies every route in the table', () => {
    for (const [key, entry] of Object.entries(ROUTE_PERMISSION_REQUIREMENTS)) {
      expect(['public', 'identity', 'permission'], key).toContain(entry.access);
    }
  });

  it('covers the whole HTTP surface', () => {
    // The table is the authorization policy for the API; a route missing from it
    // is a hole, so the count is asserted rather than left to inspection.
    expect(Object.keys(ROUTE_PERMISSION_REQUIREMENTS).length).toBeGreaterThanOrEqual(158);
    expect(permissionEntries().length).toBeGreaterThanOrEqual(150);
  });

  it('keys every entry as template|METHOD', () => {
    for (const key of Object.keys(ROUTE_PERMISSION_REQUIREMENTS)) {
      const [template, method] = key.split('|');
      expect(template.startsWith('/api/'), key).toBe(true);
      expect(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], key).toContain(method);
    }
  });

  it('uses resource:action permission keys with no empty half', () => {
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      const [resource, action, ...rest] = entry.permissionKey.split(':');
      expect(rest, key).toEqual([]);
      expect(resource.length, key).toBeGreaterThan(0);
      expect(action.length, key).toBeGreaterThan(0);
    }
  });

  it('never leaves a noun-shaped action unnormalised', () => {
    // `/[id]/decisions` is the act of deciding; naming the action `decisions`
    // would read as a collection and invite a second, divergent key later.
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      const action = entry.permissionKey.split(':')[1];
      expect(['decisions', 'positions', 'proposals', 'versions', 'variances'], key).not.toContain(
        action,
      );
    }
  });

  it('does not repeat the resource inside its own action', () => {
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      const [resource, action] = entry.permissionKey.split(':');
      expect(action.startsWith(`${resource}-`), key).toBe(false);
    }
  });
});

describe('route permission policy — public and identity classes', () => {
  it('treats only credential acquisition and health probes as public', () => {
    const publicRoutes = Object.entries(ROUTE_PERMISSION_REQUIREMENTS)
      .filter(([, entry]) => entry.access === 'public')
      .map(([key]) => key);

    expect(publicRoutes.sort()).toEqual([
      // Health probes. An orchestrator has no session and cannot obtain one, and a
      // readiness endpoint requiring authorization would report unready for the wrong
      // reason during exactly the outage it exists to detect. Neither reads or writes
      // tenant state, and neither publishes a connection string, credential or internal
      // hostname.
      '/api/health/live|GET',
      '/api/health/ready|GET',
      // Assertion issuance is public for the same reason as sign-in: it authenticates the
      // session cookie, and requiring an assertion to mint one is circular.
      '/api/v1/auth/assertion|POST',
      '/api/v1/auth/login|POST',
      '/api/v1/auth/register|POST',
      // Email verification, for the same reason as the three above: the token in the body *is*
      // the credential, and the caller is proving possession of an address precisely because it
      // has no session yet. Requiring one would make the route unreachable by the only person who
      // should ever call it — and until it existed, no identity could ever reach ACTIVE and so
      // nobody could sign in at all. `packages/identity/src/verification.ts` argues it.
      '/api/v1/auth/verify-email|POST',
    ]);
  });

  it('exposes no tenant state through a public route', () => {
    // The standard by which a new public route is judged: it may report that the process
    // is running or that the store is reachable, and nothing about who is in it.
    const publicRoutes = Object.entries(ROUTE_PERMISSION_REQUIREMENTS)
      .filter(([, entry]) => entry.access === 'public')
      .map(([key]) => key.split('|')[0]);

    for (const route of publicRoutes)
      expect(
        route.startsWith('/api/health/') || route.startsWith('/api/v1/auth/'),
        `${route} is public but is neither a health probe nor credential acquisition`,
      ).toBe(true);
  });

  it('requires no permission for routes that read the caller’s own identity', () => {
    // Requiring a permission here would be circular: permission evaluation needs
    // membership, and these are how a caller discovers it.
    for (const [path, method] of [
      ['/api/v1/auth/logout', 'POST'],
      ['/api/v1/auth/session', 'GET'],
      ['/api/v1/me/workspaces', 'GET'],
    ] as const) {
      expect(requirementForRoute(path, method).access).toBe('identity');
    }
  });

  it('gates permission evaluation itself, which is policy rather than identity', () => {
    expect(requirementForRoute('/api/v1/permissions/evaluate', 'POST')).toMatchObject({
      access: 'permission',
      permissionKey: 'permissions:evaluate',
    });
  });
});

describe('route permission policy — resolution', () => {
  it('resolves a collection route', () => {
    expect(requirementForRoute('/api/v1/contracts', 'POST')).toMatchObject({
      permissionKey: 'contracts:create',
    });
  });

  it('distinguishes methods on the same path', () => {
    expect(requirementForRoute('/api/v1/contracts', 'GET')).toMatchObject({
      permissionKey: 'contracts:read',
    });
    expect(requirementForRoute('/api/v1/contracts', 'POST')).toMatchObject({
      permissionKey: 'contracts:create',
    });
  });

  it('binds a dynamic segment to exactly one path segment', () => {
    // Was `/api/v1/contracts/[id]/approve` until Batch J retired that route — it approved a contract with no
    // policy and no decision record, and the durable path is `/api/v1/approval-requests`. Any single-segment
    // template proves the same rule; this one is a real entry, so the fixture cannot outlive the route again.
    expect(requirementForRoute('/api/v1/completion-certificates/abc-123/verify', 'GET')).toMatchObject({
      permissionKey: 'completion-certificates:verify',
    });
    // Two segments where the template has one must not match.
    expect(() =>
      requirementForRoute('/api/v1/completion-certificates/abc/123/verify', 'GET'),
    ).toThrow('ROUTE_NOT_MAPPED');
  });

  it('accepts a lowercase method and a query string', () => {
    expect(requirementForRoute('/api/v1/contracts?page=2', 'post')).toMatchObject({
      permissionKey: 'contracts:create',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(requirementForRoute('/api/v1/contracts/', 'POST')).toMatchObject({
      permissionKey: 'contracts:create',
    });
  });

  it('rejects an empty dynamic segment rather than matching it', () => {
    expect(() => requirementForRoute('/api/v1/contracts//approve', 'POST')).toThrow(
      RouteAccessError,
    );
  });
});

describe('route permission policy — fails closed', () => {
  it('throws for a route that is not in the table', () => {
    // Deny by default: adding a route without a policy entry must be a visible
    // failure, never a silent allow.
    expect(() => requirementForRoute('/api/v1/not-a-route', 'POST')).toThrow(
      'ROUTE_NOT_MAPPED',
    );
  });

  it('distinguishes an unmapped method from an unmapped path', () => {
    expect(() => requirementForRoute('/api/v1/contracts', 'DELETE')).toThrow(
      'ROUTE_METHOD_NOT_MAPPED',
    );
    expect(() => requirementForRoute('/api/v1/nope', 'DELETE')).toThrow('ROUTE_NOT_MAPPED');
  });

  it('reports the method and path without inventing a permission', () => {
    try {
      requirementForRoute('/api/v1/unknown', 'POST');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RouteAccessError);
      expect((error as RouteAccessError).detail).toBe('POST /api/v1/unknown');
    }
  });

  it('never returns a permission entry with a blank key', () => {
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      expect(entry.permissionKey.trim().length, key).toBeGreaterThan(0);
    }
  });
});

describe('route permission policy — segregation of duties', () => {
  it('separates approving a release from executing the payment', () => {
    const approve = requirementForRoute('/api/v1/release-requests/r-1/evaluate', 'POST');
    const execute = requirementForRoute('/api/v1/payment-instructions/p-1/submit', 'POST');

    expect(approve).toMatchObject({ permissionKey: 'release-requests:evaluate' });
    expect(execute).toMatchObject({ permissionKey: 'payment-instructions:submit' });

    // The conflict is declared in both directions, so whichever the caller holds
    // first, the other is refused.
    expect(approve.access === 'permission' && approve.segregatedFrom).toContain(
      'payment-instructions:submit',
    );
    expect(execute.access === 'permission' && execute.segregatedFrom).toContain(
      'release-requests:evaluate',
    );
  });

  it('separates drafting an artefact from deciding it', () => {
    for (const [path, conflicting] of [
      ['/api/v1/invoices/i-1/approve', 'invoices:create'],
      ['/api/v1/certification-requests/c-1/decisions', 'certification-requests:create'],
    ] as const) {
      const entry = requirementForRoute(path, 'POST');
      expect(entry.access === 'permission' && entry.segregatedFrom, path).toContain(
        conflicting,
      );
    }
  });

  it('declares conflicts only against keys the surface actually uses', () => {
    const known = new Set(routePermissionKeys());
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      for (const conflicting of entry.segregatedFrom ?? []) {
        expect(known, `${key} conflicts with unknown ${conflicting}`).toContain(conflicting);
      }
    }
  });

  it('never declares a permission in conflict with itself', () => {
    for (const [key, entry] of permissionEntries()) {
      if (entry.access !== 'permission') continue;
      expect(entry.segregatedFrom ?? [], key).not.toContain(entry.permissionKey);
    }
  });

  it('covers every money-movement route with an explicit permission', () => {
    // CLAUDE.md constraint 2: no unconditional release path. Every one of these
    // must be gated, never identity-only and never public.
    const moneyRoutes = Object.keys(ROUTE_PERMISSION_REQUIREMENTS).filter((key) =>
      /release-requests|payment-instructions|fund-reservations|funding-commitments|financial-entitlements|invoices|ledger-entries|final-settlement|reconciliation-records|payment-eligibilit/.test(
        key,
      ),
    );

    expect(moneyRoutes.length).toBeGreaterThan(15);
    for (const key of moneyRoutes) {
      expect(ROUTE_PERMISSION_REQUIREMENTS[key].access, key).toBe('permission');
    }
  });
});

describe('route permission policy — key inventory', () => {
  it('reports a sorted, deduplicated set of required permissions', () => {
    const keys = routePermissionKeys();
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(100);
  });

  it('includes the money-movement keys a grant catalogue must define', () => {
    const keys = routePermissionKeys();
    for (const required of [
      'release-requests:evaluate',
      'payment-instructions:submit',
      'invoices:approve',
    ]) {
      expect(keys).toContain(required);
    }
  });
});

describe('route permission policy — agrees with the grant catalogue', () => {
  it('requires no permission that no role can grant', () => {
    // A route demanding a key outside the catalogue is unreachable: deny-by-default
    // plus no grantable key means nobody can ever satisfy it.
    const grantable = new Set(catalogueKeys());
    const ungrantable = routePermissionKeys().filter((key) => !grantable.has(key));
    expect(ungrantable).toEqual([]);
  });

  it('declares the same duty pairs the catalogue enforces', () => {
    // The table's `segregatedFrom` is what a request carries; the catalogue is what
    // is written into a workspace. Drift between them would leave a conflict either
    // declared and unenforced, or enforced and undeclared.
    const declared = new Set<string>();
    for (const entry of Object.values(ROUTE_PERMISSION_REQUIREMENTS)) {
      if (entry.access !== 'permission') continue;
      for (const conflicting of entry.segregatedFrom ?? []) {
        declared.add([entry.permissionKey, conflicting].sort().join('|'));
      }
    }

    const catalogued = new Set(
      SEGREGATION_CATALOGUE.map((rule) =>
        [rule.firstPermission, rule.conflictingPermission].sort().join('|'),
      ),
    );

    expect([...declared].sort()).toEqual([...catalogued].sort());
  });
});
