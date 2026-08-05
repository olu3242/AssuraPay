import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../lib/trust-app';

export async function GET(request: Request) {
  try {
    // Identity-class: authenticated, no permission required, because this is how a
    // caller discovers the memberships permission evaluation depends on.
    //
    // The previous implementation returned every workspace in the store to an
    // unauthenticated caller. Scoping to resolved memberships is the point of the
    // route — "my workspaces", not "all workspaces".
    const context = authorizedContextForRoute(request);
    const { store } = await getAssuraService();
    const snapshot = store.getSnapshot();
    const mine = new Set(context.memberships);
    return NextResponse.json(
      (snapshot.workspaces ?? []).filter((workspace: { id: string }) => mine.has(workspace.id)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
