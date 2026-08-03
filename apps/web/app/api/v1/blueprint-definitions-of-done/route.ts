import {
  errorResponse,
  planning,
  requestContext,
} from '../../../../lib/trust-app';
export async function POST(r: Request) {
  try {
    const b = await r.json();
    return Response.json(
      planning.dod.create(
        requestContext(r),
        b.blueprintId,
        b.deliverableId,
        b.criteria,
      ),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
