import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSION_REQUIREMENTS, requirementForRoute } from './route-permissions';

/**
 * Route authorization coverage.
 *
 * The policy table says what each route requires and `authorizedContextForRoute`
 * applies it, but neither can make a handler ask. This suite reads the handlers
 * themselves, so a route that skips authorization fails certification rather than
 * shipping.
 *
 * It is deliberately a source scan rather than a runtime check. A route that never
 * calls the authorized path has no runtime behaviour to observe — the omission is
 * only visible in the file.
 */

const API_ROOT = join(process.cwd(), 'apps', 'web', 'app', 'api');

/**
 * Routes that legitimately do not call `authorizedContextForRoute`, each with the
 * reason it cannot.
 *
 * This is the whole exemption surface. Adding an entry is a deliberate, reviewable
 * act; forgetting to authorize a route is not, because it fails instead.
 */
export const ROUTE_COVERAGE_PUBLIC_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'v1/auth/login/route.ts':
    'Public. Sign-in is how a caller obtains a credential, so it cannot require one.',
  'v1/auth/register/route.ts':
    'Public. Registration precedes having any identity to authorize.',
  'v1/auth/assertion/route.ts':
    'Public. It authenticates the session cookie in order to mint an assertion, so requiring an assertion would be circular. The session is the authority: no request field can name a subject, session or assurance level.',
  'v1/auth/session/route.ts':
    'Identity-class, but authenticates by session cookie rather than by identity assertion. Requiring an assertion here would lock out precisely the cookie holder the route exists to serve, and no cookie-to-assertion exchange is governed yet.',
});

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...routeFiles(full));
    } else if (entry.name === 'route.ts') {
      found.push(full);
    }
  }
  return found;
}

/** `apps/web/app/api/v1/contracts/[id]/approve/route.ts` → `/api/v1/contracts/[id]/approve`. */
function templateOf(relativePath: string): string {
  return `/api/${relativePath.split(sep).slice(0, -1).join('/')}`;
}

/**
 * Comments are removed before any rule is applied.
 *
 * A handler that explains why it no longer reads `body.tenantId` would otherwise
 * fail the rule forbidding it — the same self-reference trap the REOS validators
 * hit, and the reason they carry a rule-vocabulary token. Here the rules are about
 * code, so reading only code is the simpler fix.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = routeFiles(API_ROOT).map((absolute) => {
  const key = relative(API_ROOT, absolute).split(sep).join('/');
  const raw = readFileSync(absolute, 'utf8');
  return {
    key,
    template: templateOf(relative(API_ROOT, absolute)),
    source: raw,
    code: stripComments(raw),
  };
});

/** Exported HTTP methods, read from the handler's own export statements. */
function methodsOf(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE)\b/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

describe('route authorization coverage — every handler authorizes', () => {
  it('finds the API surface', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(files.length).toBeGreaterThanOrEqual(157);
  });

  it('calls authorizedContextForRoute in every route outside the allowlist', () => {
    const unauthorized = files
      .filter((file) => !(file.key in ROUTE_COVERAGE_PUBLIC_ALLOWLIST))
      .filter((file) => !file.code.includes('authorizedContextForRoute'))
      .map((file) => file.key);

    expect(unauthorized).toEqual([]);
  });

  it('leaves no handler calling the unauthorized requestContext helper', () => {
    // `requestContext` proves identity and stops there. A handler still calling it
    // is authenticated but unauthorized, which is the state this capability removed.
    const stragglers = files
      .filter((file) => /\brequestContext\s*\(/.test(file.code))
      .map((file) => file.key);

    expect(stragglers).toEqual([]);
  });

  it('keeps the allowlist minimal, current and explained', () => {
    for (const [key, reason] of Object.entries(ROUTE_COVERAGE_PUBLIC_ALLOWLIST)) {
      expect(
        files.some((file) => file.key === key),
        `${key} is allowlisted but no longer exists`,
      ).toBe(true);
      expect(reason.length, key).toBeGreaterThan(40);
    }
    expect(Object.keys(ROUTE_COVERAGE_PUBLIC_ALLOWLIST)).toHaveLength(4);
  });

  it('allowlists only routes the policy table classes as public or identity', () => {
    // An allowlisted route the table considers permission-class would be an
    // unauthorized hole wearing an exemption.
    for (const key of Object.keys(ROUTE_COVERAGE_PUBLIC_ALLOWLIST)) {
      const file = files.find((entry) => entry.key === key);
      for (const method of methodsOf(file?.code ?? '')) {
        expect(
          requirementForRoute(file!.template, method).access,
          `${key} ${method}`,
        ).not.toBe('permission');
      }
    }
  });
});

describe('route authorization coverage — the table matches the filesystem', () => {
  it('has a policy entry for every method every handler exports', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const method of methodsOf(file.code)) {
        try {
          requirementForRoute(file.template, method);
        } catch {
          missing.push(`${method} ${file.template}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('has a handler for every entry in the policy table', () => {
    // A stale entry is not a security hole, but it hides the fact that a route was
    // deleted and lets the table drift into fiction.
    const live = new Set(
      files.flatMap((file) => methodsOf(file.code).map((method) => `${file.template}|${method}`)),
    );
    const orphaned = Object.keys(ROUTE_PERMISSION_REQUIREMENTS).filter((key) => !live.has(key));
    expect(orphaned).toEqual([]);
  });
});

/**
 * Routes that may name a workspace in the request body.
 *
 * The rule below forbids a handler taking identity from the request. Selecting
 * which workspace to act in is a different act from claiming authority over it —
 * but only when something downstream proves membership. Each entry states what
 * does the proving, and the list is asserted to stay tiny.
 */
const BODY_WORKSPACE_SELECTION_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'v1/auth/assertion/route.ts':
    'Selects which workspace the minted assertion names. issueAssertionForSession refuses a workspace the session holder has no ACTIVE membership in, so the body chooses among proven memberships rather than asserting one.',
});

describe('route authorization coverage — identity is never taken from the body', () => {
  it('derives actor, workspace and tenant from the context rather than the request', () => {
    // These routes previously read `body.tenantId ?? 'tenant-demo'` and
    // `body.actorId ?? 'owner-demo'`, so the caller named their own tenant and
    // their own approver.
    const spoofable = files
      .filter((file) => !(file.key in BODY_WORKSPACE_SELECTION_ALLOWLIST))
      .filter((file) => /body\.(tenantId|workspaceId|actorId|actorUserId)\b/.test(file.code))
      .map((file) => file.key);

    expect(spoofable).toEqual([]);
  });

  it('never lets an exempt route name the actor or tenant, only the workspace', () => {
    // The exemption is for choosing among proven memberships. Naming a subject or
    // a tenant is not that, and no reason would make it so.
    for (const key of Object.keys(BODY_WORKSPACE_SELECTION_ALLOWLIST)) {
      const file = files.find((entry) => entry.key === key);
      expect(file, key).toBeDefined();
      expect(/body\.(tenantId|actorId|actorUserId)\b/.test(file!.code), key).toBe(false);
    }
    expect(Object.keys(BODY_WORKSPACE_SELECTION_ALLOWLIST).length).toBeLessThanOrEqual(2);
  });

  it('leaves no demo identity defaults anywhere in the API surface', () => {
    const demoDefaults = files
      .filter((file) => /'(tenant-demo|owner-demo|workspace-demo)'/.test(file.code))
      .map((file) => file.key);

    expect(demoDefaults).toEqual([]);
  });
});
