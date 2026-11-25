import { getFinancialPosition } from '../../../../lib/financial-reads';
import { authorizedContextForRoute, errorResponse } from '../../../../lib/trust-app';

/**
 * The workspace's financial position, per currency.
 *
 * Deliberately not called a balance. AssuraPay takes no custody, so it has no balance to report:
 * what it can report is its own record of what a certified provider confirmed holding, what has been
 * reserved against that, what has been requested for release and what the provider reported
 * settling. The response carries that statement in a `basis` field rather than leaving it to
 * documentation, because a client rendering these figures as an account balance would be asserting
 * custody that does not exist.
 *
 * Every figure comes from rows. There is no forecast and no "expected" number, and totals are never
 * summed across currencies — adding kobo to cents produces a number that is true of nothing.
 */
export async function GET(request: Request) {
  try {
    return Response.json(await getFinancialPosition(await authorizedContextForRoute(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
