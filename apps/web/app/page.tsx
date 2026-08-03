import Link from 'next/link';
import { getAssuraService } from '../lib/assurapay-app';
import { HeroCarousel } from './components/hero-carousel';

export default async function HomePage() {
  const { store, service } = await getAssuraService();
  const snapshot = store.getSnapshot();
  const milestone = snapshot?.milestones?.[0];
  const contract = snapshot?.contracts?.[0];
  const certificate = snapshot?.certificates?.[0];

  return (
    <main>
      <nav>
        <Link href="/">Dashboard</Link>
        <Link href="/execution">Execution</Link>
        <Link href={milestone ? `/execution/milestones/${milestone.id}` : '/execution'}>Milestone</Link>
      </nav>
      <section className="hero">
        <div className="hero__content">
          <span className="hero__eyebrow">Execution assurance, built in</span>
          <h1>Turn every agreement into confident execution.</h1>
          <p>Connect contract approval, milestones, evidence, validation, certification and payment eligibility in one trusted workflow.</p>
          <div className="hero__actions">
            <Link className="button button--primary" href="/execution">View execution</Link>
            <Link className="button button--secondary" href={milestone ? `/execution/milestones/${milestone.id}` : '/execution'}>Review milestone</Link>
          </div>
        </div>
        <HeroCarousel />
      </section>
      <section className="grid">
        <div className="card">
          <h2>Active agreement</h2>
          <p>{contract?.title ?? 'No contract'}</p>
        </div>
        <div className="card">
          <h2>Active milestone</h2>
          <p>{milestone?.title ?? 'No milestone'}</p>
        </div>
        <div className="card">
          <h2>Certificate</h2>
          <p>{certificate?.certificateNumber ?? 'Pending'}</p>
        </div>
      </section>
    </main>
  );
}
