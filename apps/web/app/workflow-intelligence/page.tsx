const cards = [
  [
    'Execution health',
    '82',
    'Healthy',
    'Milestones, DoD, evidence, validation, approvals, settlement and risk',
  ],
  [
    'Workflow progress',
    '74%',
    'On plan',
    'Canonical execution graph and stalled-work monitoring',
  ],
  [
    'SLA adherence',
    '91%',
    '2 watched',
    'Contract, milestone, review, approval and settlement windows',
  ],
  [
    'Active bottlenecks',
    '3',
    'Advisory',
    'Evidence shortage, review queues and validation failures',
  ],
];
export default function WorkflowIntelligencePage() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <p className="text-sm font-semibold uppercase tracking-[.25em] text-cyan-400">
          Execution Intelligence
        </p>
        <h1 className="mt-3 text-4xl font-semibold">Workflow command center</h1>
        <p className="mt-3 max-w-3xl text-slate-400">
          A governed, read-only view for project managers, contract managers,
          delivery leads and executives. Recommendations never change protected
          execution or payment state.
        </p>
        <section className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cards.map(([title, value, status, detail]) => (
            <article
              key={title}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
            >
              <p className="text-sm text-slate-400">{title}</p>
              <p className="mt-3 text-3xl font-semibold">{value}</p>
              <p className="mt-2 text-sm text-cyan-300">{status}</p>
              <p className="mt-4 text-sm leading-6 text-slate-500">{detail}</p>
            </article>
          ))}
        </section>
        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-xl font-semibold">
              Execution timeline & workflow graph
            </h2>
            <div className="mt-6 flex items-center gap-2 text-xs">
              {[
                'Agreement',
                'Blueprint',
                'Milestones',
                'DoD',
                'Evidence',
                'Validation',
                'Completion',
                'Settlement',
              ].map((item, index) => (
                <div key={item} className="flex flex-1 items-center gap-2">
                  <span className="rounded-full bg-cyan-500/15 px-2 py-2 text-cyan-300">
                    {item}
                  </span>
                  {index < 7 && <span className="text-slate-600">→</span>}
                </div>
              ))}
            </div>
          </article>
          <article className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-xl font-semibold">Predictive insights</h2>
            <ul className="mt-5 space-y-3 text-sm text-slate-300">
              <li>Approval delay risk: 34% — monitor reviewer capacity.</li>
              <li>
                Late completion risk: 21% — current critical path remains
                feasible.
              </li>
              <li>
                Settlement readiness: 68% — one funding confirmation remains
                outstanding.
              </li>
            </ul>
            <p className="mt-6 text-xs text-amber-300">
              Advisory only · Human review required
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
