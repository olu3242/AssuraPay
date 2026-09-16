import { agreementIntakes } from '../../../../../../lib/agreement-intake-app';
import { errorResponse, authorizedContextForRoute } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await agreementIntakes.confirmReview(await authorizedContextForRoute(request), params.id)); }
  catch (error) { return errorResponse(error); }
}

