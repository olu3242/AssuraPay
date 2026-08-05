import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse, workspaceScoped } from '../../../../lib/trust-app';

export async function POST(request: Request) {
  try {
    // The tenant comes from the authorized context, never from the body. Reading
    // `body.tenantId` let any caller create a workspace inside any tenant.
    const context = workspaceScoped(authorizedContextForRoute(request));
    const body = await request.json();
    const { service } = await getAssuraService();
    const workspace = await service.createWorkspace({
      name: body.name,
      tenantId: context.tenantId,
      type: body.type,
    });
    return NextResponse.json(workspace);
  } catch (error) {
    return errorResponse(error);
  }
}
