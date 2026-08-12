'use client';

import { useDomainSnapshot } from '../components/domain-dashboard';

export default function SettlementsPage() {
  const { snapshot, failure } = useDomainSnapshot();
  if (failure) return <main><p role="alert">{failure}</p></main>;
  if (!snapshot) return <main><p role="status">Loading settlements…</p></main>;
  return <main style={{ padding: '2rem', fontFamily: 'Inter, sans-serif' }}><h1>Settlement Assurance</h1><p>Tracked settlement cases derived from certified milestones and payment eligibility.</p>
    {snapshot.settlementCases?.length ? <ul>{snapshot.settlementCases.map((item) => <li key={item.id}><strong>{item.id}</strong> — {item.status} · {item.currency ?? 'NGN'} {item.netPayableAmountMinor}</li>)}</ul> : <p>No settlement cases have been created yet.</p>}
  </main>;
}
