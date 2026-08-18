import {
  authorizedContextForRoute,
  errorResponse,
  trustStore,
} from '../../../../../../lib/trust-app';
import { PostgresStoreError } from '@assurapay/database';

/**
 * Why a payment eligibility is not yet eligible.
 *
 * Re-pointed from the `FileAssuraStore` snapshot to the durable `paymentEligibilities` record, which
 * `PaymentEligibilityEngine.assess` writes with a real `blockers` array and an `eligible` flag.
 *
 * The behaviour change is the point of the route. The file-backed version read a status and, if it was not
 * `ELIGIBLE`, returned one invented sentence — `'Certificate or acceptance decision is not yet valid'` —
 * for every possible reason. A caller asking why a release is held was told the same thing whether the
 * certificate was revoked, the trigger rule was inactive, or the funding had not confirmed. The engine
 * already computes the actual reasons; nothing was reading them.
 *
 * `blockers` is returned verbatim rather than summarised. Under CLAUDE.md's second hard constraint a release
 * requires every condition to hold, so a caller needs the full set to know what remains — a truncated list
 * would imply that clearing what it names is sufficient.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await authorizedContextForRoute(request);
    const eligibilities = await trustStore.list<{
      id: string;
      eligible: boolean;
      blockers: string[];
    }>('paymentEligibilities');
    const eligibility = eligibilities.find((entry) => entry.id === params.id);
    if (!eligibility)
      // Refused rather than answered with an empty blocker list. "No blockers" and "no such assessment" are
      // opposite answers to "may this be released", and returning the first for the second would report a
      // release as unblocked because nothing had ever assessed it.
      throw new PostgresStoreError(
        'PERSISTENCE_RECORD_NOT_FOUND',
        `no payment eligibility ${params.id} in this scope`,
      );

    return Response.json({
      eligibilityId: eligibility.id,
      eligible: eligibility.eligible,
      blockers: eligibility.blockers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
