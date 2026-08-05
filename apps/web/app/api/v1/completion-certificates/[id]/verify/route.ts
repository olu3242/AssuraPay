import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../../lib/assurapay-app';
import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    // Certificate verification is the evidence a release is built on, so it is
    // permission-gated rather than open: an unauthenticated caller could otherwise
    // enumerate certificate ids and read their status.
    await authorizedContextForRoute(request);
    const { store } = await getAssuraService();
    const snapshot = store.getSnapshot();
    const certificate = snapshot?.certificates?.find(
      (entry: { id: string }) => entry.id === params.id,
    );
    if (!certificate) {
      return NextResponse.json({ status: 'NOT_FOUND' });
    }
    return NextResponse.json({
      status: certificate.status === 'REVOKED' ? 'REVOKED' : 'VALID',
      certificate,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
