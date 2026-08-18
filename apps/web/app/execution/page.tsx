import Link from 'next/link';

/**
 * The execution section's entry point.
 *
 * It counted `snapshot.milestones`, `snapshot.evidenceItems` and `snapshot.certificates` out of
 * `FileAssuraStore` and rendered the three numbers as the workspace's state. Every one came from
 * `createSeedScenario`, so the counts described fabricated records, and the "Open milestone" link pointed at
 * whichever demo milestone happened to be first in the file.
 *
 * A server component has no authenticated caller, so it has no tenant and forced row-level security returns
 * nothing — counts like these belong to a signed-in request, under that request's scope. See `app/page.tsx`
 * for the same reasoning stated once in full.
 */
export default function ExecutionPage() {
  return (
    <main>
      <nav>
        <Link href="/">Dashboard</Link>
        <Link href="/execution">Execution</Link>
        <Link href="/settlements">Settlements</Link>
      </nav>
      <section className="card">
        <h1>Execution workspace</h1>
        <p>Operational milestones, evidence, validation and certification.</p>
      </section>
      <section className="grid">
        <div className="card">
          <h2>Milestones</h2>
          <p>Planned against a performance blueprint, each with a definition of done that must be evaluated before it can be certified.</p>
        </div>
        <div className="card">
          <h2>Evidence</h2>
          <p>Submitted against a deliverable and verified with a chain of custody, so a certificate can name what it rests on.</p>
        </div>
        <div className="card">
          <h2>Certification</h2>
          <p>Issued from an acceptance decision and carrying a canonical hash, which is what makes it verifiable later.</p>
        </div>
      </section>
    </main>
  );
}
