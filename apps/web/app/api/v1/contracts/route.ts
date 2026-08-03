import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';

export async function POST(request: Request) {
  const body = await request.json();
  const { service } = await getAssuraService();
  const contract = await service.createContract({
    workspaceId: body.workspaceId,
    tenantId: body.tenantId ?? 'tenant-demo',
    title: body.title,
    description: body.description,
  });
  return NextResponse.json(contract);
}

export async function GET() {
  const { store } = await getAssuraService();
  const snapshot = store.getSnapshot();
  return NextResponse.json(snapshot?.contracts ?? []);
}
