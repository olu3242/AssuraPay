import { flowOrchestration } from '../../../../lib/flow-app';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

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
