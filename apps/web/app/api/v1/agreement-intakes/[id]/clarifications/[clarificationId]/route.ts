import { agreementIntakes } from '../../../../../../../lib/agreement-intake-app';
import { errorResponse, authorizedContextForRoute } from '../../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string; clarificationId: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    const { answer } = await request.json();
    return Response.json(await agreementIntakes.resolveClarification(context, params.id, params.clarificationId, answer));
  } catch (error) { return errorResponse(error); }
}

