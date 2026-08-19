'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The first surface in AssuraPay that actually calls the platform.
 *
 * Before this component the web application had 163 API routes and **zero** browser callers: 517 lines of TSX
 * with no form, no input, no `fetch`, and one button belonging to a carousel. Thirteen persistence batches made
 * the domain durable while the front end stayed a set of descriptive placeholders, so nothing a user could do
 * in a browser reached the platform at all. `docs/product/RC1_GAP_MATRIX.md` records the measurement.
 *
 * This is the bootstrap journey, and it is deliberately the whole of it — register, sign in, found a tenant,
 * see the workspaces the caller is actually a member of, activate one as the working context, sign out. It
 * exists first because every other route in the platform is permission-gated, a permission is evaluated against
 * a grant, a grant is workspace-scoped, and forced row-level security returns nothing to a caller with no
 * workspace. Until a browser can complete this sequence, no other browser journey can begin.
 *
 * ## What it does not do
 *
 * It adds no business behaviour of its own. Every state transition here is a call to a route that already
 * existed and was already certified against PostgreSQL; the component holds no domain rule, derives no
 * authority, and has no branch that behaves differently under test. The tenant is minted server-side by
 * `POST /v1/tenants` and cannot be named by this form — that is the property which makes the identity-class
 * route safe, and a client that offered a tenant field would undermine it.
 *
 * ## Errors are shown, not swallowed
 *
 * Each call renders the route's own failure. A denied permission, an unauthenticated session and a readiness
 * refusal are different outcomes and a user needs to see which one happened; a component that collapsed them
 * into "something went wrong" would make the fail-closed behaviour the platform is built on invisible.
 */

type Session = {
  sessionId: string;
  userId: string;
  identityAssuranceLevel?: string;
  activeWorkspaceId?: string;
  tenantId?: string;
} & Record<string, unknown>;

type Membership = { workspaceId: string; tenantId?: string; role?: string } & Record<string, unknown>;

type Outcome = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string };

/**
 * A URL-safe slug from a display name.
 *
 * Derived in the client because the route requires both and the user should type one. `trust_workspaces` has a
 * unique index on `(tenant_id, slug)` since `202608110013`, so two organizations of the same name in one tenant
 * are refused by the index rather than silently merged — which is the behaviour this derivation relies on rather
 * than trying to prevent.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** The route's own error text, so a refusal is legible rather than generic. */
async function failureOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `${response.status} ${response.statusText}`;
}

export function BootstrapConsole() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  /**
   * Resolves the session from the cookie the login route set.
   *
   * `assurapay_session` is `HttpOnly`, so this is the only way a client can know whether it is signed in —
   * there is no readable cookie and no token in local storage, which is the point.
   */
  const refreshSession = useCallback(async () => {
    const response = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!response.ok) {
      setSession(null);
      setMemberships([]);
      return;
    }
    setSession((await response.json()) as Session);
  }, []);

  const refreshMemberships = useCallback(async () => {
    const response = await fetch('/api/v1/me/workspaces', { cache: 'no-store' });
    if (!response.ok) {
      setMemberships([]);
      return;
    }
    const body = (await response.json()) as Membership[] | { workspaces?: Membership[] };
    setMemberships(Array.isArray(body) ? body : (body.workspaces ?? []));
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (session) void refreshMemberships();
  }, [session, refreshMemberships]);

  /** One shape for every call, so a failure always surfaces the route's reason. */
  const run = useCallback(
    async (label: string, call: () => Promise<Response>, after?: () => Promise<void>) => {
      setOutcome({ kind: 'busy' });
      try {
        const response = await call();
        if (!response.ok) {
          setOutcome({ kind: 'error', message: `${label} refused: ${await failureOf(response)}` });
          return;
        }
        if (after) await after();
        setOutcome({ kind: 'ok', message: `${label} succeeded.` });
      } catch (error) {
        setOutcome({
          kind: 'error',
          message: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [],
  );

  const register = () =>
    run('Registration', () =>
      fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, displayName }),
      }),
    );

  const signIn = () =>
    run(
      'Sign-in',
      () =>
        fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }),
      refreshSession,
    );

  // The tenant is minted by the route and never named here. See the note above.
  //
  // `name` and `slug` are what the route reads — checked against it rather than guessed, after a first version
  // sent `organizationName` and would have founded every tenant with an empty name.
  const foundTenant = () =>
    run(
      'Tenant founding',
      () =>
        fetch('/api/v1/tenants', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: organizationName,
            slug: slugify(organizationName),
            workspaceType: 'ORGANIZATION',
          }),
        }),
      async () => {
        await refreshSession();
        await refreshMemberships();
      },
    );

  const activate = (workspaceId: string) =>
    run(
      'Context activation',
      () =>
        fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate-context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      refreshSession,
    );

  const signOut = () =>
    run('Sign-out', () => fetch('/api/v1/auth/logout', { method: 'POST' }), async () => {
      setSession(null);
      setMemberships([]);
    });

  return (
    <main className="shell" data-testid="bootstrap-console">
      <p className="eyebrow">Trust Foundation · Engines 01–05</p>
      <h1>Get started</h1>
      <p className="lead">
        Register an identity, sign in, found your organization and choose the workspace you are working in.
      </p>

      <section className="panel">
        <h2>Session</h2>
        {session ? (
          <dl data-testid="session-summary">
            <dt>Signed in as</dt>
            <dd data-testid="session-user">{session.userId}</dd>
            <dt>Tenant</dt>
            <dd data-testid="session-tenant">{session.tenantId ?? '— none yet —'}</dd>
            <dt>Active workspace</dt>
            <dd data-testid="session-workspace">{session.activeWorkspaceId ?? '— none yet —'}</dd>
          </dl>
        ) : (
          <p data-testid="session-absent">Not signed in.</p>
        )}
      </section>

      <section className="panel">
        <h2>Identity</h2>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          data-testid="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          name="displayName"
          data-testid="display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <button type="button" className="button button--secondary" data-testid="register" onClick={register}>
          Register
        </button>
        <button type="button" className="button button--primary" data-testid="sign-in" onClick={signIn}>
          Sign in
        </button>
        {session ? (
          <button type="button" className="button button--secondary" data-testid="sign-out" onClick={signOut}>
            Sign out
          </button>
        ) : null}
      </section>

      {session ? (
        <section className="panel">
          <h2>Organization</h2>
          <label htmlFor="organizationName">Organization name</label>
          <input
            id="organizationName"
            name="organizationName"
            data-testid="organization-name"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
          />
          <button
            type="button"
            className="button button--primary"
            data-testid="found-tenant"
            onClick={foundTenant}
          >
            Found organization
          </button>
        </section>
      ) : null}

      {session ? (
        <section className="panel">
          <h2>Workspaces</h2>
          {memberships.length === 0 ? (
            <p data-testid="no-memberships">No workspace memberships yet.</p>
          ) : (
            <ul data-testid="memberships">
              {memberships.map((membership) => (
                <li key={membership.workspaceId} data-testid="membership">
                  <span data-testid="membership-workspace">{membership.workspaceId}</span>
                  <button
                    type="button"
                    className="button button--secondary"
                    data-testid={`activate-${membership.workspaceId}`}
                    onClick={() => activate(membership.workspaceId)}
                  >
                    Work in this workspace
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="panel" aria-live="polite">
        <h2>Result</h2>
        {outcome.kind === 'idle' ? <p data-testid="outcome-idle">No action taken yet.</p> : null}
        {outcome.kind === 'busy' ? <p data-testid="outcome-busy">Working…</p> : null}
        {outcome.kind === 'ok' ? <p data-testid="outcome-ok">{outcome.message}</p> : null}
        {outcome.kind === 'error' ? <p data-testid="outcome-error">{outcome.message}</p> : null}
      </section>
    </main>
  );
}
