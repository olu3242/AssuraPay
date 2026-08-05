import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';
import { listRoles } from '../../../../lib/grant-administration';

export async function GET(request: Request) {
  try {
    authorizedContextForRoute(request);
    return Response.json(listRoles());
  } catch (error) {
    return errorResponse(error);
  }
}
