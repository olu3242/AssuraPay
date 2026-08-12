import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse, workspaceScoped } from '../../../../lib/trust-app';

export async function GET(request: Request) {
  try {
    workspaceScoped(await authorizedContextForRoute(request));
    const { store } = await getAssuraService();
    return NextResponse.json(await store.getSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}
