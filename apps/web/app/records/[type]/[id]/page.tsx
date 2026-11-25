import { notFound } from 'next/navigation';
import { RecordView } from '../../../components/record-view';
import { recordType } from '../../../../lib/record-reads';

/**
 * A record page, for any type in the canonical chain.
 *
 * ## Why one page rather than seventeen
 *
 * The API deliberately has seventeen record routes, because `ROUTE_PERMISSION_REQUIREMENTS` is keyed
 * by path and one generic route would collapse seventeen read authorities into one. None of that
 * applies to a *page*: a page grants nothing. Authority is decided by the route it reads, which
 * refuses independently of what is rendered — the property `browser-persona-workspace-e2e` exists to
 * assert. So the screens share one implementation, and a reader navigating the chain from a contract
 * to a payment instruction stays in the same interface instead of meeting seventeen dialects of it.
 *
 * An unknown type is a 404 from the server rather than an empty shell, so a mistyped link fails
 * visibly instead of looking like a record with nothing in it.
 */
export default function RecordPage({ params }: { params: { type: string; id: string } }) {
  const definition = recordType(params.type);
  if (!definition) notFound();

  return (
    <main className="shell">
      <p className="eyebrow">{definition.title}</p>
      <h1>{definition.title}</h1>
      <p className="lead">
        This record as the platform holds it, what it is attached to in both directions, and the
        append-only history of every transition recorded against it.
      </p>
      <RecordView type={definition.id} id={params.id} />
    </main>
  );
}
