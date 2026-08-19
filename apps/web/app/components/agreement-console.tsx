'use client';

import { useCallback, useEffect, useState } from 'react';

type Session = {
  userId: string;
  activeWorkspaceId?: string;
} & Record<string, unknown>;

type Contract = {
  id?: string;
  contractNumber?: string;
  title?: string;
  contractType?: string;
  status?: string;
} & Record<string, unknown>;

type Outcome =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

async function failureOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `${response.status} ${response.statusText}`;
}

/**
 * Phase C — a browser surface over the existing agreement routes.
 *
 * The component owns no contract state machine. Every mutation goes through the
 * canonical HTTP routes, under the caller's current workspace and a fresh signed
 * assertion. The founder begins as WORKSPACE_ADMINISTRATOR, so contract authority
 * is assigned explicitly through the governed role-assignment route rather than
 * silently implied by the page.
 */
export function AgreementConsole() {
  const [session, setSession] = useState<Session | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractNumber, setContractNumber] = useState('');
  const [title, setTitle] = useState('');
  const [contractType, setContractType] = useState('COMMERCIAL');
  const [intelligenceVersionId, setIntelligenceVersionId] = useState('');
  const [intelligenceItemId, setIntelligenceItemId] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const refreshSession = useCallback(async () => {
    const response = await fetch('/api/v1/auth/session', { cache: 'no-store' });
    if (!response.ok) {
      setSession(null);
      return;
    }
    setSession((await response.json()) as Session);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const assertionHeaders = useCallback(async (): Promise<HeadersInit> => {
    if (!session?.activeWorkspaceId) throw new Error('ACTIVE_WORKSPACE_REQUIRED');
    const response = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: session.activeWorkspaceId }),
    });
    if (!response.ok) throw new Error(`ASSERTION_FAILED: ${await failureOf(response)}`);
    const { assertion } = (await response.json()) as { assertion: string };
    return {
      'content-type': 'application/json',
      'x-assurapay-identity-assertion': assertion,
    };
  }, [session]);

  const run = useCallback(async (label: string, call: () => Promise<Response>, after?: (body: unknown) => void | Promise<void>) => {
    setOutcome({ kind: 'busy', message: `${label}…` });
    try {
      const response = await call();
      if (!response.ok) {
        setOutcome({ kind: 'error', message: `${label} refused: ${await failureOf(response)}` });
        return;
      }
      const body = await response.json().catch(() => null);
      await after?.(body);
      setOutcome({ kind: 'ok', message: `${label} succeeded.` });
    } catch (error) {
      setOutcome({
        kind: 'error',
        message: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, []);

  const refreshContracts = useCallback(async () => {
    if (!session?.activeWorkspaceId) return;
    try {
      const response = await fetch('/api/v1/contracts', {
        cache: 'no-store',
        headers: await assertionHeaders(),
      });
      if (!response.ok) {
        setContracts([]);
        return;
      }
      const body = (await response.json()) as Contract[] | { contracts?: Contract[] };
      setContracts(Array.isArray(body) ? body : (body.contracts ?? []));
    } catch {
      setContracts([]);
    }
  }, [assertionHeaders, session]);

  const grantContractAuthor = () => {
    if (!session?.userId) {
      setOutcome({ kind: 'error', message: 'Sign in and activate a workspace first.' });
      return;
    }
    void run(
      'Contract-author role assignment',
      async () =>
        fetch('/api/v1/roles/assignments', {
          method: 'POST',
          headers: await assertionHeaders(),
          body: JSON.stringify({ userId: session.userId, role: 'CONTRACT_AUTHOR' }),
        }),
      async () => {
        await refreshContracts();
      },
    );
  };

  const createContract = () => {
    void run(
      'Contract creation',
      async () =>
        fetch('/api/v1/contracts', {
          method: 'POST',
          headers: await assertionHeaders(),
          body: JSON.stringify({ contractNumber, title, contractType }),
        }),
      async () => {
        await refreshContracts();
        setContractNumber('');
        setTitle('');
      },
    );
  };

  const reviewIntelligence = (decision: 'ACCEPTED' | 'REJECTED') => {
    if (!intelligenceVersionId.trim() || !intelligenceItemId.trim()) {
      setOutcome({ kind: 'error', message: 'Intelligence version and item are required.' });
      return;
    }
    void run(`${decision === 'ACCEPTED' ? 'Accept' : 'Reject'} intelligence item`, async () =>
      fetch(`/api/v1/agreement-intelligence/${encodeURIComponent(intelligenceVersionId)}/publish`, {
        method: 'POST',
        headers: await assertionHeaders(),
        body: JSON.stringify({
          operation: 'REVIEW',
          itemId: intelligenceItemId,
          decision,
        }),
      }),
    );
  };

  const publishIntelligence = () => {
    if (!intelligenceVersionId.trim()) {
      setOutcome({ kind: 'error', message: 'Intelligence version is required.' });
      return;
    }
    void run('Publish agreement intelligence', async () =>
      fetch(`/api/v1/agreement-intelligence/${encodeURIComponent(intelligenceVersionId)}/publish`, {
        method: 'POST',
        headers: await assertionHeaders(),
        body: JSON.stringify({ operation: 'PUBLISH' }),
      }),
    );
  };

  return (
    <main className="shell" data-testid="agreement-console">
      <p className="eyebrow">RC1 Phase C</p>
      <h1>Agreement workspace</h1>
      <p className="lead">
        Governed contract authoring and human-reviewed agreement intelligence in the active workspace.
      </p>

      {!session?.activeWorkspaceId ? (
        <section className="card" data-testid="agreement-workspace-required">
          <h2>Active workspace required</h2>
          <p>Complete the bootstrap journey at /start, then return here.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>1. Authority</h2>
            <p>
              The workspace founder starts as an administrator. Contract authority is granted explicitly through
              the canonical role catalogue.
            </p>
            <button type="button" onClick={grantContractAuthor} data-testid="grant-contract-author">
              Assign Contract Author to me
            </button>
          </section>

          <section className="card">
            <h2>2. Create contract</h2>
            <label>
              Contract number
              <input
                data-testid="contract-number"
                value={contractNumber}
                onChange={(event) => setContractNumber(event.target.value)}
              />
            </label>
            <label>
              Title
              <input data-testid="contract-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              Contract type
              <input
                data-testid="contract-type"
                value={contractType}
                onChange={(event) => setContractType(event.target.value)}
              />
            </label>
            <button type="button" onClick={createContract} data-testid="create-contract">
              Create governed contract
            </button>
            <button type="button" onClick={() => void refreshContracts()} data-testid="refresh-contracts">
              Refresh contracts
            </button>
          </section>

          <section className="card">
            <h2>Contracts in this workspace</h2>
            {contracts.length === 0 ? (
              <p data-testid="no-contracts">No reachable contracts yet.</p>
            ) : (
              <ul data-testid="contract-list">
                {contracts.map((contract, index) => (
                  <li key={contract.id ?? `${contract.contractNumber ?? 'contract'}-${index}`} data-testid="contract-row">
                    <strong>{contract.contractNumber ?? '—'}</strong> — {contract.title ?? 'Untitled'}
                    {contract.id ? <code> {contract.id}</code> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>3. Human review before publication</h2>
            <p>
              Use the version and item identifiers produced by the canonical agreement-intelligence proposal flow.
              Publication still fails closed until every item has been reviewed and at least one item is accepted.
            </p>
            <label>
              Intelligence version ID
              <input
                data-testid="intelligence-version-id"
                value={intelligenceVersionId}
                onChange={(event) => setIntelligenceVersionId(event.target.value)}
              />
            </label>
            <label>
              Intelligence item ID
              <input
                data-testid="intelligence-item-id"
                value={intelligenceItemId}
                onChange={(event) => setIntelligenceItemId(event.target.value)}
              />
            </label>
            <button type="button" onClick={() => reviewIntelligence('ACCEPTED')} data-testid="accept-intelligence">
              Accept item
            </button>
            <button type="button" onClick={() => reviewIntelligence('REJECTED')} data-testid="reject-intelligence">
              Reject item
            </button>
            <button type="button" onClick={publishIntelligence} data-testid="publish-intelligence">
              Publish reviewed intelligence
            </button>
          </section>
        </>
      )}

      {outcome.kind !== 'idle' ? (
        <p data-testid={`agreement-outcome-${outcome.kind}`} role="status">
          {outcome.message}
        </p>
      ) : null}
    </main>
  );
}
