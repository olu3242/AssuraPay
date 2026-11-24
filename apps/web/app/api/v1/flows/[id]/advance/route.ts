import { errorResponse, authorizedContextForRoute } from '../../../../../../lib/trust-app';
import { flowSignalRelay } from '../../../../../../lib/flow-app';

/**
 * Advances a flow from the domain events already committed for it.
 *
 * Gated on `executions:transition` rather than `executions:read`, because it does transition the
 * flow. That is also why the catch-up is not performed on `GET /api/v1/flows/[id]`: a principal
 * holding only read access would otherwise cause state changes by looking.
 *
 * Idempotent, so a scheduler may call it as often as it likes.
 */
export async function POST(r: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(r);
    return Response.json(await flowSignalRelay.drain(context, { flowId: params.id }));
  } catch (e) {
    return errorResponse(e);
  }
}
