import { agreementIntakes } from '../../../../lib/agreement-intake-app';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await agreementIntakes.get(await authorizedContextForRoute(request), params.id)); }
  catch (error) { return errorResponse(error); }
}
