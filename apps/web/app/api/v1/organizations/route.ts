import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse, workspaceScoped } from '../../../../lib/trust-app';

export async function POST(request: Request) {
  try {
    const context = workspaceScoped(await authorizedContextForRoute(request));
    const body = await request.json();
    const { service } = await getAssuraService();
    const organization = await service.createOrganization({
      name: body.name,
      tenantId: context.tenantId,
    });
    return NextResponse.json(organization);
  } catch (error) {
    return errorResponse(error);
  }
}
