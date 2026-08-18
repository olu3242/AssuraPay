import Link from 'next/link';

/**
 * The settlements section's entry point.
 *
 * It listed `snapshot.settlementCases` from `FileAssuraStore`, including each case's status and its
 * `netPayableAmountMinor` — payable amounts, rendered to an anonymous visitor from a global JSON file with no
 * tenancy. The records were fabricated, which is the only reason that was not a disclosure of one tenant's
 * money to another's.
 *
 * Settlement figures require an authenticated, workspace-scoped request. See `app/page.tsx` for why a server
 * component cannot make one.
 */
export default function SettlementsPage() {
  return (
    <main>
      <nav>
        <Link href="/">Dashboard</Link>
        <Link href="/execution">Execution</Link>
        <Link href="/settlements">Settlements</Link>
      </nav>
      <section className="card">
        <h1>Settlement assurance</h1>
        <p>Settlement cases are derived from certified milestones and assessed payment eligibility.</p>
      </section>
      <section className="grid">
        <div className="card">
          <h2>Eligibility before entitlement</h2>
          <p>A payment eligibility names the certificate and the trigger rule it rests on, and records every blocker that remains.</p>
        </div>
        <div className="card">
          <h2>Instruction, not custody</h2>
          <p>Money moves through a certified financial provider&rsquo;s own APIs. AssuraPay sends the instruction and never holds the funds.</p>
        </div>
      </section>
    </main>
  );
}
