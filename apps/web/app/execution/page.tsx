'use client';

import Link from 'next/link';
import { useDomainSnapshot } from '../components/domain-dashboard';

export default function ExecutionPage() {
  const { snapshot, failure } = useDomainSnapshot();
  if (failure) return <main><p role="alert">{failure}</p></main>;
  if (!snapshot) return <main><p role="status">Loading workspace…</p></main>;
  const milestone = snapshot.milestones?.[0];
  return <main><nav><Link href="/">Dashboard</Link><Link href="/execution">Execution</Link></nav>
    <section className="card"><h1>Execution workspace</h1><p>Operational milestones, evidence, validation and certification.</p></section>
    <section className="grid"><div className="card"><h2>Active milestones</h2><p>{snapshot.milestones?.length ?? 0}</p></div><div className="card"><h2>Evidence items</h2><p>{snapshot.evidenceItems?.length ?? 0}</p></div><div className="card"><h2>Certified milestones</h2><p>{snapshot.certificates?.length ?? 0}</p></div></section>
    <section className="card"><h2>Milestone workspace</h2><Link href={milestone ? `/execution/milestones/${milestone.id}` : '/execution'}>Open milestone</Link></section>
  </main>;
}
