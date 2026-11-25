import { authorizedContextForRoute, errorResponse } from '../../../../../lib/trust-app';
import { recordResponse } from '../../../../../lib/record-route';

/**
 * One performance blueprint in the caller's active workspace, with the records it is attached to.
 *
 * `lib/record-reads.ts` explains the link graph and why a record in another workspace is answered as
 * absent rather than as forbidden.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    return await recordResponse(await authorizedContextForRoute(request), 'performance-blueprints', params.id);
  } catch (error) {
    return errorResponse(error);
  }
}
