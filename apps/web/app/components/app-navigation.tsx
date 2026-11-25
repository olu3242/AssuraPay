'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { scopedGet } from './scoped-fetch';

/**
 * The application chrome: brand, sections, the active workspace, and the one primary action.
 *
 * ## One header, extended — not a second one
 *
 * This component already rendered on every route from `layout.tsx`. The audit that prompted this
 * change asked for a new `components/layout/AppHeader.tsx`; building it would have left two headers
 * in one application, which is the duplicate-framework outcome the working agreement forbids. So the
 * header that exists grew the two things it was genuinely missing: a way to see and change which
 * workspace you are acting in, and the primary action.
 *
 * ## The styling is in `globals.css`, in tokens
 *
 * The audit specified the surface as Tailwind utilities — `backdrop-blur-md bg-white/80
 * dark:bg-slate-900/80`. **This application has no Tailwind**: no config, no dependency, no build
 * step for it. Those class names would have been inert strings, producing a header that looked
 * finished in the diff and unchanged in the browser. The same surface is expressed in
 * `.app-navigation` against the `--ap-*` tokens, which is also what makes it follow the per-persona
 * accent instead of hard-coding one blue.
 *
 * ## The switcher shows what the session says, never what the page assumed
 *
 * Workspace context is server state: an assertion is minted *for* a workspace and refused for one
 * the caller is not an active member of. So the switcher reads `/api/v1/auth/session` and
 * `/api/v1/me/workspaces` and shows that, and switching POSTs `activate-context` — the same call the
 * bootstrap console makes, for the same reason: the refusal comes from proven membership rather than
 * from this component being trusted. A header that cached a workspace name would eventually display
 * authority the session no longer carries.
 */

type Workspace = { id: string; name?: string; tenantId?: string };

type Session = { activeWorkspaceId?: string; workspaceId?: string; userId?: string };

/**
 * The sections, and why one of them is not the obvious path.
 *
 * `/performance` does not exist — the delivery plan lives at `/performance-blueprint`, and this link
 * was a dead one in the application chrome on every page until it was corrected. The audit that
 * prompted this change listed `/agreements`, `/performance` and `/workflow` as routes to refactor;
 * those are these labels, not paths. Keeping label and href side by side here is what makes that
 * mistake visible rather than repeatable.
 */
const SECTIONS: readonly { label: string; href: string }[] = Object.freeze([
  { label: 'Account & workspace', href: '/start' },
  { label: 'Agreements', href: '/contracts' },
  { label: 'Performance', href: '/performance-blueprint' },
  { label: 'Execution', href: '/execution' },
  { label: 'Settlements', href: '/settlements' },
  { label: 'Approvals', href: '/approvals' },
  { label: 'Workflow', href: '/workflow-intelligence' },
]);

export function AppNavigation() {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!response.ok) {
      // Signed out is the ordinary case on the public routes, not an error worth showing.
      setSession(null);
      setWorkspaces([]);
      return;
    }
    setSession((await response.json()) as Session);

    // `scopedGet` rather than a bare fetch, and the reason is a measurement rather than a
    // preference. `GET /v1/me/workspaces` is declared `access: 'identity'`, which reads like "a
    // session is enough" — it is not. The gateway answered `401 GATEWAY_ASSERTION_MISSING`, so the
    // route needs an assertion like any other, and the first version of this component sent none
    // and rendered no switcher at all: a header that looked correct and silently showed nothing.
    //
    // There is no circularity in minting one first. An assertion is minted *for* a workspace, and
    // the session already names the active one; listing the rest is what needs the call. With no
    // workspace active there is nothing to mint with and nothing to switch between, which is
    // exactly the state in which no switcher should appear.
    const mine = await scopedGet<unknown>('/api/v1/me/workspaces');
    // The route answers with the array itself, not an object wrapping it — read from the route
    // rather than assumed, which is the other half of the same mistake.
    setWorkspaces(mine.kind === 'ok' && Array.isArray(mine.value) ? (mine.value as Workspace[]) : []);
  }, []);

  useEffect(() => {
    void load();
    // Re-read on navigation: activating a workspace on `/start` must be reflected here without a
    // reload, and the session is the only thing that knows it changed.
  }, [load, pathname]);

  const activeWorkspaceId = session?.activeWorkspaceId ?? session?.workspaceId;

  const activate = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId || workspaceId === activeWorkspaceId) return;
      setSwitching(true);
      try {
        const minted = await fetch('/api/v1/auth/assertion', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        // A refusal here is the correct answer, not a failure to report loudly: the assertion is
        // minted for this workspace and refused for one the caller is not an active member of.
        if (minted.ok) {
          const { assertion } = (await minted.json()) as { assertion: string };
          await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate-context`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-assurapay-identity-assertion': assertion },
            body: JSON.stringify({}),
          });
        }
        await load();
      } finally {
        setSwitching(false);
      }
    },
    [activeWorkspaceId, load],
  );

  // The landing page carries its own chrome, scoped under `#preferred-landing` with its own
  // semantic layer over these same tokens. Rendering this header there would put two brands on one
  // screen.
  if (pathname === '/') return null;

  return (
    <header className="app-navigation" data-testid="app-navigation">
      <Link href="/" className="app-brand" aria-label="AssuraPay home">
        <img src="/images/assurapay-symbol.png" width="40" height="55" alt="" />
        <strong>AssuraPay</strong>
      </Link>

      <nav aria-label="Application">
        {SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            // Marked current for the section root and everything under it, so a record page opened
            // from Settlements still shows where the reader is.
            aria-current={
              pathname === section.href || pathname.startsWith(`${section.href}/`) ? 'page' : undefined
            }
          >
            {section.label}
          </Link>
        ))}
      </nav>

      <div className="app-navigation__actions">
        {activeWorkspaceId && workspaces.length > 0 && (
          <label className="app-workspace" data-testid="workspace-switcher">
            <span className="app-workspace__label">Workspace</span>
            <select
              data-testid="workspace-switcher-select"
              value={activeWorkspaceId}
              disabled={switching}
              onChange={(event) => void activate(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name?.trim() || workspace.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* The primary action, and only where it can succeed. Offering "New agreement" to a caller
            with no workspace active would lead to a route that refuses, which is worse than not
            offering it — `authoring.create` needs a workspace to create the agreement in. */}
        {activeWorkspaceId && (
          <Link className="button button--primary app-navigation__cta" href="/contracts" data-testid="new-agreement">
            New agreement
          </Link>
        )}
      </div>
    </header>
  );
}
