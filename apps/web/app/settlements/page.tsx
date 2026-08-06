import { getAssuraService } from '../../lib/assurapay-app';

export default async function SettlementsPage() {
  const { store } = await getAssuraService();
  const snapshot = await store.getSnapshot();
  const settlementCases = snapshot.settlementCases ?? [];

  return (
    <main style={{ padding: '2rem', fontFamily: 'Inter, sans-serif' }}>
      <h1>Settlement Assurance</h1>
      <p>Tracked settlement cases derived from certified milestones and payment eligibility.</p>
      {settlementCases.length === 0 ? (
        <p>No settlement cases have been created yet.</p>
      ) : (
        <ul>
          {settlementCases.map((caseItem: any) => (
            <li key={caseItem.id}>
              <strong>{caseItem.id}</strong> — {caseItem.status} · NGN {caseItem.netPayableAmountMinor}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
