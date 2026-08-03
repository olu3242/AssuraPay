import {
  governance,
  requestContext,
  errorResponse,
} from '../../../../../../lib/trust-app';
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const context = requestContext(request);
    return Response.json(
      governance.paymentTriggers.evaluate(context, params.id),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
