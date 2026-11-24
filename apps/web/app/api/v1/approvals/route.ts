import { getApprovalInbox } from '../../../../lib/flow-operations';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

/**
 * The signed-in caller's approval inbox.
 *
 * Separate from `GET /api/v1/flow-tasks`, which stays as it is: that endpoint reports every open
 * task in the workspace for operational views, while this one answers "what is waiting for *me*",
 * marks what the caller can actually act on, and counts the rest. Widening the existing endpoint
 * instead would have made an operations list quietly caller-dependent.
 *
 * Gated on `executions:read`, matching the task list it projects from. Deciding is a different key
 * on a different route.
 */
export async function GET(request: Request) {
  try {
    return Response.json(await getApprovalInbox(await authorizedContextForRoute(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
