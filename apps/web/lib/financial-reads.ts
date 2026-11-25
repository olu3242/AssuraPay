import { trustStore, workspaceScoped } from './trust-app';
import type { RequestContext } from '@assurapay/shared';

/**
 * The financial read surface.
 *
 * The platform had 165 write routes and one financial read route, so a record could be created and
 * never looked at again over HTTP. No screen could show a commitment, a reservation, an entitlement,
 * a ledger or a settlement, which is why every financial page in the application was static text.
 * This module is the projection layer those pages read.
 *
 * ## It is a position, not a balance
 *
 * AssuraPay takes no custody, so it has no balance to report. What it can report is its own record of
 * what a provider confirmed holding, what has been reserved against that, what has been requested for
 * release and what the provider has reported settling. Calling that a "balance" would imply custody
 * the platform does not have, which is wrong in the API and a misstatement in a regulated context —
 * so the aggregate below is a `FinancialPosition`, every figure says which rows it came from, and the
 * provider's own numbers appear only where a reconciliation record supplies them.
 *
 * Nothing here is derived from anything but rows. There is no forecast, no projection and no
 * "expected" figure, because a number a reader cannot trace to records is indistinguishable from an
 * invented one.
 *
 * ## Per currency, never summed across currencies
 *
 * Money is integer minor units and a currency is not a formatting detail: adding kobo to cents
 * produces a number that is true of nothing. Every total is therefore reported per currency, and the
 * API returns a list of positions rather than one. `MONETARY_INVARIANTS.md` requires the same of the
 * database, where the journal balances per currency.
 *
 * ## Pagination bounds the response, not the query
 *
 * `TrustPersistence.list` reads a whole collection; the port has no cursor. So `page` below slices
 * what was already read. That caps the payload and makes the API stable for a client, and it is
 * honest to say it does not reduce the database's work. Pushing the page into SQL means giving the
 * port a query language, which is a change to every engine and not something to do inside a read
 * surface.
 */

/** The largest page a caller may request, and the default when none is given. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export type Page<T> = {
  items: T[];
  /** Pass as `cursor` to continue. Absent when this is the last page. */
  nextCursor?: string;
  /** How many rows the workspace holds, so a caller knows a page is partial. */
  total: number;
};

type Identified = { id: string; createdAt?: string; recordedAt?: string; calculatedAt?: string };

/** Stable order: oldest first, with `id` breaking ties so a cursor can never skip or repeat a row. */
function ordered<T extends Identified>(rows: T[]): T[] {
  const stamp = (row: T) => row.createdAt ?? row.recordedAt ?? row.calculatedAt ?? '';
  return [...rows].sort((left, right) => {
    const byTime = stamp(left).localeCompare(stamp(right));
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

export function pageParameters(url: string): { limit: number; cursor?: string } {
  const parameters = new URL(url).searchParams;
  const requested = Number(parameters.get('limit') ?? DEFAULT_LIMIT);
  // A caller asking for everything gets the cap rather than everything, and a nonsense limit gets the
  // default rather than an error: a read surface that 400s on `?limit=abc` is harder to use and no
  // safer, because the cap is what protects the response either way.
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;
  return { limit, cursor: parameters.get('cursor') ?? undefined };
}

export function page<T extends Identified>(rows: T[], { limit, cursor }: { limit: number; cursor?: string }): Page<T> {
  const sorted = ordered(rows);
  // The cursor is the last id of the previous page. An unknown cursor starts from the beginning
  // rather than erroring, because the row it named may legitimately have been cancelled since.
  const from = cursor ? sorted.findIndex((row) => row.id === cursor) + 1 : 0;
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  return {
    items,
    ...(from + items.length < sorted.length && last ? { nextCursor: last.id } : {}),
    total: sorted.length,
  };
}

/**
 * Rows of one collection belonging to the caller's active workspace.
 *
 * The workspace filter is applied here as well as by row-level security, for the reason
 * `GET /v1/contracts` states: a tenant may hold several workspaces, so the route's contract is said
 * by the route rather than inferred from the ambient scope.
 */
async function rowsOf<T extends { workspaceId?: string }>(
  context: RequestContext,
  collection: string,
): Promise<T[]> {
  const scoped = workspaceScoped(context);
  const all = await trustStore.list<T>(collection);
  return all.filter((row) => row.workspaceId === scoped.activeWorkspaceId);
}

/** One paged reader, used by every list route so they cannot drift apart. */
export async function readCollection<T extends Identified & { workspaceId?: string }>(
  context: RequestContext,
  collection: string,
  url: string,
): Promise<Page<T>> {
  return page(await rowsOf<T>(context, collection), pageParameters(url));
}

// ---------------------------------------------------------------------------
// The position
// ---------------------------------------------------------------------------

type Commitment = { id: string; workspaceId: string; currency: string; committedAmountMinor: number; status: string };
type Reservation = { id: string; workspaceId: string; fundingCommitmentId: string; reservedAmountMinor: number; status: string };
type Release = { id: string; workspaceId: string; currency: string; requestedAmountMinor: number; status: string };
type Instruction = { id: string; workspaceId: string; currency: string; amountMinor: number; status: string };
type Reconciliation = { id: string; workspaceId: string; currency: string; providerReportedAmountMinor: number; matched: boolean };

export type FinancialPosition = {
  currency: string;
  /**
   * Funds a provider has confirmed holding. PENDING_CONFIRMATION commitments are excluded: a
   * commitment nobody has confirmed is an intention, and counting it would overstate what exists.
   */
  confirmedCommittedMinor: number;
  /** Commitments recorded but not yet confirmed by the provider, reported separately rather than mixed in. */
  awaitingProviderConfirmationMinor: number;
  /** Held against confirmed commitments. `202608110023` guarantees this never exceeds the confirmed total. */
  reservedMinor: number;
  /** Confirmed less reserved. The one derived figure, and sound because the database enforces the bound. */
  unreservedMinor: number;
  /** Claimed by live release requests. CANCELLED requests are excluded, because cancelling frees the claim. */
  requestedForReleaseMinor: number;
  /** Instructions the provider has reported settling. */
  settledMinor: number;
  /** Instructions sent and not yet resolved. */
  inFlightMinor: number;
  reversedMinor: number;
  failedMinor: number;
  /** What the provider's own statements said, where a reconciliation record carries it. */
  providerReportedSettledMinor: number;
  /** Reconciliations whose provider amount disagreed with ours. Non-zero is an exception to work, not a rounding note. */
  unmatchedReconciliations: number;
};

export type FinancialPositionReport = {
  positions: FinancialPosition[];
  /**
   * Stated in the payload, not just in documentation, because a client that renders this as a
   * balance would be making a claim about custody that is not true.
   */
  basis: string;
};

const sum = <T>(rows: T[], amount: (row: T) => number) => rows.reduce((total, row) => total + amount(row), 0);

/**
 * The workspace's financial position, per currency, from rows alone.
 *
 * Reservations carry no currency of their own — they hang off a funding commitment — so each
 * reservation is attributed to its commitment's currency. A reservation whose commitment is not
 * visible is counted in no currency rather than guessed into one, and `unreservedMinor` would then
 * overstate; that cannot happen through the store, because the composite foreign key requires the
 * commitment, and it is the reason the attribution is done by lookup rather than by assuming a
 * default.
 */
export async function getFinancialPosition(context: RequestContext): Promise<FinancialPositionReport> {
  const [commitments, reservations, releases, instructions, reconciliations] = await Promise.all([
    rowsOf<Commitment>(context, 'fundingCommitments'),
    rowsOf<Reservation>(context, 'fundReservations'),
    rowsOf<Release>(context, 'releaseRequests'),
    rowsOf<Instruction>(context, 'paymentInstructions'),
    rowsOf<Reconciliation>(context, 'reconciliationRecords'),
  ]);
  return {
    positions: computePositions({ commitments, reservations, releases, instructions, reconciliations }),
    basis: POSITION_BASIS,
  };
}

export const POSITION_BASIS =
  'AssuraPay holds no funds. Every figure is this workspace’s own record of what a certified ' +
  'financial provider confirmed, reserved, was instructed to pay or reported settling. It is not ' +
  'a custodian statement and not an account balance.';

export type PositionRows = {
  commitments: Commitment[];
  reservations: Reservation[];
  releases: Release[];
  instructions: Instruction[];
  reconciliations: Reconciliation[];
};

/**
 * The arithmetic, separated from the fetch so it can be tested on its own.
 *
 * Exported for that reason and no other: the route calls `getFinancialPosition`. Keeping it pure is
 * what lets the figures be checked against known rows rather than only through a composition root
 * that binds a process-wide store.
 */
export function computePositions(rows: PositionRows): FinancialPosition[] {
  const { commitments, reservations, releases, instructions, reconciliations } = rows;
  const currencyOfCommitment = new Map(commitments.map((commitment) => [commitment.id, commitment.currency]));
  const reservationCurrency = (reservation: Reservation) =>
    currencyOfCommitment.get(reservation.fundingCommitmentId);

  const currencies = [
    ...new Set([
      ...commitments.map((row) => row.currency),
      ...releases.map((row) => row.currency),
      ...instructions.map((row) => row.currency),
      ...reconciliations.map((row) => row.currency),
    ]),
  ].sort();

  return currencies.map((currency): FinancialPosition => {
    const confirmed = commitments.filter((row) => row.currency === currency && row.status === 'CONFIRMED');
    const pending = commitments.filter(
      (row) => row.currency === currency && row.status === 'PENDING_CONFIRMATION',
    );
    const held = reservations.filter(
      (row) => row.status === 'RESERVED' && reservationCurrency(row) === currency,
    );
    const confirmedCommittedMinor = sum(confirmed, (row) => row.committedAmountMinor);
    const reservedMinor = sum(held, (row) => row.reservedAmountMinor);
    const byStatus = (status: string) =>
      sum(
        instructions.filter((row) => row.currency === currency && row.status === status),
        (row) => row.amountMinor,
      );

    return {
      currency,
      confirmedCommittedMinor,
      awaitingProviderConfirmationMinor: sum(pending, (row) => row.committedAmountMinor),
      reservedMinor,
      unreservedMinor: confirmedCommittedMinor - reservedMinor,
      requestedForReleaseMinor: sum(
        releases.filter((row) => row.currency === currency && row.status !== 'CANCELLED'),
        (row) => row.requestedAmountMinor,
      ),
      settledMinor: byStatus('SETTLED'),
      inFlightMinor: byStatus('SUBMITTED'),
      reversedMinor: byStatus('REVERSED'),
      failedMinor: byStatus('FAILED'),
      providerReportedSettledMinor: sum(
        reconciliations.filter((row) => row.currency === currency),
        (row) => row.providerReportedAmountMinor,
      ),
      unmatchedReconciliations: reconciliations.filter((row) => row.currency === currency && !row.matched)
        .length,
    };
  });
}
