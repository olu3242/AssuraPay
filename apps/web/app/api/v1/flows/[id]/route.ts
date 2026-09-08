import { getFlowSnapshot } from '../../../../../lib/flow-operations';
import { authorizedContextForRoute, errorResponse } from '../../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await getFlowSnapshot(context, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
