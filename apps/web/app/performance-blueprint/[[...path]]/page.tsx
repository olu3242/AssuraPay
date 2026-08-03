const engines = ['Performance blueprint', 'Scope definition', 'Deliverables', 'Milestone planning', 'Definition of done'];
export default function PerformanceBlueprintPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Performance blueprint</p>
      <h1>Agreement to executable plan</h1>
      <p className="lead">
        A published agreement intelligence version becomes a canonical blueprint only once its scope, deliverables,
        milestones and Definition of Done gates are confirmed and published.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {21 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and auditable from draft plan to activated blueprint.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
