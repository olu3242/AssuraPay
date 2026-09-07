import { flowOrchestration } from '../../../../../../lib/flow-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    return Response.json(await flowOrchestration.suspend(context, params.id, body.reason));
  } catch (error) {
    return errorResponse(error);
  }
}
