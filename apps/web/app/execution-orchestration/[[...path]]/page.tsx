/**
 * Delivery — a section of the application, described in the user's language.
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
        { title: 'Work items', detail: 'Who is doing what, and where each piece stands.' },
        { title: 'Progress', detail: 'How much is done, measured against the agreed baseline.' },
        { title: 'Evidence', detail: 'Photographs, documents and records proving the work was done.' },
        { title: 'Testing', detail: 'Acceptance tests and their results, kept with the work they cover.' },
        { title: 'Quality checks', detail: 'Open quality issues that have to clear before progress counts.' },
] as const;

export default function DeliveryPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Delivery</p>
      <h1>Track the work as it is done</h1>
      <p className="lead">Work carries its evidence, its testing and a quality check before any progress counts towards payment.</p>
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
