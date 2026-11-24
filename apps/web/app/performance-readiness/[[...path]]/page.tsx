/**
 * Milestone readiness — a section of the application, described in the user's language.
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
        { title: 'Acceptance criteria', detail: 'The specific conditions the work has to meet to be accepted.' },
        { title: 'Measures', detail: 'How success is measured, agreed before the work starts.' },
        { title: 'Dependencies', detail: 'What has to finish first, and what is still outstanding.' },
        { title: 'Payment trigger', detail: 'The milestone that releases payment once it is certified.' },
        { title: 'Baseline', detail: 'The agreed starting point, locked so later progress can be measured against it.' },
] as const;

export default function MilestoneReadinessPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Milestone readiness</p>
      <h1>Is this milestone ready to be paid against?</h1>
      <p className="lead">Confirmed acceptance criteria, agreed measures, cleared dependencies and a locked baseline decide whether a milestone can trigger payment.</p>
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
