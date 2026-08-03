import { NextResponse } from 'next/server';
import { getAssuraService } from '../../../../../lib/assurapay-app';

export async function GET() {
  const { store } = await getAssuraService();
  const snapshot = store.getSnapshot();
  return NextResponse.json(snapshot.workspaces ?? []);
}
