import { flowOrchestration } from '../../../../../../lib/flow-app';
import { FLOW_ROUTE_POLICY } from '../../../../../../lib/flow-route-policy';
import { authorizedContext, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContext(request, FLOW_ROUTE_POLICY.decide);
    const body = await request.json();
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new Error('FLOW_TASK_DECISION_INVALID');
    return Response.json(await flowOrchestration.decide(context, params.id, body.decision));
  } catch (error) {
    return errorResponse(error);
  }
}
