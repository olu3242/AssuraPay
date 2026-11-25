'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatMinor, scopedGet, type ScopedResult } from './scoped-fetch';

/**
 * One record, what it is attached to, and its history.
 *
 * ## Why three tabs and not five
 *
 * The brief asked for Details, Related, Documents, Activity and Audit. Three are built, and the two
 * that are missing are missing for stated reasons rather than quietly dropped.
 *
 * **Activity and Audit are one tab.** Both would read `auditRecords` — the append-only ledger is the
 * only record of what happened to an aggregate. Splitting one source across two tabs would imply the
 * platform holds two accounts of events, a friendly one and an authoritative one, and invite someone
 * to wonder which to trust. There is one, it is append-only, and it is called History.
 *
 * **There is no Documents tab**, because there is nothing to put in it. `evidence-packages` and
 * `signature-packages` expose `POST` and no read route, and `document_versions` has no HTTP surface at
 * all — so evidence can be submitted and verified and never looked at again. A Documents tab today
 * would be an empty panel on every record, which reads as "this milestone has no evidence" when the
 * truth is "the platform cannot show you the evidence it holds". That is a worse statement than the
 * absence of the tab, so the absence is what ships, and the gap is named here and in the report.
 *
 * ## The rules the tabs follow
 *
 * Values are shown as stored. Amounts in minor units are formatted through the runtime's own currency
 * data rather than divided by an assumed hundred. A related type the caller cannot read is named, not
 * counted — `record-reads.ts` explains why a count would leak. A parent the record names and the
 * workspace does not hold is shown as a finding rather than omitted, because a dangling reference in a
 * chain that authorises money is exactly what a reader needs to see.
 */

type RelatedRecord = {
  type: string;
  title: string;
  id: string;
  label: string;
  via: string;
};

type RecordPayload = {
  type: string;
  title: string;
  workspaceId: string;
  record: Record<string, unknown>;
  related: {
    parents: RelatedRecord[];
    children: RelatedRecord[];
    withheld: string[];
    danglingParents: { type: string; field: string; id: string }[];
  };
};

type AuditEntry = {
  id: string;
  eventType: string;
  actorId: string;
  createdAt: string;
  integrityHash: string;
};

type AuditPayload = { trail: AuditEntry[]; basis: string; aggregateType: string };

type Tab = 'details' | 'related' | 'history';

/** Field names that carry structure rather than content a reader wants in a details list. */
const HIDDEN_FIELDS = new Set(['id', 'workspaceId', 'tenantId', 'schemaVersion', 'version']);

function humanise(field: string): string {
  const spaced = field.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderValue(field: string, value: unknown, currency?: string): string {
  if (value === null || value === undefined) return '—';
  // Minor units are integers by design. Formatting is derived from the currency, never assumed.
  if (field.endsWith('Minor') && typeof value === 'number') return formatMinor(value, currency);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function RecordView({ type, id }: { type: string; id: string }) {
  const [record, setRecord] = useState<ScopedResult<RecordPayload> | undefined>();
  const [audit, setAudit] = useState<ScopedResult<AuditPayload> | undefined>();
  const [tab, setTab] = useState<Tab>('details');

  const load = useCallback(async () => {
    setRecord(undefined);
    setAudit(undefined);
    const result = await scopedGet<RecordPayload>(`/api/v1/${type}/${encodeURIComponent(id)}`);
    setRecord(result);
    // The history is fetched separately and is allowed to fail on its own: a caller may read the
    // record and hold no `audit-records:read`, and the record is still worth showing.
    setAudit(await scopedGet<AuditPayload>(`/api/v1/audit-trail/${type}/${encodeURIComponent(id)}`));
  }, [type, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!record)
    return (
      <p className="lead" role="status" data-testid="record-loading">
        Loading the record…
      </p>
    );

  if (record.kind === 'signed-out')
    return (
      <section className="card" data-testid="record-signed-out">
        <h2>Sign in to see this record</h2>
        <p>Records belong to a workspace, so there is nothing to show until you sign in.</p>
        <p>
          <a className="button button--primary" href="/auth/sign-in">
            Sign in
          </a>
        </p>
      </section>
    );

  if (record.kind === 'forbidden')
    return (
      <section className="card" data-testid="record-forbidden">
        <h2>You cannot read this kind of record here</h2>
        {/* Said plainly. "You may not look" and "there is nothing here" are different facts. */}
        <p>
          Reading this record needs a role that holds its read permission in your active workspace. Ask a
          workspace administrator for it.
        </p>
      </section>
    );

  if (record.kind === 'not-found')
    return (
      <section className="card" data-testid="record-not-found">
        <h2>No such record in this workspace</h2>
        <p>
          Nothing with this identifier exists in the workspace you have active. A record held by another
          workspace is reported the same way, deliberately — knowing an identifier is not grounds to learn
          that it exists elsewhere.
        </p>
      </section>
    );

  if (record.kind === 'error')
    return (
      <section className="card" data-testid="record-error">
        <h2>We could not load this record</h2>
        <p>{record.detail}</p>
        <p>
          <button className="button button--secondary" type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );

  const payload = record.value;
  const currency = typeof payload.record.currency === 'string' ? payload.record.currency : undefined;
  const fields = Object.entries(payload.record).filter(([field]) => !HIDDEN_FIELDS.has(field));
  const { parents, children, withheld, danglingParents } = payload.related;

  return (
    <section data-testid="record-view">
      <nav className="tabs" aria-label="Record sections" data-testid="record-tabs">
        {(
          [
            ['details', 'Details'],
            ['related', 'Related'],
            ['history', 'History'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'tab tab--current' : 'tab'}
            aria-current={tab === key ? 'page' : undefined}
            data-testid={`record-tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'details' && (
        <section className="card" data-testid="record-details">
          <h2>{payload.title}</h2>
          <p className="eyebrow" data-testid="record-id">
            {payload.record.id as string}
          </p>
          <dl className="record-fields">
            {fields.map(([field, value]) => (
              <div key={field} data-testid="record-field">
                <dt>{humanise(field)}</dt>
                <dd data-testid={`record-field-${field}`}>{renderValue(field, value, currency)}</dd>
              </div>
            ))}
          </dl>
          {fields.length === 0 && (
            <p data-testid="record-no-fields">This record carries no fields beyond its identity.</p>
          )}
        </section>
      )}

      {tab === 'related' && (
        <section data-testid="record-related">
          <article className="card">
            <h2>What this is attached to</h2>
            {parents.length === 0 ? (
              <p data-testid="record-no-parents">
                Nothing upstream — this is the start of the chain, or the links are withheld below.
              </p>
            ) : (
              <ul data-testid="record-parents">
                {parents.map((entry) => (
                  <li key={`${entry.type}-${entry.id}`} data-testid="record-parent">
                    <a href={`/records/${entry.type}/${entry.id}`}>
                      {entry.title}: {entry.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="card">
            <h2>What is attached to this</h2>
            {children.length === 0 ? (
              <p data-testid="record-no-children">Nothing downstream yet.</p>
            ) : (
              <ul data-testid="record-children">
                {children.map((entry) => (
                  <li key={`${entry.type}-${entry.id}`} data-testid="record-child">
                    <a href={`/records/${entry.type}/${entry.id}`}>
                      {entry.title}: {entry.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </article>

          {danglingParents.length > 0 && (
            <article className="card" data-testid="record-dangling">
              <h2>References this record names and this workspace does not hold</h2>
              {/* Surfaced rather than hidden. Migration `202611250001` stops new ones being written;
                  an older one is a finding a reader should see, not a blank in the chain. */}
              <ul>
                {danglingParents.map((entry) => (
                  <li key={`${entry.field}-${entry.id}`}>
                    {entry.field} names {entry.type} {entry.id}, which is not present here.
                  </li>
                ))}
              </ul>
            </article>
          )}

          {withheld.length > 0 && (
            <article className="card" data-testid="record-withheld">
              <h2>Withheld</h2>
              {/* Named, never counted — a count would disclose how much activity the record has seen
                  to a reader with no key to read it. */}
              <p>
                You hold no read permission for {withheld.join(', ')}. Records of those kinds may be
                attached to this one; how many is not shown, because that would itself be a disclosure.
              </p>
            </article>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="card" data-testid="record-history">
          <h2>History</h2>
          {!audit && (
            <p role="status" data-testid="record-history-loading">
              Loading the history…
            </p>
          )}
          {audit?.kind === 'forbidden' && (
            <p data-testid="record-history-forbidden">
              Reading history needs the audit permission in this workspace, which you do not hold. This is
              not a statement that there is no history.
            </p>
          )}
          {audit?.kind === 'error' && (
            <p data-testid="record-history-error">We could not load the history: {audit.detail}</p>
          )}
          {audit?.kind === 'ok' && audit.value.trail.length === 0 && (
            <p data-testid="record-history-empty">
              No transition has been recorded against this record.
            </p>
          )}
          {audit?.kind === 'ok' && audit.value.trail.length > 0 && (
            <>
              <ol data-testid="record-history-entries">
                {audit.value.trail.map((entry) => (
                  <li key={entry.id} data-testid="record-history-entry">
                    <strong>{entry.eventType}</strong> — {entry.createdAt} by {entry.actorId}
                  </li>
                ))}
              </ol>
              {/* The basis travels with the entries rather than living in documentation, for the same
                  reason the non-custody statement travels with the financial figures. */}
              <p className="lead" data-testid="record-history-basis">
                {audit.value.basis}
              </p>
            </>
          )}
        </section>
      )}
    </section>
  );
}
