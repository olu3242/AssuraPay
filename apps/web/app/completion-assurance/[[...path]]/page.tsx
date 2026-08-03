const engines = ['Inspection & field verification', 'Issue, risk & corrective action', 'Change control', 'Acceptance & decision', 'Completion certification'];
export default function CompletionAssurancePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Completion assurance</p>
      <h1>From field verification to a certified completion</h1>
      <p className="lead">
        A completion certificate is unreachable until inspection has passed, every blocking issue is resolved and an
        active acceptance decision is on record.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {36 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and auditable through to certification.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
