/**
 * Agreement review — a section of the application, described in the user's language.
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
        { title: 'Analysis', detail: 'See what the document says about payment, delivery and obligations, with the clause each point came from.' },
        { title: 'Risk findings', detail: 'Points worth a second look, each citing where in the document it came from.' },
        { title: 'Fixed versions', detail: 'An accepted reading is locked. A new reading supersedes it rather than overwriting it.' },
        { title: 'Document store', detail: 'The signed document, held once and referenced everywhere else.' },
        { title: 'Structured terms', detail: 'Parties, obligations, milestones and payment triggers, as structured records.' },
] as const;

export default function AgreementReviewPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Agreement review</p>
      <h1>What the agreement actually commits you to</h1>
      <p className="lead">A reading of a signed agreement stays advisory until someone with authority accepts it. Once accepted it is fixed and cannot be edited.</p>
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
