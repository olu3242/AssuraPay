'use client';

import { useCallback, useEffect, useState } from 'react';

type Session = {
  sessionId: string;
  userId: string;
  identityAssuranceLevel?: string;
  activeWorkspaceId?: string;
  tenantId?: string;
} & Record<string, unknown>;

type Workspace = { id?: string; workspaceId?: string; name?: string; tenantId?: string } & Record<string, unknown>;
type Outcome = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

const workspaceIdOf = (workspace: Workspace) => workspace.id ?? workspace.workspaceId ?? '';
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function failureOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `${response.status} ${response.statusText}`;
}

/**
 * RC1 B-D console.
 *
 * Phase B changes the bootstrap's sign-in boundary: an email address no longer creates
 * a session. The browser first requests a short-lived passwordless proof, then presents
 * that proof before the session cookie can be minted. DIRECT_RETURN is only the explicit
 * no-notification deployment used by this certification harness; a real delivery engine
 * can carry the same token without changing the session rule.
 */
export function Rc1BdConsole() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Workspace[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const assertionHeaders = useCallback(async (workspaceId?: string): Promise<HeadersInit> => {
    const response = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workspaceId ? { workspaceId } : {}),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const { assertion } = (await response.json()) as { assertion: string };
    return { 'content-type': 'application/json', 'x-assurapay-identity-assertion': assertion };
  }, []);

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
    const response = await fetch('/api/v1/me/workspaces', {
      cache: 'no-store',
      headers: await assertionHeaders(),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const body = (await response.json()) as Workspace[] | { workspaces?: Workspace[] };
    setMemberships(Array.isArray(body) ? body : (body.workspaces ?? []));
  }, [assertionHeaders]);

  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => { if (session) void refreshMemberships().catch(() => setMemberships([])); }, [session, refreshMemberships]);

  const run = useCallback(async (label: string, operation: () => Promise<void>) => {
    setOutcome({ kind: 'busy' });
    try {
      await operation();
      setOutcome({ kind: 'ok', message: `${label} succeeded.` });
    } catch (error) {
      setOutcome({ kind: 'error', message: `${label} refused: ${error instanceof Error ? error.message : String(error)}` });
    }
  }, []);

  const register = () => run('Registration', async () => {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, displayName }),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const registered = (await response.json()) as { id: string; emailVerificationToken?: string };
    if (!registered.emailVerificationToken) throw new Error('VERIFICATION_DELIVERY_PENDING');
    const verified = await fetch('/api/v1/auth/verify-email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: registered.id, token: registered.emailVerificationToken }),
    });
    if (!verified.ok) throw new Error(await failureOf(verified));
  });

  const signIn = () => run('Sign-in', async () => {
    const challengeResponse = await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (!challengeResponse.ok) throw new Error(await failureOf(challengeResponse));
    const challenge = (await challengeResponse.json()) as { challengeId?: string; proofToken?: string };
    if (!challenge.challengeId) throw new Error('LOGIN_CHALLENGE_MISSING');
    if (!challenge.proofToken) throw new Error('LOGIN_PROOF_DELIVERY_PENDING');

    const loginResponse = await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, challengeId: challenge.challengeId, proofToken: challenge.proofToken }),
    });
    if (!loginResponse.ok) throw new Error(await failureOf(loginResponse));
    await refreshSession();
  });

  const foundTenant = () => run('Tenant founding', async () => {
    const response = await fetch('/api/v1/tenants', {
      method: 'POST',
      headers: await assertionHeaders(),
      body: JSON.stringify({ name: organizationName, slug: slugify(organizationName), workspaceType: 'ORGANIZATION' }),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const body = (await response.json()) as { workspace?: { id?: string } };
    const workspaceId = body.workspace?.id;
    if (!workspaceId) throw new Error('WORKSPACE_NOT_RETURNED');

    const found = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/found`, {
      method: 'POST', headers: await assertionHeaders(workspaceId), body: JSON.stringify({}),
    });
    if (!found.ok) throw new Error(await failureOf(found));
    await refreshSession();
    await refreshMemberships();
  });

  const activate = (workspace: Workspace) => run('Context activation', async () => {
    const workspaceId = workspaceIdOf(workspace);
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate-context`, {
      method: 'POST', headers: await assertionHeaders(workspaceId), body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    await refreshSession();
    await refreshMemberships();
  });

  const signOut = () => run('Sign-out', async () => {
    const response = await fetch('/api/v1/auth/logout', {
      method: 'POST', headers: await assertionHeaders(session?.activeWorkspaceId), body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    await refreshSession();
  });

  return (
    <main className="page-shell" data-testid="bootstrap-console">
      <section className="surface-card">
        <p className="eyebrow">RC1 B-D convergence</p>
        <h1>Enter AssuraPay</h1>
        <p>Identity possession, workspace authority, agreements and performance execution are certified from this boundary.</p>

        <label>Email<input data-testid="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Display name<input data-testid="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <div className="button-row">
          <button data-testid="register" onClick={register} disabled={outcome.kind === 'busy'}>Register & verify</button>
          <button data-testid="sign-in" onClick={signIn} disabled={outcome.kind === 'busy'}>Sign in with email proof</button>
        </div>

        {outcome.kind === 'ok' && <p data-testid="outcome-ok">{outcome.message}</p>}
        {outcome.kind === 'error' && <p data-testid="outcome-error">{outcome.message}</p>}

        {!session ? <p data-testid="session-absent">No active session.</p> : (
          <section data-testid="session-summary">
            <p>User: <span data-testid="session-user">{session.userId}</span></p>
            <p>Workspace: <span data-testid="session-workspace">{session.activeWorkspaceId ?? '— none yet —'}</span></p>
            <p>Tenant: <span data-testid="session-tenant">{session.tenantId ?? '— none yet —'}</span></p>
            <button data-testid="sign-out" onClick={signOut}>Sign out</button>
          </section>
        )}

        {session && (
          <section>
            <label>Organization name<input data-testid="organization-name" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} /></label>
            <button data-testid="found-tenant" onClick={foundTenant}>Found organization</button>
            {memberships.length === 0 ? <p data-testid="no-memberships">No workspace memberships yet.</p> : memberships.map((workspace) => {
              const id = workspaceIdOf(workspace);
              return <div data-testid="membership" key={id}>
                <span data-testid="membership-workspace">{id}</span>
                <button data-testid={`activate-${id}`} onClick={() => activate(workspace)}>Activate workspace</button>
              </div>;
            })}
          </section>
        )}
      </section>
    </main>
  );
}
