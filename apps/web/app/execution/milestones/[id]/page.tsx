import Link from 'next/link';
import { getAssuraService } from '../../../../lib/assurapay-app';

export default async function MilestonePage({ params }: { params: { id: string } }) {
  const { store, service } = await getAssuraService();
  const assurance = await service.getAssuranceReadModel(params.id);
  const snapshot = await store.getSnapshot();
  const milestone = snapshot?.milestones?.find((entry: any) => entry.id === params.id);

  return (
    <main>
      <nav>
        <Link href="/">Dashboard</Link>
        <Link href="/execution">Execution</Link>
      </nav>
      <section className="card">
        <h1>{milestone?.title ?? 'Milestone'}</h1>
        <p>Status: {assurance.status}</p>
      </section>
      <section className="grid">
        <div className="card">
          <h2>Readiness</h2>
          <p>Score: {assurance.readiness.score}</p>
          <p>Blocking dependencies: {assurance.readiness.blockingDependencies}</p>
        </div>
        <div className="card">
          <h2>Evidence</h2>
          <p>{assurance.evidence.submitted}/{assurance.evidence.required} submitted</p>
          <p>Completeness: {assurance.evidence.completenessScore}%</p>
        </div>
        <div className="card">
          <h2>Payment eligibility</h2>
          <p>{assurance.paymentEligibility.status}</p>
        </div>
      </section>
    </main>
  );
}
