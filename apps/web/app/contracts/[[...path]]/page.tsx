/**
 * Agreements — a section of the application, described in the user's language.
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
        { title: 'Draft authoring', detail: 'Write and revise an agreement, with every version kept.' },
        { title: 'Clause review', detail: 'Review the terms clause by clause and leave a record of what changed.' },
        { title: 'Negotiation', detail: 'Exchange positions with the other side without losing the history.' },
        { title: 'Approval routing', detail: 'Send the draft to whoever has to approve it before it can be signed.' },
        { title: 'Digital execution', detail: 'Sign the approved document. Nothing else can be signed in its place.' },
] as const;

export default function ContractsPage({ params }: { params: { path?: string[] } }) {
  return (
    <main className="shell">
      <p className="eyebrow">Agreements</p>
      <h1>{params.path?.length ? 'Agreement' : 'Agreements'}</h1>
      <p className="lead">Draft, review, negotiate and sign an agreement. Only the exact approved document can be signed.</p>
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
