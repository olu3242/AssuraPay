import { flowOrchestration } from '../../../../../../lib/flow-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new Error('FLOW_TASK_DECISION_INVALID');
    return Response.json(await flowOrchestration.decide(context, params.id, body.decision));
  } catch (error) {
    return errorResponse(error);
  }
}
