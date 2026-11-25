import { authorizedContextForRoute, errorResponse, trust } from '../../../../../lib/trust-app';
import { personaWorkspacesFor } from '../../../../../lib/persona-workspaces';

/**
 * The caller's own permission keys, and the persona workspaces they open.
 *
 * Identity-class, like `/api/v1/me/workspaces` beside it, and for the same reason: asking what *I* may do is
 * not an administrative act. `permissions:evaluate` gates evaluation behind a key only an administrator holds,
 * which is right for evaluating someone else and wrong as the only way to learn your own authority — it left
 * the application unable to show a person the surfaces they can actually use.
 *
 * It discloses nothing the caller could not establish by attempting each route in turn, and confers nothing:
 * every route still enforces its own requirement when called. The workspace list here is a convenience for
 * navigation, never a grant.
 */
export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const permissionKeys = await trust.permissions.effectiveKeys(context);
    return Response.json({
      permissionKeys,
      // Derived from the keys, so the menu cannot offer a workspace whose modules would be refused.
      workspaces: personaWorkspacesFor(permissionKeys).map((entry) => entry.id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
