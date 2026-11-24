/**
 * Insights — a section of the application, described in the user's language.
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
        { title: 'Execution health', detail: 'How delivery is tracking across your agreements.' },
        { title: 'Settlement health', detail: 'How reliably payments are being released and settled.' },
        { title: 'Measures', detail: 'The indicators your organisation has chosen to watch.' },
        { title: 'Overview', detail: 'A single view across agreements, milestones and payments.' },
        { title: 'Forecasts', detail: 'Where delivery looks likely to slip, for a human to review.' },
] as const;

export default function InsightsPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Insights</p>
      <h1>How execution and settlement are tracking</h1>
      <p className="lead">Everything here is read from records you already govern. Nothing in this view changes anything, and every forecast starts unreviewed.</p>
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
