import { readCollection } from '../../../../lib/financial-reads';
import {errorResponse,authorizedContextForRoute,treasury} from '../../../../lib/trust-app';export async function POST(r:Request){try{return Response.json(await treasury.ledger.post(await authorizedContextForRoute(r),await r.json()),{status:201})}catch(e){return errorResponse(e)}}

/**
 * The append-only double-entry journal. Debits and credits balance per instruction and currency.
 *
 * Workspace-scoped and paged (`?limit=`, `?cursor=`). `lib/financial-reads.ts` explains why
 * pagination bounds the response rather than the query, and why no figure here is derived from
 * anything but rows.
 */
export async function GET(request: Request) {
  try {
    return Response.json(
      await readCollection(await authorizedContextForRoute(request), 'ledgerEntries', request.url),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
