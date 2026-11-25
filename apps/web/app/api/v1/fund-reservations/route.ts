import { readCollection } from '../../../../lib/financial-reads';
import {errorResponse,authorizedContextForRoute,settlement} from '../../../../lib/trust-app';export async function POST(r:Request){try{return Response.json(await settlement.funding.reserve(await authorizedContextForRoute(r),await r.json()),{status:201})}catch(e){return errorResponse(e)}}

/**
 * Funds held against a confirmed commitment for a specific invoice.
 *
 * Workspace-scoped and paged (`?limit=`, `?cursor=`). `lib/financial-reads.ts` explains why
 * pagination bounds the response rather than the query, and why no figure here is derived from
 * anything but rows.
 */
export async function GET(request: Request) {
  try {
    return Response.json(
      await readCollection(await authorizedContextForRoute(request), 'fundReservations', request.url),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
