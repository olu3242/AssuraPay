'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The first surface in AssuraPay that actually calls the platform.
 *
 * Before this component the web application had 163 API routes and **zero** browser callers: 517 lines of TSX
 * with no form, no input, no `fetch`, and one button belonging to a carousel. Thirteen persistence batches made
 * the domain durable while the front end stayed a set of descriptive pages, so nothing a user could do
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

/**
 * What `GET /v1/me/workspaces` actually returns: **workspaces**, not membership rows.
 *
 * `listAuthorizedWorkspaces` returns `Workspace[]`, so the identifier is `id`. An earlier version of
 * this component read `workspaceId` and rendered an empty string into every list item — the row
 * appeared, the activate button appeared, and the workspace it named was blank. Checked against the
 * engine rather than guessed from the route's name, which is what produced the wrong field.
 *
 * `workspaceId` is still accepted because the route's shape is not pinned by a contract test, and a
 * client that broke when the field was renamed would be a worse failure than one that reads either.
 */
type Workspace = { id?: string; workspaceId?: string; name?: string; tenantId?: string } & Record<
  string,
  unknown
>;

/** The identifier, from whichever field the route used. */
function workspaceIdOf(workspace: Workspace): string {
  return workspace.id ?? workspace.workspaceId ?? '';
}

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
  const [memberships, setMemberships] = useState<Workspace[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  /** True when the deployment delivers verification by email, so the journey pauses at the inbox. */
  const [verificationPending, setVerificationPending] = useState(false);

  /**
   * Obtains a single-use identity assertion for the current session.
   *
   * This is the step a browser client cannot skip, and the reason is the platform's central
   * authentication rule rather than an implementation detail: the session cookie proves who you are
   * to the identity engine, but **the gateway authenticates only a signed assertion** — it never
   * reads identity from a header or a cookie, because an earlier implementation did exactly that and
   * `trust-app.ts` records it as "a complete authentication and authorization bypass on every route
   * that used it".
   *
   * So a cookie alone reaches nothing. `POST /v1/auth/assertion` is the join, and every identity-
   * or permission-class call below exchanges the cookie for an assertion first. One assertion per
   * request, minted fresh: acting routes *consume* it, so it cannot authorise a second action, and
   * a client that cached one would find its second call refused.
   */
  const assertionHeaders = useCallback(async (workspaceId?: string): Promise<HeadersInit> => {
    const response = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workspaceId ? { workspaceId } : {}),
    });
    if (!response.ok) throw new Error(`assertion could not be minted: ${await failureOf(response)}`);
    const { assertion } = (await response.json()) as { assertion: string };
    return { 'content-type': 'application/json', 'x-assurapay-identity-assertion': assertion };
  }, []);

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

  /**
   * Reads the memberships the platform will actually let this caller enter.
   *
   * `GET /v1/me/workspaces` is identity-class, so it goes through the gateway and needs an assertion
   * — unlike `GET /v1/auth/session`, which reads the session cookie directly. An earlier version of
   * this component sent neither and emptied the list on any failure, so a caller who had just
   * founded an organization was shown "No workspace memberships yet" and the reason was invisible.
   * Reporting the refusal is the difference between a component that works and one that looks like
   * the platform lost the membership it had just created.
   */
  const refreshMemberships = useCallback(async (): Promise<string | undefined> => {
    try {
      const response = await fetch('/api/v1/me/workspaces', {
        cache: 'no-store',
        headers: await assertionHeaders(),
      });
      if (!response.ok) {
        setMemberships([]);
        return `Workspace list refused: ${await failureOf(response)}`;
      }
      const body = (await response.json()) as Workspace[] | { workspaces?: Workspace[] };
      setMemberships(Array.isArray(body) ? body : (body.workspaces ?? []));
      return undefined;
    } catch (error) {
      setMemberships([]);
      return `Workspace list failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, [assertionHeaders]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (!session) return;
    void refreshMemberships().then((failure) => {
      if (failure) setOutcome({ kind: 'error', message: failure });
    });
  }, [session, refreshMemberships]);

  /**
   * One shape for every call, so a failure always surfaces the route's reason.
   *
   * `after` may report its own failure by returning a message, and when it does that message is what
   * the user sees — not `"<label> succeeded"`. The first version set the success outcome
   * unconditionally after running `after`, which meant a follow-up refusal was overwritten by the
   * word "succeeded" a few milliseconds later. That masked a real refusal during exactly the
   * investigation it would have answered: tenant founding reported success while the workspace list
   * behind it was being denied, and the page showed "No workspace memberships yet" with no reason
   * anywhere. A component whose stated purpose is that errors are shown, not swallowed, must not
   * swallow the second one.
   */
  const run = useCallback(
    async (
      label: string,
      call: () => Promise<Response>,
      after?: (body: unknown) => Promise<string | undefined | void>,
    ) => {
      setOutcome({ kind: 'busy' });
      try {
        const response = await call();
        if (!response.ok) {
          setOutcome({ kind: 'error', message: `${label} refused: ${await failureOf(response)}` });
          return;
        }
        // Parsed once and handed to `after`, so a follow-up step can use what the route returned —
        // the workspace id `POST /v1/tenants` names, for instance — without re-requesting it.
        const body = await response.json().catch(() => null);
        const failure = after ? await after(body) : undefined;
        setOutcome(
          failure
            ? { kind: 'error', message: `${label} succeeded, but ${failure}` }
            : { kind: 'ok', message: `${label} succeeded.` },
        );
      } catch (error) {
        setOutcome({
          kind: 'error',
          message: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [],
  );

  /**
   * Registers, then verifies with the token registration returned.
   *
   * Two calls behind one button, and the reason is a real property of the platform rather than a
   * convenience. A registered identity is `PENDING_VERIFICATION` and sign-in refuses anything that
   * is not `ACTIVE`, so registration alone leaves a user in a state they can do nothing with. In a
   * deployment with Engine 09 the token would arrive by email and this second call would happen
   * when the user clicked the link in it; with `ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=DIRECT_RETURN`
   * the deployment has declared it has no such channel and returns the token here instead.
   *
   * The button is honest about which of the two failed, because they fail for different reasons and
   * a user who is already registered needs to see that rather than a generic refusal.
   */
  const register = () =>
    run('Registration', async () => {
      const response = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, displayName }),
      });
      if (!response.ok) return response;

      const registered = (await response.json()) as { id: string; emailVerificationToken?: string };
      if (!registered.emailVerificationToken) {
        // The deployment has a delivery channel, so the token went to the address and the journey
        // continues in the user's inbox. Reported rather than treated as a failure.
        setVerificationPending(true);
        return response;
      }

      setVerificationPending(false);
      return await fetch('/api/v1/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: registered.id, token: registered.emailVerificationToken }),
      });
    });

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
  /** Writes a new workspace's first permission grant. Reports its own failure rather than throwing. */
  const foundAdministration = useCallback(
    async (workspaceId: string): Promise<string | undefined> => {
      try {
        const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/found`, {
          method: 'POST',
          headers: await assertionHeaders(workspaceId),
          body: JSON.stringify({}),
        });
        if (!response.ok) return `administration could not be founded: ${await failureOf(response)}`;
        return undefined;
      } catch (error) {
        return `administration could not be founded: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
    [assertionHeaders],
  );

  /**
   * Founds the organization, and then founds its administration.
   *
   * Two routes, because the platform separates two acts a user experiences as one.
   * `POST /v1/tenants` mints the tenant, its first workspace and the caller's OWNER membership.
   * `POST /v1/workspaces/{id}/found` writes the workspace's **first permission grant** — and without it
   * the owner of a brand-new organization can do nothing in it, because every other route is
   * permission-gated and there is no grant to evaluate. The browser journey found this the direct way:
   * "Context activation refused: ENFORCEMENT_PERMISSION_DENIED", on the workspace the caller had just
   * created and owned.
   *
   * Both are identity-class by necessity — a permission check on either would require a grant that
   * does not exist yet — and both are safe for the same reason: `POST /v1/tenants` mints a tenant the
   * caller cannot name, and `bootstrapWorkspaceGrants` refuses unless the caller is already an ACTIVE
   * OWNER of a workspace holding no grant at all.
   *
   * The workspace id comes from the founding response rather than from the membership list. Both would
   * work today; only one keeps working once a caller has a second workspace.
   *
   * A fresh assertion per call, because an acting route consumes the one it is given.
   */
  const foundTenant = () =>
    run(
      'Tenant founding',
      async () =>
        fetch('/api/v1/tenants', {
          method: 'POST',
          headers: await assertionHeaders(),
          body: JSON.stringify({
            name: organizationName,
            slug: slugify(organizationName),
            workspaceType: 'ORGANIZATION',
          }),
        }),
      async (body) => {
        const workspaceId = (body as { workspace?: { id?: string } } | null)?.workspace?.id;
        if (!workspaceId) return 'the founding response named no workspace, so administration was not founded';

        const administration = await foundAdministration(workspaceId);
        // Refreshed after the grant exists, not before: `GET /v1/me/workspaces` is itself gated, and
        // reading it first would report an empty list for a workspace that had just been created.
        await refreshSession();
        const listed = await refreshMemberships();
        return administration ?? listed;
      },
    );

  const activate = (workspaceId: string) =>
    run(
      'Context activation',
      // The assertion is minted *for this workspace*: `issueAssertionForSession` refuses a workspace
      // the caller is not an active member of, so scoping it here means the refusal comes from
      // proven membership rather than from the activation route trusting a body field.
      async () =>
        fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate-context`, {
          method: 'POST',
          headers: await assertionHeaders(workspaceId),
          body: JSON.stringify({}),
        }),
      refreshSession,
    );

  const signOut = () =>
    run('Sign-out', async () => fetch('/api/v1/auth/logout', { method: 'POST', headers: await assertionHeaders() }), async () => {
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
        {verificationPending ? (
          <p data-testid="verification-pending">
            Check your email — registration is not complete until the address is verified.
          </p>
        ) : null}
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
              {memberships.map((workspace) => {
                const id = workspaceIdOf(workspace);
                return (
                  <li key={id} data-testid="membership">
                    <span data-testid="membership-workspace">{id}</span>
                    <button
                      type="button"
                      className="button button--secondary"
                      data-testid={`activate-${id}`}
                      onClick={() => activate(id)}
                    >
                      Work in this workspace
                    </button>
                  </li>
                );
              })}
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
