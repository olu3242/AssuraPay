import { trust, authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

/**
 * Activates a workspace as the caller's working context, and records it on the session.
 *
 * Two steps, and both are needed. `OrganizationService.activateContext` decides whether the caller
 * may work in this workspace — it refuses a workspace the caller is not an ACTIVE member of — and
 * returns the resulting context. `IdentityService.selectWorkspace` then writes that choice onto the
 * session row.
 *
 * The second step did not exist. This route returned a computed context and persisted nothing, so the
 * choice lasted exactly as long as the response: `GET /v1/auth/session` still reported no active
 * workspace, and every later assertion had to be told the workspace again because the session it was
 * minted from did not know it. Authorization is decided first and persistence follows, so a refused
 * activation writes nothing.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const current = await authorizedContextForRoute(request);
    const context = await trust.organizations.activateContext(
      current.actorUserId,
      params.id,
      current.sessionId,
      current.identityAssuranceLevel,
    );
    await trust.identity.selectWorkspace({
      sessionId: current.sessionId,
      userId: current.actorUserId,
      workspaceId: params.id,
    });
    return Response.json(context);
  } catch (error) {
    return errorResponse(error);
  }
}
