import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../lib/assurapay-app';

export async function POST(request: Request) {
  const body = await request.json();
  const { service } = await getAssuraService();
  const organization = await service.createOrganization({
    name: body.name,
    tenantId: body.tenantId ?? 'tenant-demo',
  });
  return NextResponse.json(organization);
}
