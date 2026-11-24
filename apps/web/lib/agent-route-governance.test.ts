import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOGUE, catalogueKeys } from '@assurapay/permissions';
import {
  ATLAS_APPROVE_PERMISSION,
  ATLAS_PERMISSION,
} from '@assurapay/agreement-atlas';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * Every reachable agent route is permission-gated and capability-bound.
 *
 * This is the ratchet §3 of the convergence brief asks for, and it exists because the defect it
 * guards against is a *wiring* defect. The AI audit's central finding was that a complete, tested,
 * governed agent runtime had no caller; the mirror-image failure, now that it has callers, is a route
 * that reaches the runtime without a permission or without a capability behind it. Neither a unit
 * test of the service nor a test of the route could catch that, because the fault would be in neither.
 *
 * So the routes are **discovered** rather than listed: the test walks the route tree and finds every
 * handler that imports an agent accessor. A new agent route is therefore in scope the moment it is
 * written, including one whose author never read this file — which is the only version of this
 * ratchet worth having.
 */

const API_ROOT = path.join(__dirname, '..', 'app', 'api');

/** The composition accessors that hand a route the agent runtime. */
const AGENT_ACCESSORS = ['getAtlas', 'getAgentRuntime', 'getGovernedContractAnalysis'] as const;

/**
 * Accessors that execute a registered agent capability, and the permission namespace each one's
 * capability declares.
 *
 * `getGovernedContractAnalysis` is deliberately absent: it reaches the governed *gateway* but
 * executes no registered capability, so demanding a capability binding of it would be demanding a
 * registration that should not exist. It is still required to be permission-gated, below.
 */
const CAPABILITY_NAMESPACES: Record<string, string> = { getAtlas: 'atlas:' };

type DiscoveredRoute = { routePath: string; accessors: string[]; methods: string[] };

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('route.ts') ? [full] : [];
  });
}

/** `app/api/v1/atlas/proposals/[id]/route.ts` → `/api/v1/atlas/proposals/[id]`. */
function routePathOf(file: string): string {
  const relative = path.relative(path.join(__dirname, '..', 'app'), path.dirname(file));
  return `/${relative.split(path.sep).join('/')}`;
}

const discovered: DiscoveredRoute[] = walk(API_ROOT)
  .map((file) => {
    const source = readFileSync(file, 'utf8');
    return {
      routePath: routePathOf(file),
      accessors: AGENT_ACCESSORS.filter((accessor) => source.includes(`${accessor}(`)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((method) =>
        new RegExp(`export async function ${method}\\b`).test(source),
      ),
    };
  })
  .filter((route) => route.accessors.length > 0);

describe('ratchet: a reachable agent route is permission-gated and capability-bound', () => {
  it('finds the agent routes at all, so this suite cannot pass vacuously', () => {
    // Without this, deleting every agent route — or renaming an accessor — would turn the whole
    // ratchet into an assertion about an empty list, which is the classic way a guard stops guarding.
    expect(discovered.length).toBeGreaterThanOrEqual(5);
    expect(discovered.map((route) => route.routePath)).toContain('/api/v1/atlas/proposals');
    for (const route of discovered) expect(route.methods.length).toBeGreaterThan(0);
  });

  it('gates every agent route on a permission, never leaving one public', () => {
    for (const route of discovered)
      for (const method of route.methods) {
        const policy = ROUTE_PERMISSION_REQUIREMENTS[`${route.routePath}|${method}`];
        expect(policy, `${route.routePath}|${method} has no route policy`).toBeDefined();
        // An agent route is never `public` and never merely `authenticated`: invoking a model on a
        // tenant's agreement is an authorized action, not a signed-in one.
        expect(policy?.access, `${route.routePath}|${method} is not permission-gated`).toBe('permission');
      }
  });

  it('names only keys the closed catalogue can actually grant', () => {
    // A key no role holds cannot be granted, so a route gated on one denies everyone forever — which
    // looks exactly like a working gate until someone tries to use the feature.
    const keys = new Set(catalogueKeys());
    for (const route of discovered)
      for (const method of route.methods) {
        const policy = ROUTE_PERMISSION_REQUIREMENTS[`${route.routePath}|${method}`];
        if (policy?.access !== 'permission') continue;
        expect(keys, `${policy.permissionKey} is not in the permission catalogue`).toContain(
          policy.permissionKey,
        );
      }
  });

  it('binds every capability-executing route to its registered capability’s namespace', () => {
    for (const route of discovered) {
      const namespaces = route.accessors
        .map((accessor) => CAPABILITY_NAMESPACES[accessor])
        .filter((namespace): namespace is string => Boolean(namespace));
      if (namespaces.length === 0) continue;

      for (const method of route.methods) {
        const policy = ROUTE_PERMISSION_REQUIREMENTS[`${route.routePath}|${method}`];
        if (policy?.access !== 'permission') continue;
        expect(
          namespaces.some((namespace) => policy.permissionKey.startsWith(namespace)),
          `${route.routePath}|${method} executes a capability but its key ${policy.permissionKey} belongs to no capability namespace`,
        ).toBe(true);
      }
    }
  });

  it('ties the namespace to the permission the capability actually declares', () => {
    // The namespace check above is only as good as its link to the registered capability. Atlas
    // registers its capability with `permission: ATLAS_PERMISSION`, so if that key ever stops living
    // in the `atlas:` namespace the binding above would silently start checking nothing.
    expect(ATLAS_PERMISSION.startsWith('atlas:')).toBe(true);
    expect(ATLAS_APPROVE_PERMISSION.startsWith('atlas:')).toBe(true);
    expect(new Set(catalogueKeys())).toContain(ATLAS_PERMISSION);
    expect(new Set(catalogueKeys())).toContain(ATLAS_APPROVE_PERMISSION);
  });

  it('keeps proposing and approving in different roles, not merely different keys', () => {
    // Two keys one role holds together are one key wearing a disguise. The service refuses a proposer
    // who approves their own proposal; this is the same separation expressed where grants are made,
    // so it survives someone deleting that runtime check.
    const holdsBoth = PERMISSION_CATALOGUE.filter(
      (role) =>
        role.permissionKeys.includes(ATLAS_PERMISSION) &&
        role.permissionKeys.includes(ATLAS_APPROVE_PERMISSION),
    );
    expect(holdsBoth.map((role) => role.role)).toEqual([]);
  });
});
