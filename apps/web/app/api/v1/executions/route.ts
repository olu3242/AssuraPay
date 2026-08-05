import {
  governance,
  authorizedContextForRoute,
  errorResponse,
} from '../../../../lib/trust-app';
export async function POST(request: Request) {
  try {
    const context = authorizedContextForRoute(request);
    return Response.json(
      governance.executions.create(context, await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
