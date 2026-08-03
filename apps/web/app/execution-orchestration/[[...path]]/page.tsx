const engines = ['Execution orchestration', 'Progress measurement', 'Evidence management', 'Validation & acceptance testing', 'Quality assurance'];
export default function ExecutionOrchestrationPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Execution orchestration</p>
      <h1>From activated blueprint to financially earned progress</h1>
      <p className="lead">
        Assigned work items carry evidence, acceptance testing and a clean quality gate before progress can be
        declared financially earned.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {31 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and auditable through the execution lifecycle.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
