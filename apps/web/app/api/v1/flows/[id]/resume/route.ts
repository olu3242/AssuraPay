import { flowOrchestration, flowRecovery } from '../../../../../../lib/flow-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json().catch(() => ({}));
    if (body.action === 'RECOVER') {
      return Response.json(await flowRecovery.retry(context, params.id, body.reason ?? ''));
    }
    return Response.json(await flowOrchestration.resume(context, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
