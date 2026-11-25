import { authorizedContextForRoute, errorResponse } from '../../../../../../lib/trust-app';
import { auditTrailResponse } from '../../../../../../lib/record-route';
import { recordType } from '../../../../../../lib/record-reads';

/**
 * The append-only history of one record.
 *
 * ## Why this one route is generic where the record routes are not
 *
 * `lib/record-route.ts` explains that a generic record route would collapse seventeen read authorities
 * into one, so each record type has its own path and its own key. The audit trail is the opposite case:
 * the declarative gate here is `audit-records:read`, and `auditTrailResponse` then *additionally*
 * requires the read key for the subject's own type. That second check only ever narrows what the first
 * one allowed, so one path cannot widen anyone's reach — and a caller holding the audit key still
 * cannot read the trail of a payment instruction they could not read directly.
 *
 * An unknown type is refused before the gate rather than treated as a record with no history, because
 * an empty trail and a misspelled type must not look the same to a client.
 */
export async function GET(
  request: Request,
  { params }: { params: { type: string; id: string } },
) {
  try {
    const definition = recordType(params.type);
    if (!definition) {
      return Response.json({ error: 'RECORD_TYPE_UNKNOWN', type: params.type }, { status: 404 });
    }
    return await auditTrailResponse(
      await authorizedContextForRoute(request),
      definition.id,
      params.id,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
