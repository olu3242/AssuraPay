const stages = [
  'Performance Blueprint',
  'Scope Definition',
  'Deliverables',
  'Milestone Planning',
  'Definition of Done',
];
export default function BlueprintPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Executable agreement</p>
      <h1>Performance Blueprint</h1>
      <p className="lead">
        No execution begins until a complete, source-grounded operational
        blueprint is reviewed and published.
      </p>
      <section className="grid">
        {stages.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {21 + i}</span>
            <h2>{x}</h2>
            <p>
              Versioned, owned, measurable, evidenced and traceable to published
              Agreement Intelligence.
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
