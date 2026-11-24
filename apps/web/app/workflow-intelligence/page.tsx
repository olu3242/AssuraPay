/**
 * Insights — the execution overview, without invented figures.
 *
 * This page used to display numbers: execution health 82, workflow progress 74%, SLA adherence 91%,
 * three active bottlenecks, and a predictive panel reading "Approval delay risk: 34%", "Late
 * completion risk: 21%", "Settlement readiness: 68%". None of them came from anywhere. They were
 * constants in the file, rendered identically for every visitor and every workspace, under a caption
 * reading "Advisory only · Human review required" that lent them the credibility of a computed
 * result.
 *
 * That is the same defect the landing page already recorded removing — "the cards presented invented
 * records as the state of the platform" — and it is worse here, because these figures are the kind a
 * delivery lead acts on. A fabricated "settlement readiness: 68%" in software that releases money is
 * not a cosmetic problem.
 *
 * So the figures are gone rather than restyled. What remains says what this section is for and names
 * the stages a journey passes through, which is true without needing data. Real figures require an
 * authenticated caller — a server component has none, so there is no tenant, no trust scope, and
 * forced row-level security correctly returns nothing. Serving them is the API's job under the
 * signed-in user's own scope, through a client component like the one `/start` already uses.
 *
 * The styling also moves onto the application's own `shell`, `card` and `eyebrow` classes. It was the
 * only page using Tailwind utilities directly, so it did not look like part of the same product.
 */

/** The stages a journey passes through, in order. True regardless of data. */
const STAGES = [
  'Agreement',
  'Plan',
  'Milestones',
  'Completion rules',
  'Evidence',
  'Acceptance',
  'Completion',
  'Payment',
] as const;

const SECTIONS = [
  {
    title: 'Delivery health',
    detail: 'How your agreements are tracking against their plans, once there are agreements to track.',
  },
  {
    title: 'Progress',
    detail: 'Work completed against the agreed baseline, measured per milestone.',
  },
  {
    title: 'Timeliness',
    detail: 'Where reviews, approvals and settlements are running against their agreed windows.',
  },
  {
    title: 'Blockers',
    detail: 'Work that has stopped moving, and what it is waiting on.',
  },
] as const;

export default function InsightsPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Insights</p>
      <h1>Execution overview</h1>
      <p className="lead">
        A read-only view for delivery and contract managers. Nothing here changes an agreement, a
        certification or a payment, and any recommendation waits for a person to decide.
      </p>

      <section className="grid">
        {SECTIONS.map((section) => (
          <article className="card" key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.detail}</p>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>How a journey runs</h2>
        <p className="lead">
          {STAGES.join(' → ')}
        </p>
        <p>
          Each stage completes only when the step before it has, and only on the strength of a record
          the platform holds rather than a declaration that it is done.
        </p>
      </section>
    </main>
  );
}
