import {
  agreements,
  errorResponse,
  authorizedContextForRoute,
} from '../../../../lib/trust-app';
export async function POST(r: Request) {
  try {
    return Response.json(
      await agreements.approvals.route(await authorizedContextForRoute(r), await r.json()),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
