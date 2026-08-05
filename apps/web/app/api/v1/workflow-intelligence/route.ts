import {
  errorResponse,
  authorizedContextForRoute,
  workflowIntelligence,
} from '../../../../lib/trust-app';

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = await request.json();
    switch (body.operation) {
      case 'workflow-status':
        return Response.json(
          await workflowIntelligence.workflow.assess(context, body.input),
          { status: 201 },
        );
      case 'dependency-analysis':
        return Response.json(
          workflowIntelligence.dependencies.analyze(
            body.input.nodes,
            body.input.edges,
          ),
        );
      case 'bottleneck-report':
        return Response.json(
          workflowIntelligence.bottlenecks.detect(body.input),
        );
      case 'sla-metrics':
        return Response.json(
          workflowIntelligence.sla.assess(
            body.input.items,
            body.input.observedAt,
          ),
        );
      case 'risk-prediction':
        return Response.json(
          await workflowIntelligence.risks.predict(body.input),
          { status: 201 },
        );
      case 'resource-recommendations':
        return Response.json(
          workflowIntelligence.resources.analyze(body.input),
        );
      case 'execution-health':
        return Response.json(
          await workflowIntelligence.health.compute(context, body.input),
          { status: 201 },
        );
      default:
        throw new Error('UNKNOWN_WORKFLOW_INTELLIGENCE_OPERATION');
    }
  } catch (error) {
    return errorResponse(error);
  }
}
