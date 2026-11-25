import type { RequestContext } from '@assurapay/shared';
import { trust, workspaceScoped } from './trust-app';
import { recordType, readRecord, relatedTo, type RecordTypeId } from './record-reads';

/**
 * The one handler every record route calls.
 *
 * ## Why one handler and seventeen route files, rather than one generic route
 *
 * A single `GET /api/v1/records/[type]/[id]` would have been less code and a worse design.
 * `ROUTE_PERMISSION_REQUIREMENTS` is keyed by path, so a generic route carries exactly one permission
 * key — which would collapse seventeen different read authorities into one, handing whoever may read a
 * milestone the right to read every payment instruction. Keeping the key per path means the gate stays
 * in the declarative table where `route-permissions.test.ts` can see it, instead of moving into a
 * handler that owns its own policy. The seventeen one-line files are the cost of that, and worth it.
 *
 * ## What a caller gets
 *
 * The record as stored, plus what it is attached to in both directions. Nothing is computed, renamed
 * or flattened on the way out: a field the engines wrote is the field the reader sees, because a record
 * page whose values have been massaged cannot be used to answer what actually happened.
 *
 * ## The context is passed in, not resolved here
 *
 * Each route calls `authorizedContextForRoute` itself and hands the result over.
 * `route-coverage.test.ts` scans the route files for exactly that call, and a shared helper that
 * authorized on their behalf would satisfy the gate while making every one of them *look* unguarded
 * to the scanner — which is how an unguarded route eventually gets added without anything failing.
 */
export async function recordResponse(
  context: RequestContext,
  typeId: RecordTypeId,
  id: string,
): Promise<Response> {
  const definition = recordType(typeId);
  // Unreachable through the route files, which pass a literal. Asserted anyway: a typo'd type would
  // otherwise read as an empty record rather than as the mistake it is.
  if (!definition) return Response.json({ error: 'RECORD_TYPE_UNKNOWN', type: typeId }, { status: 500 });

  const record = await readRecord(context, definition, id);
  // 404 rather than 403 for a row in another workspace — `record-reads.ts` explains why answering
  // "exists, but not for you" would disclose the record to anyone holding a guessable id.
  if (!record) {
    return Response.json({ error: 'RECORD_NOT_FOUND', type: definition.id, id }, { status: 404 });
  }

  const held = new Set(await trust.permissions.effectiveKeys(context));
  return Response.json({
    type: definition.id,
    title: definition.title,
    workspaceId: workspaceScoped(context).activeWorkspaceId,
    record,
    related: await relatedTo(context, definition, record, held),
  });
}

/**
 * The record's append-only history, from the ledger that already holds it.
 *
 * `AuditLedgerEngine.trailFor` existed, was workspace-scoped, and had no HTTP route — so the history
 * CLAUDE.md's third hard constraint requires was being written faithfully and could not be read by
 * anything. This is the route, and it reuses that engine rather than querying `auditRecords` directly:
 * a second reader of an append-only log is a second place for the scoping rule to be got wrong.
 *
 * Two gates, deliberately. The route table requires `audit-records:read`, and this handler additionally
 * requires the read key for the subject's own type. Holding the audit key is permission to read
 * history, not permission to read the history of records otherwise out of reach — the trail of a
 * payment instruction says what was paid, to whom and on whose authority, which is the instruction's
 * content by another route.
 */
export async function auditTrailResponse(
  context: RequestContext,
  typeId: RecordTypeId,
  id: string,
): Promise<Response> {
  const definition = recordType(typeId);
  if (!definition) return Response.json({ error: 'RECORD_TYPE_UNKNOWN', type: typeId }, { status: 500 });

  const held = new Set(await trust.permissions.effectiveKeys(context));
  if (!held.has(definition.permissionKey)) {
    return Response.json(
      { error: 'PERMISSION_DENIED', permissionKey: definition.permissionKey },
      { status: 403 },
    );
  }

  // The subject is resolved before its trail is read, so a caller cannot learn from the audit log
  // that a record exists in another workspace.
  const record = await readRecord(context, definition, id);
  if (!record) {
    return Response.json({ error: 'RECORD_NOT_FOUND', type: definition.id, id }, { status: 404 });
  }

  const trail = await trust.auditLedger.trailFor(context, definition.aggregateType, id);
  return Response.json({
    type: definition.id,
    aggregateType: definition.aggregateType,
    id,
    // Ordered as stored. The ledger is append-only, so storage order *is* chronological order, and
    // re-sorting by a timestamp field would quietly reorder the chain the integrity hashes cover.
    trail,
    basis: AUDIT_TRAIL_BASIS,
  });
}

export const AUDIT_TRAIL_BASIS =
  'Append-only. Every entry was written when the transition it records happened and is covered by ' +
  'the ledger’s integrity hash chain. Entries are never edited, redacted or reordered, so an empty ' +
  'trail means no transition was recorded for this record — not that its history was removed.';
