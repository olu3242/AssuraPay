import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json();
  const { service } = await getAssuraService();
  const contract = await service.approveContract(params.id, body.actorId ?? 'owner-demo');
  return NextResponse.json(contract);
}
