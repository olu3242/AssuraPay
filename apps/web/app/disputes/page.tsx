import { DisputeRegister } from '../components/dispute-register';

/**
 * Disputes.
 *
 * The dispute register, for the persona that handles contested execution. It reads
 * `GET /api/v1/disputes`, which is gated on `disputes:read` — so this page shows the caller their
 * workspace's cases, or says plainly that they may not see them, and never an empty list standing in for a
 * refusal.
 *
 * A dispute is where money stops: a hold placed here blocks release, which is why the dispute manager holds
 * no certification, release or payment key. The decision and its financial consequence stay separate
 * principals.
 */
export default function DisputesPage() {
  return (
    <main className="shell" data-persona="disputes">
      <p className="eyebrow">Disputes</p>
      <h1>Contested execution</h1>
      <p className="lead">
        Cases raised against delivery or payment, with the positions and evidence each side has put forward.
        A dispute can hold a release, so what is recorded here decides whether money moves.
      </p>
      <DisputeRegister />
    </main>
  );
}
