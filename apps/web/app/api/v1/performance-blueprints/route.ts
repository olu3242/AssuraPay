import {
  errorResponse,
  planning,
  requestContext,
} from '../../../../lib/trust-app';
export async function POST(r: Request) {
  try {
    return Response.json(
      planning.blueprints.create(requestContext(r), await r.json()),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
