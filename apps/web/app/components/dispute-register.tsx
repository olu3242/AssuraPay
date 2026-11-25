'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The dispute register.
 *
 * Reads `GET /api/v1/disputes` under the caller's own scope and shows what it read. The states are kept
 * apart deliberately: "you may not see these", "we could not find out" and "there are none" are three
 * different facts, and a register that renders all three as an empty table is how a case gets forgotten.
 */

type Dispute = {
  id: string;
  releaseRequestId: string;
  kind: string;
  status: string;
  description: string;
  raisedBy: string;
  createdAt: string;
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'forbidden' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; disputes: Dispute[]; total: number };

export function DisputeRegister() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const session = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!session.ok) {
      setPhase({ kind: 'signed-out' });
      return;
    }
    const { activeWorkspaceId } = (await session.json()) as { activeWorkspaceId?: string };
    if (!activeWorkspaceId) {
      setPhase({ kind: 'forbidden' });
      return;
    }
    try {
      const minted = await fetch('/api/v1/auth/assertion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: activeWorkspaceId }),
      });
      if (!minted.ok) throw new Error(`HTTP ${minted.status}`);
      const { assertion } = (await minted.json()) as { assertion: string };
      const response = await fetch('/api/v1/disputes', {
        cache: 'no-store',
        headers: { 'x-assurapay-identity-assertion': assertion },
      });
      if (response.status === 403) {
        setPhase({ kind: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setPhase({ kind: 'error', detail: `HTTP ${response.status}` });
        return;
      }
      const body = (await response.json()) as { items: Dispute[]; total: number };
      setPhase({ kind: 'ready', disputes: body.items, total: body.total });
    } catch (error) {
      setPhase({ kind: 'error', detail: error instanceof Error ? error.message : 'Request failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === 'loading')
    return (
      <p className="lead" role="status" data-testid="disputes-loading">
        Loading the register…
      </p>
    );

  if (phase.kind === 'signed-out')
    return (
      <section className="card" data-testid="disputes-signed-out">
        <h2>Sign in to see the register</h2>
        <p>Disputes belong to a workspace, so there is nothing to show until you sign in.</p>
        <p>
          <a className="button button--primary" href="/auth/sign-in">
            Sign in
          </a>
        </p>
      </section>
    );

  if (phase.kind === 'forbidden')
    return (
      <section className="card" data-testid="disputes-forbidden">
        <h2>You cannot see disputes here</h2>
        {/* Stated, not softened: a case nobody can see is a case nobody works. */}
        <p>Handling contested execution needs the dispute manager role. Ask a workspace administrator for it.</p>
      </section>
    );

  if (phase.kind === 'error')
    return (
      <section className="card" data-testid="disputes-error">
        <h2>We could not load the register</h2>
        <p>{phase.detail}</p>
        <p>
          <button className="button button--secondary" type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );

  if (phase.disputes.length === 0)
    return (
      <section className="card" data-testid="disputes-empty">
        <h2>No disputes</h2>
        <p>Nothing in this workspace is contested.</p>
      </section>
    );

  return (
    <section className="grid" data-testid="disputes-list">
      {phase.disputes.map((dispute) => (
        <article className="card" key={dispute.id} data-testid="dispute">
          <p className="eyebrow">{dispute.status}</p>
          <h2>{dispute.kind}</h2>
          <p>{dispute.description}</p>
          <p>Release request {dispute.releaseRequestId}</p>
        </article>
      ))}
    </section>
  );
}
