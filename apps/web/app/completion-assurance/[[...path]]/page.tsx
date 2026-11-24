/**
 * Completion — a section of the application, described in the user's language.
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
        { title: 'Inspection', detail: 'What was checked on site, by whom, and what they found.' },
        { title: 'Issues', detail: 'Problems raised, their severity, and the corrective action taken.' },
        { title: 'Changes', detail: 'Variations to the agreed work, and who approved each one.' },
        { title: 'Acceptance', detail: 'The decision that the work meets what was agreed.' },
        { title: 'Certificate', detail: 'The record that completion happened, which payment later depends on.' },
] as const;

export default function CompletionPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Completion</p>
      <h1>Certify that the work is finished</h1>
      <p className="lead">A completion certificate is out of reach until inspection has passed, every blocking issue is resolved and an acceptance decision is on record.</p>
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
