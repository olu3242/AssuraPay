import { enterMutableTrustScope } from '@assurapay/database';
import { trust, errorResponse } from '../../../../../lib/trust-app';

/**
 * Reports the caller's session and the context it is working in.
 *
 * The session cookie is the credential here, not an assertion: this route is how a client discovers
 * whether it is signed in at all, and requiring an assertion would make it unreachable by the only
 * caller that needs it. `assurapay_session` is `HttpOnly`, so this endpoint is the sole way a browser
 * can answer the question.
 *
 * ## Why it resolves the tenant rather than just echoing the row
 *
 * `UserSession` carries `workspaceId` and no tenant — the tenant is a property of the workspace. A
 * client shown only the raw row therefore could not tell which tenant it was working in, and the
 * bootstrap console displayed "no tenant" for a caller who had just founded one. The tenant is
 * derived here from the session's workspace instead of being added to the session record, because
 * duplicating it onto the row would create a second place for it to be wrong.
 *
 * The read is scoped by the actor, which is also what makes it safe: `trust_workspaces_tenant_scope`
 * reveals a workspace to an actor-only caller only when that actor holds an ACTIVE membership in it.
 * A session naming a workspace the user has since been removed from resolves no tenant rather than
 * leaking one.
 */
export async function GET(request: Request) {
  // Bound before the first `await`, so it is visible to the reads below. See `enterMutableTrustScope`.
  const scope = enterMutableTrustScope();
  try {
    const token = request.headers.get('cookie')?.match(/assurapay_session=([^;]+)/)?.[1];
    if (!token) throw new Error('UNAUTHENTICATED');

    const { sessionTokenHash: _hash, ...session } = await trust.identity.resolveSession(token);
    scope.actorId = session.userId;

    let tenantId: string | undefined;
    if (session.workspaceId) {
      const workspaces = await trust.organizations.listAuthorizedWorkspaces(session.userId);
      tenantId = workspaces.find((entry) => entry.id === session.workspaceId)?.tenantId;
    }

    // `activeWorkspaceId` alongside `workspaceId`: the session record's own field name is
    // `workspaceId`, and `RequestContext` — what every route and every client-side reader deals in —
    // calls the same thing `activeWorkspaceId`. Both are returned rather than picking one, because a
    // client that read the wrong name got an empty value and no error, which is how the bootstrap
    // console came to report "no active workspace" immediately after a successful activation.
    return Response.json({ ...session, activeWorkspaceId: session.workspaceId, tenantId });
  } catch (error) {
    return errorResponse(error);
  }
}
