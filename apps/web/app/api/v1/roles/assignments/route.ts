import { authorizedContextForRoute, errorResponse } from '../../../../../lib/trust-app';
import { assignWorkspaceRole } from '../../../../../lib/grant-administration';

export async function POST(request: Request) {
  try {
    const context = authorizedContextForRoute(request);
    const body = await request.json();
    const granted = assignWorkspaceRole(context, {
      userId: body.userId,
      role: body.role,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      scopeId: body.scopeId,
    });
    // The count is what changed; a repeated assignment grants nothing new.
    return Response.json({ role: body.role, granted: granted.length }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
