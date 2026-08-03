import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { store } = await getAssuraService();
  const snapshot = store.getSnapshot();
  const eligibility = snapshot?.paymentEligibility?.find((entry: any) => entry.id === params.id);
  return NextResponse.json({
    eligibilityId: params.id,
    blockers: eligibility?.status === 'ELIGIBLE' ? [] : ['Certificate or acceptance decision is not yet valid'],
  });
}
