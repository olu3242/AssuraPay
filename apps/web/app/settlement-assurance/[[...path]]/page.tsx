/**
 * Payment eligibility — a section of the application, described in the user's language.
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
        { title: 'Eligibility', detail: 'Whether certified work has made a payment due.' },
        { title: 'Entitlement', detail: 'The approved amount owed, and what it is owed for.' },
        { title: 'Invoices and claims', detail: 'What has been claimed against the agreement, and its status.' },
        { title: 'Funding', detail: 'Confirmation from the provider that the money is there, held by them.' },
        { title: 'Release conditions', detail: 'Everything a release request still has to satisfy.' },
] as const;

export default function PaymentEligibilityPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Payment eligibility</p>
      <h1>What has to be true before money can move</h1>
      <p className="lead">AssuraPay never holds funds. Money sits with a licensed financial provider; this records whether the conditions for releasing it have been met.</p>
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
