import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';
import { requestBoundCertification } from '../../../../lib/certification-request-guard';

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(
      await requestBoundCertification(context, await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
