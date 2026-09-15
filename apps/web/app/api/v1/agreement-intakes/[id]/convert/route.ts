import { agreementIntakeConvergence } from '../../../../../lib/agreement-intake-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await agreementIntakeConvergence.convert(await authorizedContextForRoute(request), params.id)); }
  catch (error) { return errorResponse(error); }
}
