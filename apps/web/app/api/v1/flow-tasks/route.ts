import { FlowOperations } from '../../../../lib/flow-operations';
import { trustStore } from '../../../../lib/persistence';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

const operations = new FlowOperations(trustStore);

export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await operations.openTasks(context));
  } catch (error) {
    return errorResponse(error);
  }
}
