import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await authorizedContextForRoute(request);
    const { service } = await getAssuraService();
    const assurance = await service.getAssuranceReadModel(params.id);
    return NextResponse.json(assurance);
  } catch (error) {
    return errorResponse(error);
  }
}
