'use client';

import { useCallback, useEffect, useState } from 'react';

type Session = { userId: string; activeWorkspaceId?: string };
type Result = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

async function failureOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `${response.status} ${response.statusText}`;
}

export function PerformanceEngineConsole() {
  const [session, setSession] = useState<Session | null>(null);
  const [contractId, setContractId] = useState('');
  const [contractVersionId, setContractVersionId] = useState('');
  const [agreementIntelligenceVersionId, setAgreementIntelligenceVersionId] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [blueprintId, setBlueprintId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');

  useEffect(() => {
    void fetch('/api/v1/auth/session', { cache: 'no-store' }).then(async (response) => {
      if (response.ok) setSession((await response.json()) as Session);
    });
  }, []);

  const headers = useCallback(async (): Promise<HeadersInit> => {
    const response = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session?.activeWorkspaceId ? { workspaceId: session.activeWorkspaceId } : {}),
    });
    if (!response.ok) throw new Error(await failureOf(response));
    const { assertion } = (await response.json()) as { assertion: string };
    return { 'content-type': 'application/json', 'x-assurapay-identity-assertion': assertion };
  }, [session?.activeWorkspaceId]);

  const post = useCallback(
    async (path: string, body: unknown) => {
      const response = await fetch(path, { method: 'POST', headers: await headers(), body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${path}: ${await failureOf(response)}`);
      return await response.json();
    },
    [headers],
  );

  const enablePlanner = async () => {
    if (!session?.userId) return setResult({ kind: 'error', message: 'Sign in and activate a workspace first.' });
    setResult({ kind: 'busy' });
    try {
      await post('/api/v1/roles/assignments', { userId: session.userId, role: 'PERFORMANCE_PLANNER' });
      setResult({ kind: 'ok', message: 'Performance planner authority enabled.' });
    } catch (error) {
      setResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const buildEngine = async () => {
    if (!session?.userId || !session.activeWorkspaceId)
      return setResult({ kind: 'error', message: 'An active workspace is required.' });
    if (!contractId || !contractVersionId || !agreementIntelligenceVersionId)
      return setResult({ kind: 'error', message: 'Contract, executed version, and published intelligence IDs are required.' });

    setResult({ kind: 'busy' });
    try {
      const blueprint = (await post('/api/v1/performance-blueprints', {
        contractId,
        contractVersionId,
        agreementIntelligenceVersionId,
      })) as { id: string; status: string };

      const scope = (await post('/api/v1/scope-items', {
        blueprintId: blueprint.id,
        kind: 'INCLUDED',
        description: 'Deliver the agreed commercial outcome.',
        assumptions: [],
        constraints: [],
        ownerId: session.userId,
      })) as { id: string };
      await post(`/api/v1/scope-items/${encodeURIComponent(scope.id)}/confirm`, {});

      const deliverable = (await post('/api/v1/deliverables', {
        blueprintId: blueprint.id,
        scopeItemId: scope.id,
        title: 'Primary contractual deliverable',
        quantity: 1,
        unit: 'outcome',
        qualityStandard: 'Conforms to the published agreement and acceptance criteria.',
        ownerId: session.userId,
        dueDate: '2026-09-10T00:00:00.000Z',
        acceptanceCriteria: ['Contractual outcome is complete and reviewable'],
        evidenceRequirements: ['Completion evidence package'],
      })) as { id: string };
      await post(`/api/v1/deliverables/${encodeURIComponent(deliverable.id)}/confirm`, {});

      const milestone = (await post('/api/v1/blueprint-milestones', {
        blueprintId: blueprint.id,
        title: 'Primary delivery milestone',
        deliverableIds: [deliverable.id],
        startDate: '2026-09-01T00:00:00.000Z',
        dueDate: '2026-09-10T00:00:00.000Z',
        budgetAmountMinor: 100000,
        currency: 'USD',
        valueAllocationPercent: 100,
      })) as { id: string };

      const dod = (await post('/api/v1/definition-of-done-packages', {
        milestoneId: milestone.id,
        deliverableGateIds: [deliverable.id],
        criteria: [
          {
            key: 'contractual-completion',
            description: 'The agreed deliverable is complete and supported by evidence.',
            mandatory: true,
            evaluationType: 'MANUAL',
          },
        ],
        evidenceRequirements: ['Completion evidence package'],
        qualityGate: true,
        complianceGate: true,
        riskGate: true,
        paymentGate: true,
      })) as { id: string };
      await post(`/api/v1/definition-of-done-packages/${encodeURIComponent(dod.id)}/publish`, {});

      const activated = (await post(`/api/v1/performance-blueprints/${encodeURIComponent(blueprint.id)}/activate`, {})) as {
        id: string;
        status: string;
      };
      setBlueprintId(activated.id);
      setMilestoneId(milestone.id);
      setResult({ kind: 'ok', message: `Performance engine active: ${activated.status}` });
    } catch (error) {
      setResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <main className="shell" data-testid="performance-engine-console">
      <p className="eyebrow">Execution assurance</p>
      <h1>Performance Blueprint Engine</h1>
      <p className="lead">
        Turns a governed agreement into confirmed scope, deliverables, milestones, Definition of Done, and an active execution blueprint.
      </p>

      {!session?.activeWorkspaceId ? (
        <section className="card"><p data-testid="performance-no-context">Sign in at /start and activate a workspace first.</p></section>
      ) : (
        <>
          <section className="card">
            <h2>1. Authority</h2>
            <button data-testid="enable-performance-planner" onClick={enablePlanner}>Enable performance planner role</button>
          </section>
          <section className="card">
            <h2>2. Governed agreement prerequisites</h2>
            <label>Contract ID<input data-testid="performance-contract-id" value={contractId} onChange={(e) => setContractId(e.target.value)} /></label>
            <label>Executed contract version ID<input data-testid="performance-contract-version-id" value={contractVersionId} onChange={(e) => setContractVersionId(e.target.value)} /></label>
            <label>Published agreement intelligence version ID<input data-testid="performance-intelligence-id" value={agreementIntelligenceVersionId} onChange={(e) => setAgreementIntelligenceVersionId(e.target.value)} /></label>
            <button data-testid="build-performance-engine" onClick={buildEngine}>Build and activate performance engine</button>
          </section>
        </>
      )}

      {result.kind !== 'idle' && (
        <section className="card" data-testid={result.kind === 'error' ? 'performance-error' : 'performance-result'}>
          <p>{result.kind === 'busy' ? 'Working…' : result.message}</p>
          {blueprintId && <p data-testid="performance-blueprint-id">Blueprint: {blueprintId}</p>}
          {milestoneId && <p data-testid="performance-milestone-id">Milestone: {milestoneId}</p>}
        </section>
      )}
    </main>
  );
}
