import { listOpenFlowTasks } from '../../../../lib/flow-operations';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await listOpenFlowTasks(context));
  } catch (error) {
    return errorResponse(error);
  }
}
