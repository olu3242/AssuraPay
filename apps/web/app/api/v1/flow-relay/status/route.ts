import {
  authorizedContextForRoute,
  errorResponse,
  workspaceScoped,
} from '../../../../../lib/trust-app';
import { getFlowRelayQueue } from '../../../../../lib/flow-app';
import { MAX_ATTEMPTS } from '../../../../../lib/flow-relay-queue';

/**
 * Whether this workspace's flows are being advanced.
 *
 * The relay's whole purpose is that a journey no longer stalls silently. A dead-letter state nothing
 * can read would be a silence with extra steps, so this is the route that reads it — scoped to the
 * caller's own workspace.
 *
 * ## Why it reports one workspace and not the platform
 *
 * "Which workspaces are stuck?" is the question an operator wants and the one this route refuses to
 * answer. The workspaces worth naming are precisely the ones the caller is not in, so a cross-tenant
 * list would tell one tenant's analyst that other tenants exist and are in trouble. The queue table
 * is unscoped by policy because a worker must find work before it knows whose it is; that is not a
 * licence to hand the same view to a tenant. Platform-wide relay state is read by platform
 * operations, outside this API.
 *
 * What the caller gets is the question they are entitled to ask: is my chain advancing, when did it
 * last advance, and if it has stopped, why. No payload, no amount, no party — the queue holds none.
 */
export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const scoped = workspaceScoped(context);
    const queue = await getFlowRelayQueue();

    if (!queue) {
      // Stated rather than answered with a healthy-looking empty result. "This deployment runs no
      // worker" and "nothing is wrong" are different facts, and reporting the first as the second
      // is the false reassurance this route exists to prevent.
      return Response.json(
        {
          worker: 'UNAVAILABLE',
          detail:
            'This deployment has no durable persistence, so the relay runs no worker and keeps no ' +
            'queue. Flows advance only when a caller asks them to.',
        },
        { status: 503 },
      );
    }

    const state = await queue.forWorkspace(scoped.tenantId, scoped.activeWorkspaceId);

    if (!state) {
      // No queue row means no orchestrated event has ever been committed here — which is a real
      // answer, and not the same as "drained and up to date".
      return Response.json({
        worker: 'RUNNING',
        workspace: 'NO_ORCHESTRATED_EVENTS',
        detail: 'Nothing has been committed in this workspace for the relay to advance.',
      });
    }

    return Response.json({
      worker: 'RUNNING',
      workspace: state.deadLettered ? 'STALLED' : state.due ? 'ADVANCING' : 'UP_TO_DATE',
      ...state,
      maxAttempts: MAX_ATTEMPTS,
      basis: state.deadLettered
        ? `This workspace failed to advance ${MAX_ATTEMPTS} times in a row and is no longer ` +
          'retried automatically. Its flows are not advancing and will not resume without a decision.'
        : 'Advanced automatically whenever an engine commits a domain event in this workspace.',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
