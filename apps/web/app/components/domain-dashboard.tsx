'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Snapshot = Record<string, any[]>;

export function useDomainSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    fetch('/api/v1/dashboard', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to view this workspace.' : 'Workspace data is unavailable.');
        return await response.json() as Snapshot;
      })
      .then(setSnapshot)
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : 'Workspace data is unavailable.'));
  }, []);
  return { snapshot, failure };
}

export function DomainDashboard() {
  const { snapshot, failure } = useDomainSnapshot();
  if (failure) return <main><p role="alert">{failure}</p><Link href="/auth/login">Sign in</Link></main>;
  if (!snapshot) return <main><p role="status">Loading workspace…</p></main>;
  const milestone = snapshot.milestones?.[0];
  const contract = snapshot.contracts?.[0];
  const certificate = snapshot.certificates?.[0];
  return <main>
    <nav><Link href="/">Dashboard</Link><Link href="/execution">Execution</Link><Link href={milestone ? `/execution/milestones/${milestone.id}` : '/execution'}>Milestone</Link></nav>
    <section className="hero"><div className="hero__content"><span className="hero__eyebrow">Execution assurance, built in</span><h1>Turn every agreement into confident execution.</h1><p>Connect contract approval, milestones, evidence, validation, certification and payment eligibility in one trusted workflow.</p></div></section>
    <section className="grid"><div className="card"><h2>Active agreement</h2><p>{contract?.title ?? 'No contract'}</p></div><div className="card"><h2>Active milestone</h2><p>{milestone?.title ?? 'No milestone'}</p></div><div className="card"><h2>Certificate</h2><p>{certificate?.certificateNumber ?? 'Pending'}</p></div></section>
  </main>;
}
