/**
 * Portfolio — a section of the application, described in the user's language.
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
        { title: 'Payment patterns', detail: 'How money has moved across the portfolio over time.' },
        { title: 'Counterparty performance', detail: 'How reliably each party has delivered and been paid.' },
        { title: 'Portfolio view', detail: 'Exposure and concentration across everything in flight.' },
        { title: 'Renewals', detail: 'Agreements coming to an end, and the relationship behind each.' },
        { title: 'Recommendations', detail: 'Suggested actions, each pending a human decision.' },
] as const;

export default function PortfolioPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Portfolio</p>
      <h1>Patterns across agreements and counterparties</h1>
      <p className="lead">Every model behind these figures is registered and monitored. A recommendation is never acted on by itself — it waits for a person to decide.</p>
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
