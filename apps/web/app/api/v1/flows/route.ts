import { flowOrchestration } from '../../../../lib/flow-app';
import { getFlowHealth, listFlows } from '../../../../lib/flow-operations';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

export async function GET(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const view = new URL(request.url).searchParams.get('view');
    return Response.json(view === 'health' ? await getFlowHealth(context) : await listFlows(context));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    return Response.json(await flowOrchestration.start(context, {
      flowDefinitionId: body.flowDefinitionId ?? 'COMMERCIAL_COMMITMENT_FLOW',
      flowVersion: body.flowVersion ?? 1,
      organizationId: body.organizationId,
      transactionId: body.transactionId,
      agreementId: body.agreementId,
      assuranceLevel: body.assuranceLevel,
      idempotencyKey: body.idempotencyKey,
    }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
