import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse, workspaceScoped } from '../../../../lib/trust-app';

export async function POST(request: Request) {
  try {
    // Workspace and tenant come from the authorized context. Reading them from the
    // body let any caller create a contract inside any workspace of any tenant.
    const context = workspaceScoped(await authorizedContextForRoute(request));
    const body = await request.json();
    const { service } = await getAssuraService();
    const contract = await service.createContract({
      workspaceId: context.activeWorkspaceId,
      tenantId: context.tenantId,
      title: body.title,
      description: body.description,
    });
    return NextResponse.json(contract);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const context = workspaceScoped(await authorizedContextForRoute(request));
    const { store } = await getAssuraService();
    const snapshot = store.getSnapshot();
    return NextResponse.json(
      (snapshot?.contracts ?? []).filter(
        (contract: { workspaceId?: string }) =>
          contract.workspaceId === context.activeWorkspaceId,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
