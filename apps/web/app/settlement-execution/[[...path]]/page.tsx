const engines = ['Financial approval & authority', 'Payment execution & treasury integration', 'Reconciliation & financial ledger', 'Dispute, claim & appeal resolution', 'Final settlement & financial closure'];
export default function SettlementExecutionPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Settlement execution</p>
      <h1>Dual-approved release to a certified financial closure</h1>
      <p className="lead">
        A payment instruction only ever reflects what the licensed Financial Provider itself reports. AssuraPay
        never submits a payment without independent dual approval, and never asserts settlement on its own say-so.
      </p>
      <section className="grid">
        {engines.map((x, i) => (
          <article className="card" key={x}>
            <span>Engine {46 + i}</span>
            <h2>{x}</h2>
            <p>Workspace scoped, versioned, gated and non-custodial by construction.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
