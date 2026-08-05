import {
  governance,
  authorizedContextForRoute,
  errorResponse,
} from '../../../../lib/trust-app';
export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(
      await governance.milestones.create(context, await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
