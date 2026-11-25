'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PERSONA_WORKSPACES,
  type PersonaWorkspace,
  type PersonaWorkspaceId,
} from '../../lib/persona-workspaces';

/**
 * A persona workspace: the same platform, presented for one job.
 *
 * ## It shows authority; it never grants it
 *
 * Everything here is driven by `GET /api/v1/me/permissions`, which reports the caller's *own* effective keys.
 * A module appears when the caller holds the key gating its route, so the menu cannot offer a destination the
 * gateway would refuse — and it cannot hide one it would allow, which is the failure people notice less and
 * resent more.
 *
 * The server is unaffected by any of it. Every route enforces its own requirement when called, so reaching a
 * workspace by typing its URL grants nothing: the screen renders, the modules it offers are still the ones the
 * caller's keys open, and the pages behind them refuse independently. That is the difference between
 * presentation and policy, and the reason this component is not consulted by anything that authorizes.
 *
 * ## Why it reports what it cannot show
 *
 * A workspace the caller cannot enter is named rather than silently omitted. Someone sent a link to the finance
 * workspace needs to know they lack the authority for it, not to meet a blank page — "you cannot act here" and
 * "there is nothing here" are different facts, and conflating them is how people conclude the product is
 * broken.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'no-workspace' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; held: Set<string>; open: Set<PersonaWorkspaceId> };

async function failureOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return body.error ?? body.code ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function PersonaWorkspaceConsole({ workspace }: { workspace: PersonaWorkspace }) {
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
      // Signed in without a tenant workspace activated. A distinct fact from holding no permissions, and the
      // remedy differs: activate a workspace rather than ask for authority.
      setPhase({ kind: 'no-workspace' });
      return;
    }

    try {
      // A fresh single-use assertion per call: acting routes consume one, and a cached assertion would be
      // refused on its second use.
      const minted = await fetch('/api/v1/auth/assertion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: activeWorkspaceId }),
      });
      if (!minted.ok) throw new Error(await failureOf(minted));
      const { assertion } = (await minted.json()) as { assertion: string };

      const response = await fetch('/api/v1/me/permissions', {
        cache: 'no-store',
        headers: { 'x-assurapay-identity-assertion': assertion },
      });
      if (!response.ok) {
        setPhase({ kind: 'error', detail: await failureOf(response) });
        return;
      }
      const body = (await response.json()) as {
        permissionKeys: string[];
        workspaces: PersonaWorkspaceId[];
      };
      setPhase({
        kind: 'ready',
        held: new Set(body.permissionKeys),
        open: new Set(body.workspaces),
      });
    } catch (error) {
      setPhase({ kind: 'error', detail: error instanceof Error ? error.message : 'Request failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === 'loading')
    return (
      <p className="lead" role="status" data-testid="workspace-loading">
        Loading your workspace…
      </p>
    );

  if (phase.kind === 'signed-out')
    return (
      <section className="card" data-testid="workspace-signed-out">
        <h2>Sign in to use this workspace</h2>
        <p>A workspace shows what you can do, so there is nothing to show until you sign in.</p>
        <p>
          <a className="button button--primary" href="/auth/sign-in">
            Sign in
          </a>
        </p>
      </section>
    );

  if (phase.kind === 'no-workspace')
    return (
      <section className="card" data-testid="workspace-none-active">
        <h2>No workspace is active</h2>
        <p>Choose the organization workspace you are working in, and this page will show what you can do there.</p>
        <p>
          <Link className="button button--primary" href="/start">
            Choose a workspace
          </Link>
        </p>
      </section>
    );

  if (phase.kind === 'error')
    return (
      <section className="card" data-testid="workspace-error">
        <h2>We could not load your workspace</h2>
        <p>{phase.detail}</p>
        <p>
          <button className="button button--secondary" type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );

  const reachable = workspace.modules.filter(
    (item) => item.requires === undefined || phase.held.has(item.requires),
  );
  const withheld = workspace.modules.filter(
    (item) => item.requires !== undefined && !phase.held.has(item.requires),
  );
  const entered = phase.open.has(workspace.id);

  return (
    <div data-testid="persona-workspace">
      {!entered && (
        <section className="card" data-testid="workspace-not-yours">
          <h2>You do not have authority in this workspace</h2>
          {/* Named rather than hidden. Someone following a link needs to know they lack the authority, not to
              meet a blank page. */}
          <p>
            Nothing here is available to you yet. Ask a workspace administrator for the role this work needs,
            or switch to a workspace you hold authority in.
          </p>
        </section>
      )}

      {reachable.length > 0 && (
        <section className="grid" data-testid="workspace-modules">
          {reachable.map((item) => (
            <article className="card" key={item.href}>
              <h2>
                <Link href={item.href}>{item.label}</Link>
              </h2>
            </article>
          ))}
        </section>
      )}

      {withheld.length > 0 && (
        <p className="lead" data-testid="workspace-withheld">
          {withheld.length} further area{withheld.length === 1 ? '' : 's'} in this workspace need
          {withheld.length === 1 ? 's' : ''} authority you do not hold.
        </p>
      )}
    </div>
  );
}

/** The workspaces this caller can enter, for the switcher. Rendered from the same single source. */
export function PersonaWorkspaceSwitcher({ current }: { current: PersonaWorkspaceId }) {
  return (
    <nav aria-label="Workspace" className="workspace-switcher" data-testid="workspace-switcher">
      {PERSONA_WORKSPACES.map((entry) => (
        <Link
          key={entry.id}
          href={`/workspace/${entry.id}`}
          aria-current={entry.id === current ? 'page' : undefined}
          data-persona={entry.id}
        >
          {entry.title}
        </Link>
      ))}
    </nav>
  );
}
