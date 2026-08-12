'use client';

import Link from 'next/link';
import { useDomainSnapshot } from '../../../components/domain-dashboard';

export default function MilestonePage({ params }: { params: { id: string } }) {
  const { snapshot, failure } = useDomainSnapshot();
  if (failure) return <main><p role="alert">{failure}</p></main>;
  if (!snapshot) return <main><p role="status">Loading milestone…</p></main>;
  const milestone = snapshot.milestones?.find((entry) => entry.id === params.id);
  const evidence = snapshot.evidenceItems?.filter((entry) => entry.milestoneId === params.id) ?? [];
  const eligibility = snapshot.paymentEligibility?.find((entry) => entry.milestoneId === params.id);
  return <main><nav><Link href="/">Dashboard</Link><Link href="/execution">Execution</Link></nav>
    <section className="card"><h1>{milestone?.title ?? 'Milestone'}</h1><p>Status: {milestone?.status ?? 'Not found'}</p></section>
    <section className="grid"><div className="card"><h2>Evidence</h2><p>{evidence.length} submitted</p></div><div className="card"><h2>Payment eligibility</h2><p>{eligibility?.status ?? 'PENDING'}</p></div></section>
  </main>;
}
