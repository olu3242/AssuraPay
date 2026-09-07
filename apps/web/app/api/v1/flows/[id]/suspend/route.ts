import { flowOrchestration } from '../../../../../../lib/flow-app';
import { FLOW_ROUTE_POLICY } from '../../../../../../lib/flow-route-policy';
import { authorizedContext, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContext(request, FLOW_ROUTE_POLICY.suspend);
    const body = await request.json();
    return Response.json(await flowOrchestration.suspend(context, params.id, body.reason));
  } catch (error) {
    return errorResponse(error);
  }
}
