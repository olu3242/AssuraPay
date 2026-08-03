const engines = ['Payment eligibility', 'Financial entitlement', 'Invoice & claim management', 'Escrow & funding assurance', 'Conditional release orchestration'];
export default function SettlementAssurancePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Settlement assurance</p>
      <h1>Certified work to a condition-met release request</h1>
      <p className="lead">
        AssuraPay never holds funds. Every reference here points to a licensed Financial Provider&apos;s own escrow —
        AssuraPay only records eligibility, entitlement and the conditions a release request must satisfy.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {41 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and non-custodial by construction.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
