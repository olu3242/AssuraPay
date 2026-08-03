import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { store } = await getAssuraService();
  const snapshot = store.getSnapshot();
  const certificate = snapshot?.certificates?.find((entry: any) => entry.id === params.id);
  if (!certificate) {
    return NextResponse.json({ status: 'NOT_FOUND' });
  }
  return NextResponse.json({ status: certificate.status === 'REVOKED' ? 'REVOKED' : 'VALID', certificate });
}
