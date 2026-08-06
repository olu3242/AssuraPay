import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await authorizedContextForRoute(request);
    const { store } = await getAssuraService();
    const snapshot = await store.getSnapshot();
    const eligibility = snapshot?.paymentEligibility?.find(
      (entry: { id: string }) => entry.id === params.id,
    );
    return NextResponse.json({
      eligibilityId: params.id,
      blockers:
        eligibility?.status === 'ELIGIBLE'
          ? []
          : ['Certificate or acceptance decision is not yet valid'],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
