import Link from 'next/link';
import { HeroCarousel } from './components/hero-carousel';

/**
 * The landing page.
 *
 * It used to read a contract title, a milestone title and a certificate number out of `FileAssuraStore` and
 * render them as "Active agreement", "Active milestone" and "Certificate". Those values came from
 * `createSeedScenario` — fabricated demo data — in every environment where the page rendered at all, so the
 * cards presented invented records as the state of the platform.
 *
 * They are not re-pointed at the durable store, because a server component has no authenticated caller. There
 * is no identity, so no tenant, so no trust scope, and forced row-level security correctly returns nothing.
 * The only reason the old version showed anything is that the JSON file had no tenancy at all — and a page
 * that showed one tenant's contract title to an anonymous visitor was a cross-tenant disclosure that the
 * absence of tenancy made invisible rather than safe.
 *
 * So the cards state what the platform does and link into the authenticated application, which is where
 * tenant data belongs. Real figures for a signed-in user are the API's to serve, under that user's scope.
 */
export default function HomePage() {
  return (
    <main>
      <nav>
        <Link href="/">Dashboard</Link>
        <Link href="/execution">Execution</Link>
        <Link href="/settlements">Settlements</Link>
      </nav>
      <section className="hero">
        <div className="hero__content">
          <span className="hero__eyebrow">Execution assurance, built in</span>
          <h1>Turn every agreement into confident execution.</h1>
          <p>Connect contract approval, milestones, evidence, validation, certification and payment eligibility in one trusted workflow.</p>
          <div className="hero__actions">
            <Link className="button button--primary" href="/execution">View execution</Link>
            <Link className="button button--secondary" href="/settlements">View settlements</Link>
          </div>
        </div>
        <HeroCarousel />
      </section>
      <section className="grid">
        <div className="card">
          <h2>Certified work, then payment</h2>
          <p>A release requires a completion certificate, an approved entitlement and confirmed funding — never an unconditional instruction.</p>
        </div>
        <div className="card">
          <h2>Evidence that holds</h2>
          <p>Every state change is append-only and timestamped, so the record of how a milestone was certified survives the milestone.</p>
        </div>
        <div className="card">
          <h2>No custody, ever</h2>
          <p>Funds stay with a licensed financial provider. AssuraPay sends hold and release instructions and never holds money.</p>
        </div>
      </section>
    </main>
  );
}
