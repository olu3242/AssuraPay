/**
 * Delivery plan — a section of the application, described in the user's language.
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
        { title: 'The plan', detail: 'The agreed shape of the work, versioned and approved before anyone starts.' },
        { title: 'Scope', detail: 'What is included, and just as importantly what is not.' },
        { title: 'Deliverables', detail: 'What has to be handed over, and by whom.' },
        { title: 'Milestones', detail: 'The points where work is checked and payment can become due.' },
        { title: 'Completion rules', detail: 'What has to be true before a milestone counts as done.' },
] as const;

export default function DeliveryPlanPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Delivery plan</p>
      <h1>Turn the agreement into a plan you can run</h1>
      <p className="lead">An accepted reading of the agreement becomes a plan once its scope, deliverables, milestones and completion rules are confirmed.</p>
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
