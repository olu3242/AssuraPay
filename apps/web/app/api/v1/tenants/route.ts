import { randomUUID } from 'node:crypto';
import { enterTrustScope } from '@assurapay/database';
import { authorizedContextForRoute, errorResponse, trust } from '../../../../lib/trust-app';

/**
 * Founds a tenant, its first workspace, and the caller's owner membership.
 *
 * This route exists because without it a durable deployment could not be started at all. Every protected
 * route resolves its trust scope from the verified identity, and `issueFromSession` takes the tenant from
 * the caller's workspace — so a caller with no workspace has no tenant, forced row-level security matches
 * no row, and every read is denied. The only route that created a workspace composed `FileAssuraStore`,
 * which refuses in production, staging, release-candidate, hosted-pilot and persistent-preview. 161 routes
 * went through the durable store and none of them was reachable, because nothing could create the first
 * workspace they all require. See `docs/persistence/DOMAIN_STORE_RETIREMENT.md`.
 *
 * ## Why it is identity-class, and why that is safe
 *
 * `POST /v1/workspaces/[id]/found` documents the same shape one level in: "founding creates the first
 * grant, so requiring a permission would restore the deadlock it exists to break." A permission is
 * evaluated against a grant, a grant is workspace-scoped, and there is no workspace yet — so requiring
 * `workspaces:create` here would be a requirement that can never be satisfied.
 *
 * What keeps it safe is that **the tenant is minted here and can never be supplied by the caller.** There
 * is no request field this route reads that could name an existing tenant, so entering the new tenant's
 * scope grants access to nothing that existed a moment ago: the scope is empty by construction. The caller
 * becomes the workspace's `OWNER` because `createWorkspace` writes that membership from `ownerUserId`,
 * which is taken from the verified identity rather than the body.
 *
 * It still goes through `authorizedContextForRoute`, classified `identity` in the route policy table, so it
 * gets the readiness gate, the authentication and the resolved memberships every other route gets — and so
 * `route-coverage.test.ts` does not have to carry an exception for it. That call enters a scope from the
 * verified identity, which for a founding caller is empty; the `enterTrustScope` below replaces it with the
 * tenant this route is about to write into. Replacing an empty scope with a freshly minted one widens the
 * caller's reach by exactly nothing.
 *
 * ## Adding a workspace to a tenant you already have
 *
 * That is `POST /v1/workspaces`, which is permission-gated on `workspaces:create` and uses the caller's
 * own tenant. The two are separate routes rather than one with a branch, because they have genuinely
 * different access classes and a route may only have one.
 */
export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = (await request.json()) as {
      name?: string;
      slug?: string;
      workspaceType?: 'PERSONAL' | 'ORGANIZATION';
      defaultCurrency?: string;
      timezone?: string;
      countryCode?: string;
    };

    // Minted, never read from the request. This is the whole safety argument for the route's access class:
    // a caller cannot name a tenant, so it cannot enter one.
    const tenantId = randomUUID();
    // The scope the two inserts below are checked against. `trust_tenants_self` and
    // `trust_workspaces_tenant_scope` both compare against `trust_current_tenant()`, and
    // `trust_memberships_tenant_scope` resolves the workspace through its tenant — so the tenant alone is
    // enough, and the workspace id does not need to be known in advance.
    enterTrustScope({ tenantId, actorId: context.actorUserId });

    const workspace = await trust.organizations.createWorkspace({
      tenantId,
      workspaceType: body.workspaceType ?? 'ORGANIZATION',
      name: body.name ?? '',
      slug: body.slug ?? '',
      // The founder is the authenticated caller. Reading an owner from the body would let a caller found a
      // tenant owned by someone else, which is an account takeover with no authentication step.
      ownerUserId: context.actorUserId,
      // Naira-first, per CLAUDE.md. A deployment serving another currency states it; it is not guessed
      // from the request's locale or left undefined for a money column to reject later.
      defaultCurrency: body.defaultCurrency ?? 'NGN',
      timezone: body.timezone ?? 'Africa/Lagos',
      countryCode: body.countryCode ?? 'NG',
      correlationId: context.correlationId,
    });

    return Response.json({ tenantId, workspace }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
