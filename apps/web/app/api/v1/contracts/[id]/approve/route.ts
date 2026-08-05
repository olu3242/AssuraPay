import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    // The approver is the authenticated caller. Reading `body.actorId` — defaulted
    // to 'owner-demo' — meant the approval record named whoever the request asked
    // for, which makes an approval trail that cannot be relied on.
    const context = await authorizedContextForRoute(request);
    const { service } = await getAssuraService();
    const contract = await service.approveContract(params.id, context.actorUserId);
    return NextResponse.json(contract);
  } catch (error) {
    return errorResponse(error);
  }
}
