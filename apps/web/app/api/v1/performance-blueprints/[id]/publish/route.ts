import {
  errorResponse,
  planning,
  requestContext,
} from '../../../../../../lib/trust-app';
export async function POST(r: Request, { params }: { params: { id: string } }) {
  try {
    return Response.json(
      planning.blueprints.publish(requestContext(r), params.id),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
