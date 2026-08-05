import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';
import { foundWorkspace } from '../../../../../../lib/grant-administration';

/**
 * Grants the founding administrator of a workspace to the authenticated caller.
 *
 * Identity-class: founding creates the first grant, so requiring a permission
 * would restore the deadlock it exists to break. What keeps it safe is that
 * bootstrapWorkspaceGrants refuses unless the caller is already an ACTIVE OWNER
 * and the workspace holds no grant yet.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await foundWorkspace(context, params.id), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
