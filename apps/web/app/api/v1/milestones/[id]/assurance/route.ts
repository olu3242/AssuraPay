import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { service } = await getAssuraService();
  const assurance = await service.getAssuranceReadModel(params.id);
  return NextResponse.json(assurance);
}
