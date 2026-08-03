import {
  agreements,
  errorResponse,
  requestContext,
} from '../../../../../../lib/trust-app';
export async function POST(r: Request, { params }: { params: { id: string } }) {
  try {
    const b = await r.json();
    return Response.json(
      agreements.approvals.decide(
        requestContext(r),
        params.id,
        b.decision,
        b.conditions,
        b.roles,
      ),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
