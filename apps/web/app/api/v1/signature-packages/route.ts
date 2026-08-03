import {
  agreements,
  errorResponse,
  requestContext,
} from '../../../../lib/trust-app';
export async function POST(r: Request) {
  try {
    return Response.json(
      agreements.execution.create(requestContext(r), await r.json()),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
