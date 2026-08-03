const engines = ['Acceptance criteria', 'Success metrics', 'Dependency intelligence', 'Payment trigger', 'Performance baseline'];
export default function PerformanceReadinessPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Performance readiness</p>
      <h1>Measurable, gated milestone readiness</h1>
      <p className="lead">
        Confirmed acceptance criteria, weighted success metrics, cleared dependencies and a locked baseline determine
        whether a milestone&apos;s payment trigger is eligible to fire.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {26 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and auditable ahead of payment eligibility.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
