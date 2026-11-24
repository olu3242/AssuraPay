/**
 * Payments — a section of the application, described in the user's language.
 *
 * This page used to render the engine catalogue: five cards each labelled `Engine {n}` with an
 * internal capability name and a line of boilerplate about workspace scoping and versioning. That
 * told a customer which part of the codebase they were looking at, which is not something they have
 * any use for, and made the product read as a list of features rather than as software.
 *
 * The engine numbers and the boilerplate are gone. The cards now say what a person can see or do
 * here. The engine catalogue still exists, in `docs/ENGINE_CATALOG.md`, where it belongs.
 */

const SECTIONS = [
        { title: 'Approval', detail: 'The two independent approvals a release needs, and who gave them.' },
        { title: 'Release', detail: 'Instructions sent to the provider, and what the provider reported back.' },
        { title: 'Reconciliation', detail: 'Matching what was instructed against what actually settled.' },
        { title: 'Disputes', detail: 'Claims and appeals raised against a payment, and where each stands.' },
        { title: 'Closure', detail: 'The final account for the agreement, once everything has settled.' },
] as const;

export default function PaymentsPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Payments</p>
      <h1>Release, reconcile and close out</h1>
      <p className="lead">A payment instruction only ever reflects what the licensed financial provider reports. No payment is submitted without two independent approvals.</p>
      <section className="grid">
        {SECTIONS.map((section) => (
          <article className="card" key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.detail}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
