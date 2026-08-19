import { errorResponse, intelligence, authorizedContextForRoute } from '../../../../../../lib/trust-app';

/**
 * Human review for one extracted agreement-intelligence item.
 *
 * Publication already refuses while any item is PENDING and requires at least one
 * ACCEPTED item, but the engine's review transition previously had no HTTP route.
 * That made a published intelligence version unreachable from a browser even though
 * the backend method existed. This route exposes exactly that canonical transition.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await request.json()) as {
      itemId?: string;
      decision?: 'ACCEPTED' | 'REJECTED';
    };
    if (!body.itemId || !['ACCEPTED', 'REJECTED'].includes(body.decision ?? ''))
      throw new Error('REVIEW_DECISION_REQUIRED');

    return Response.json(
      await intelligence.structured.review(
        await authorizedContextForRoute(request),
        params.id,
        body.itemId,
        body.decision as 'ACCEPTED' | 'REJECTED',
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
