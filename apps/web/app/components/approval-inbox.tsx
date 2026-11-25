'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApprovalInbox, ApprovalInboxEntry } from '../../lib/flow-operations';

/**
 * The approval inbox — the first screen in this application that does anything.
 *
 * `/approvals` was one line of text: a heading, a sentence, and no queue. It is also where the
 * Engine 09 notification emails send a release approver — "a release approval is waiting for you" —
 * so the loop ended at a page that showed no approvals. This closes it.
 *
 * ## Why a client component
 *
 * A server component has no authenticated caller: no identity, so no tenant, so no trust scope, and
 * forced row-level security correctly returns nothing. Every figure on this screen belongs to one
 * signed-in person, so it has to be fetched by that person's browser under their own scope. This is
 * the same pattern `bootstrap-console.tsx` established.
 *
 * ## One assertion per call, minted fresh
 *
 * `trust-app.ts` records that reading identity from a cookie or header was "a complete
 * authentication and authorization bypass on every route that used it", so the gateway authenticates
 * only a signed assertion. Every call below mints its own rather than caching one.
 *
 * That is deliberately stricter than the routes currently require. `requestContext` "verifies
 * without consuming, so it is safe on every request and leaves the assertion's single use available
 * to an acting path" — and `actingRequestContext`, the consuming path, has no callers, so today no
 * route consumes an assertion and a cached one would in fact be accepted again. Minting per call is
 * what the design intends and what an acting route will enforce once it is wired to the consuming
 * context; a client that cached one would start failing at that point. The measurement is recorded
 * in the convergence report rather than worked around here.
 *
 * ## What it refuses to do
 *
 * It never shows an Approve button to someone who would be refused. `getApprovalInbox` computes
 * `actionable` with the same membership predicate `FlowOrchestrator.decide` authorizes with, and
 * only actionable entries arrive here. Approvals belonging to other people are counted, not listed:
 * hiding them entirely would make a queue look empty when it is merely not yours, which is the
 * confusion that leaves a release waiting.
 *
 * And it shows no figure it has not read. Loading, empty, unauthorized and error are four distinct
 * states with four distinct messages, because "nothing is waiting for you" and "we could not find
 * out" are different facts and conflating them is how a person misses an approval.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'forbidden'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; inbox: ApprovalInbox };

type Decision = 'APPROVE' | 'REJECT';

async function failureOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return body.error ?? body.code ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Minutes since a task was raised, for "waiting 2h 14m" rather than a raw timestamp. */
function waitingFor(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ApprovalInboxConsole({ highlightTaskId }: { highlightTaskId?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [deciding, setDeciding] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<string | undefined>();
  // Read once per render pass rather than per row, so every age on screen is measured from the
  // same instant and the list cannot show two rows aged a tick apart.
  const [now, setNow] = useState<number>(() => Date.now());

  /**
   * A fresh assertion for exactly one call.
   *
   * The workspace is passed so the assertion is scoped to it; without one the gateway has a tenant
   * but no workspace, and a workspace-scoped read returns nothing.
   */
  const assertionHeaders = useCallback(async (workspaceId: string): Promise<HeadersInit> => {
    const response = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const { assertion } = (await response.json()) as { assertion: string };
    return { 'content-type': 'application/json', 'x-assurapay-identity-assertion': assertion };
  }, []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    setNow(Date.now());

    const session = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!session.ok) {
      setPhase({ kind: 'signed-out' });
      return;
    }
    const { activeWorkspaceId } = (await session.json()) as { activeWorkspaceId?: string };
    if (!activeWorkspaceId) {
      // Signed in with no workspace activated. Distinct from signed out, and the remedy differs.
      setPhase({ kind: 'forbidden', detail: 'No workspace is active for this session.' });
      return;
    }

    try {
      const response = await fetch('/api/v1/approvals', {
        cache: 'no-store',
        headers: await assertionHeaders(activeWorkspaceId),
      });
      if (response.status === 403) {
        setPhase({ kind: 'forbidden', detail: await failureOf(response) });
        return;
      }
      if (!response.ok) {
        setPhase({ kind: 'error', detail: await failureOf(response) });
        return;
      }
      setPhase({ kind: 'ready', inbox: (await response.json()) as ApprovalInbox });
    } catch (error) {
      setPhase({ kind: 'error', detail: error instanceof Error ? error.message : 'Request failed' });
    }
  }, [assertionHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (entry: ApprovalInboxEntry, decision: Decision) => {
      setDeciding(entry.taskId);
      setOutcome(undefined);
      try {
        const session = await fetch('/api/v1/auth/session', { cache: 'no-store' });
        const { activeWorkspaceId } = (await session.json()) as { activeWorkspaceId?: string };
        if (!activeWorkspaceId) throw new Error('No workspace is active for this session.');

        const response = await fetch(`/api/v1/flow-tasks/${entry.taskId}/decisions`, {
          method: 'POST',
          headers: await assertionHeaders(activeWorkspaceId),
          body: JSON.stringify({ decision }),
        });
        if (!response.ok) throw new Error(await failureOf(response));

        setOutcome(
          `${entry.stepTitle} ${decision === 'APPROVE' ? 'approved' : 'rejected'} for ${entry.transactionId}.`,
        );
        // Reloaded rather than removed locally: deciding one step can open the next, and the
        // authoritative queue is the server's. Dropping the row by hand would show a stale inbox.
        await load();
      } catch (error) {
        setOutcome(error instanceof Error ? error.message : 'The decision was not recorded.');
      } finally {
        setDeciding(undefined);
      }
    },
    [assertionHeaders, load],
  );

  if (phase.kind === 'loading')
    return (
      <p className="lead" role="status" data-testid="approvals-loading">
        Loading your approvals…
      </p>
    );

  if (phase.kind === 'signed-out')
    return (
      <section className="card" data-testid="approvals-signed-out">
        <h2>Sign in to see your approvals</h2>
        <p>Approvals belong to a person and a workspace, so there is nothing to show until you sign in.</p>
        <p>
          <a className="button button--primary" href="/auth/sign-in">
            Sign in
          </a>
        </p>
      </section>
    );

  if (phase.kind === 'forbidden')
    return (
      <section className="card" data-testid="approvals-forbidden">
        <h2>You cannot see approvals here</h2>
        {/* Stated rather than softened: a person who cannot act needs to know to ask someone, not
            to keep refreshing a page that will never fill. */}
        <p>{phase.detail}</p>
        <p>Ask a workspace administrator for the role that approves releases.</p>
      </section>
    );

  if (phase.kind === 'error')
    return (
      <section className="card" data-testid="approvals-error">
        <h2>We could not load your approvals</h2>
        <p>{phase.detail}</p>
        <p>
          <button className="button button--secondary" type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );

  const { entries, waitingOnOthers } = phase.inbox;

  return (
    <div data-testid="approval-inbox">
      {outcome && (
        <p className="lead" role="status" data-testid="approvals-outcome">
          {outcome}
        </p>
      )}

      {entries.length === 0 ? (
        <section className="card" data-testid="approvals-empty">
          <h2>Nothing is waiting for you</h2>
          <p>
            {waitingOnOthers > 0
              ? `${waitingOnOthers} approval${waitingOnOthers === 1 ? '' : 's'} in this workspace ${
                  waitingOnOthers === 1 ? 'is' : 'are'
                } waiting on someone else's role.`
              : 'No execution step in this workspace is currently waiting for a decision.'}
          </p>
        </section>
      ) : (
        <>
          <section className="grid">
            {entries.map((entry) => (
              <article
                className="card"
                key={entry.taskId}
                data-testid="approval-entry"
                aria-current={entry.taskId === highlightTaskId ? 'true' : undefined}
              >
                <h2>{entry.stepTitle}</h2>
                <p>
                  Transaction {entry.transactionId}
                  {entry.agreementId ? ` · Agreement ${entry.agreementId}` : ''}
                </p>
                <p>
                  Waiting {waitingFor(entry.createdAt, now)} · requires {entry.requiredRole}
                </p>
                <p>
                  <button
                    className="button button--primary"
                    type="button"
                    data-testid={`approve-${entry.taskId}`}
                    disabled={deciding === entry.taskId}
                    onClick={() => void decide(entry, 'APPROVE')}
                  >
                    {deciding === entry.taskId ? 'Recording…' : 'Approve'}
                  </button>{' '}
                  <button
                    className="button button--secondary"
                    type="button"
                    data-testid={`reject-${entry.taskId}`}
                    disabled={deciding === entry.taskId}
                    onClick={() => void decide(entry, 'REJECT')}
                  >
                    Reject
                  </button>
                </p>
              </article>
            ))}
          </section>
          {waitingOnOthers > 0 && (
            <p className="lead" data-testid="approvals-waiting-on-others">
              {waitingOnOthers} further approval{waitingOnOthers === 1 ? '' : 's'} in this workspace{' '}
              {waitingOnOthers === 1 ? 'is' : 'are'} waiting on someone else&apos;s role.
            </p>
          )}
        </>
      )}
    </div>
  );
}
