/**
 * A workspace-scoped GET from a client component.
 *
 * Every read route is gated on a permission evaluated inside the caller's active workspace, which
 * means a browser read needs three things in order: a session, an active workspace, and an identity
 * assertion minted for that workspace. Getting the order wrong produces a 403 that looks like a
 * missing permission, so the sequence lives here once rather than in each screen.
 *
 * The four outcomes are kept apart because they are four different facts, and collapsing any two of
 * them is how a record goes unread: nobody is signed in, the caller holds no authority here, the
 * record is not in this workspace, or the request failed. A screen that renders all of those as an
 * empty panel tells the reader nothing true.
 */

export type ScopedResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'signed-out' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'error'; detail: string };

export async function scopedGet<T>(path: string): Promise<ScopedResult<T>> {
  const session = await fetch('/api/v1/auth/session', { cache: 'no-store' });
  if (!session.ok) return { kind: 'signed-out' };

  const { activeWorkspaceId } = (await session.json()) as { activeWorkspaceId?: string };
  // Signed in with no workspace active is not a permission problem and must not be reported as one:
  // there is no scope in which to evaluate any key yet.
  if (!activeWorkspaceId) return { kind: 'forbidden' };

  try {
    const minted = await fetch('/api/v1/auth/assertion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: activeWorkspaceId }),
    });
    if (!minted.ok) return { kind: 'error', detail: `assertion HTTP ${minted.status}` };
    const { assertion } = (await minted.json()) as { assertion: string };

    const response = await fetch(path, {
      cache: 'no-store',
      headers: { 'x-assurapay-identity-assertion': assertion },
    });
    if (response.status === 403) return { kind: 'forbidden' };
    if (response.status === 404) return { kind: 'not-found' };
    if (!response.ok) return { kind: 'error', detail: `HTTP ${response.status}` };
    return { kind: 'ok', value: (await response.json()) as T };
  } catch (error) {
    return { kind: 'error', detail: error instanceof Error ? error.message : 'Request failed' };
  }
}

/**
 * An amount in integer minor units, rendered without assuming how many minor units a currency has.
 *
 * Money is stored as integer minor units — kobo for naira — and the obvious `amount / 100` is wrong
 * for the currencies that do not have two decimal places. The exponent is therefore taken from the
 * runtime's own currency data rather than assumed, and a currency the runtime does not know is shown
 * as the integer it is, labelled, rather than divided by a guess.
 *
 * Showing a wrong figure is worse than showing an unfamiliar one, in a product whose whole claim is
 * that it can say where the money went.
 */
export function formatMinor(amountMinor: number, currency?: string): string {
  if (!currency) return `${amountMinor} (minor units)`;
  try {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    return `${currency} ${amountMinor} (minor units)`;
  }
}
