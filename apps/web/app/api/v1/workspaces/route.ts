import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';

export async function POST(request: Request) {
  const body = await request.json();
  const { service } = await getAssuraService();
  const workspace = await service.createWorkspace({
    name: body.name,
    tenantId: body.tenantId ?? 'tenant-demo',
    type: body.type,
  });
  return NextResponse.json(workspace);
}
