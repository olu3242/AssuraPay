import {
  governance,
  authorizedContextForRoute,
  errorResponse,
} from '../../../../../../lib/trust-app';
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    return Response.json(
      await governance.executions.transition(
        context,
        params.id,
        body.toState,
        body.reason,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
