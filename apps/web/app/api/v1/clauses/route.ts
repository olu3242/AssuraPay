import {
  agreements,
  errorResponse,
  authorizedContextForRoute,
} from '../../../../lib/trust-app';
export async function POST(r: Request) {
  try {
    return Response.json(
      agreements.clauses.createVersion(authorizedContextForRoute(r), await r.json()),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
