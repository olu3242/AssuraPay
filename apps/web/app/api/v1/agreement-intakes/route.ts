import { agreementIntakes } from '../../../../lib/agreement-intake-app';
import { errorResponse, authorizedContextForRoute } from '../../../../lib/trust-app';

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    const { tenantId: _tenantId, workspaceId: _workspaceId, actorUserId: _actorUserId, ...input } = body;
    return Response.json(await agreementIntakes.ingest(context, input), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

