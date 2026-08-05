import {
  governance,
  authorizedContextForRoute,
  errorResponse,
} from '../../../../lib/trust-app';
export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    return Response.json(
      await governance.dod.createVersion(context, body.milestoneId, body.criteria),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
