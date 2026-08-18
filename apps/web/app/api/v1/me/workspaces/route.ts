import { authorizedContextForRoute, errorResponse, trust } from '../../../../../lib/trust-app';

/**
 * The workspaces the caller may enter.
 *
 * Identity-class: authenticated, no permission required, because this is how a caller discovers the
 * memberships that permission evaluation itself depends on.
 *
 * Re-pointed from the `FileAssuraStore` snapshot to `OrganizationService.listAuthorizedWorkspaces`, which
 * reads durable `memberships` and `trustWorkspaces`. The change is not only in the source: the engine
 * filters on an **ACTIVE** membership and an **ACTIVE** workspace, so a suspended membership or an archived
 * workspace no longer appears. The file-backed version intersected the resolved membership ids with the
 * snapshot's workspaces and applied neither status, which listed workspaces the caller could not actually
 * enter — `activateContext` refuses them with `WORKSPACE_ACCESS_DENIED`.
 */
export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await trust.organizations.listAuthorizedWorkspaces(context.actorUserId));
  } catch (error) {
    return errorResponse(error);
  }
}
