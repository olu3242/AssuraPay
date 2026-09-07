import { flowOrchestration } from '../../../../../../lib/flow-app';
import { FLOW_ROUTE_POLICY } from '../../../../../../lib/flow-route-policy';
import { authorizedContext, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContext(request, FLOW_ROUTE_POLICY.signal);
    const body = await request.json();
    return Response.json(await flowOrchestration.signal(context, {
      flowId: params.id,
      eventType: body.eventType,
      idempotencyKey: body.idempotencyKey,
      payload: body.payload,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
