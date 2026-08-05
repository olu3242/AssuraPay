import {
  governance,
  authorizedContextForRoute,
  errorResponse,
} from '../../../../../../lib/trust-app';
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(
      await governance.paymentTriggers.evaluate(context, params.id),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
