import { errorResponse, intelligence, authorizedContextForRoute } from '../../../../../../lib/trust-app';

/**
 * The governed publication boundary for agreement intelligence.
 *
 * The engine already requires human review before publication, but `review()` had no
 * reachable HTTP path. The authorization catalogue likewise has no separate
 * `agreement-intelligence:review` authority. Rather than inventing a new permission
 * inside the trust foundation, this route keeps review as a pre-publication action
 * under the existing `agreement-intelligence:publish` authority.
 *
 * `operation: REVIEW` records the human decision. A request without that operation
 * performs the existing publish transition, which still refuses while any item is
 * PENDING and still requires at least one ACCEPTED item.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = (await request.json().catch(() => ({}))) as {
      operation?: 'REVIEW' | 'PUBLISH';
      itemId?: string;
      decision?: 'ACCEPTED' | 'REJECTED';
    };

    if (body.operation === 'REVIEW') {
      if (!body.itemId || !['ACCEPTED', 'REJECTED'].includes(body.decision ?? ''))
        throw new Error('REVIEW_DECISION_REQUIRED');

      return Response.json(
        await intelligence.structured.review(
          context,
          params.id,
          body.itemId,
          body.decision as 'ACCEPTED' | 'REJECTED',
        ),
      );
    }

    return Response.json(await intelligence.structured.publish(context, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
