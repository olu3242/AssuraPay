import {
  agreements,
  errorResponse,
  authorizedContextForRoute,
} from '../../../../../../lib/trust-app';
export async function POST(r: Request, { params }: { params: { id: string } }) {
  try {
    return Response.json(
      agreements.authoring.submit(authorizedContextForRoute(r), params.id),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
