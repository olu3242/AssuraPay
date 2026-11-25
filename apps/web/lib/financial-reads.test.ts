import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueKeys, requireRole } from '@assurapay/permissions';
import {
  POSITION_BASIS,
  computePositions,
  page,
  pageParameters,
  type PositionRows,
} from './financial-reads';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * The financial read surface.
 *
 * The platform had 165 financial write routes and one financial read route, so every financial
 * screen in the application was static text — there was nothing to read. These assertions cover the
 * two things that make the new surface safe rather than merely present: that no figure is invented,
 * and that nothing is summed across currencies.
 *
 * The tenancy proof is `financial-reads.postgres.test.ts`, which runs the position against real rows
 * with row-level security in force. The arithmetic is proved here, against rows chosen so a wrong
 * answer is obvious.
 */

const LIB = __dirname;

function source(relative: string): string {
  return readFileSync(path.join(LIB, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const empty: PositionRows = {
  commitments: [],
  reservations: [],
  releases: [],
  instructions: [],
  reconciliations: [],
};

const rows = (overrides: Partial<PositionRows>): PositionRows => ({ ...empty, ...overrides });

describe('the position counts only what the records say', () => {
  it('reports nothing at all for a workspace with no financial records', () => {
    // An empty workspace has no position, not a position of zeroes. A row of zeroes reads as "we
    // checked and there is nothing", which is the same screen a broken read would draw.
    expect(computePositions(empty)).toEqual([]);
  });

  it('excludes a commitment the provider has not confirmed, and reports it separately', () => {
    const [position] = computePositions(
      rows({
        commitments: [
          { id: 'c1', workspaceId: 'w', currency: 'NGN', committedAmountMinor: 500, status: 'CONFIRMED' },
          {
            id: 'c2',
            workspaceId: 'w',
            currency: 'NGN',
            committedAmountMinor: 900,
            status: 'PENDING_CONFIRMATION',
          },
        ],
      }),
    );
    // Counting an unconfirmed commitment as held funds would overstate what exists, which for a
    // non-custodial platform is the whole risk: the figure would imply money a provider never said
    // it had.
    expect(position.confirmedCommittedMinor).toBe(500);
    expect(position.awaitingProviderConfirmationMinor).toBe(900);
    expect(position.unreservedMinor).toBe(500);
  });

  it('attributes a reservation to its commitment’s currency, never to a default', () => {
    const positions = computePositions(
      rows({
        commitments: [
          { id: 'ngn', workspaceId: 'w', currency: 'NGN', committedAmountMinor: 1_000, status: 'CONFIRMED' },
          { id: 'usd', workspaceId: 'w', currency: 'USD', committedAmountMinor: 2_000, status: 'CONFIRMED' },
        ],
        reservations: [
          { id: 'r1', workspaceId: 'w', fundingCommitmentId: 'usd', reservedAmountMinor: 700, status: 'RESERVED' },
        ],
      }),
    );
    const ngn = positions.find((position) => position.currency === 'NGN');
    const usd = positions.find((position) => position.currency === 'USD');
    // A reservation carries no currency of its own, so attributing it by anything but its
    // commitment would move money between currencies on the screen.
    expect(ngn?.reservedMinor).toBe(0);
    expect(usd?.reservedMinor).toBe(700);
    expect(usd?.unreservedMinor).toBe(1_300);
  });

  it('counts a reservation in no currency when its commitment is not visible', () => {
    // Rather than guessing one. The composite foreign key makes this unreachable through the store;
    // the point is that if it ever happened the figure would be absent, not wrong.
    const positions = computePositions(
      rows({
        commitments: [
          { id: 'ngn', workspaceId: 'w', currency: 'NGN', committedAmountMinor: 1_000, status: 'CONFIRMED' },
        ],
        reservations: [
          { id: 'r1', workspaceId: 'w', fundingCommitmentId: 'gone', reservedAmountMinor: 400, status: 'RESERVED' },
        ],
      }),
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].reservedMinor).toBe(0);
  });

  it('ignores a cancelled release and a non-RESERVED reservation', () => {
    const [position] = computePositions(
      rows({
        commitments: [
          { id: 'c1', workspaceId: 'w', currency: 'NGN', committedAmountMinor: 1_000, status: 'CONFIRMED' },
        ],
        reservations: [
          { id: 'r1', workspaceId: 'w', fundingCommitmentId: 'c1', reservedAmountMinor: 400, status: 'RELEASED' },
          { id: 'r2', workspaceId: 'w', fundingCommitmentId: 'c1', reservedAmountMinor: 100, status: 'RESERVED' },
        ],
        releases: [
          { id: 'q1', workspaceId: 'w', currency: 'NGN', requestedAmountMinor: 900, status: 'CANCELLED' },
          { id: 'q2', workspaceId: 'w', currency: 'NGN', requestedAmountMinor: 100, status: 'CONDITIONS_MET' },
        ],
      }),
    );
    expect(position.reservedMinor).toBe(100);
    expect(position.requestedForReleaseMinor).toBe(100);
  });

  it('separates settled, in-flight, failed and reversed rather than netting them', () => {
    const [position] = computePositions(
      rows({
        instructions: [
          { id: 'i1', workspaceId: 'w', currency: 'NGN', amountMinor: 10, status: 'SETTLED' },
          { id: 'i2', workspaceId: 'w', currency: 'NGN', amountMinor: 20, status: 'SUBMITTED' },
          { id: 'i3', workspaceId: 'w', currency: 'NGN', amountMinor: 40, status: 'FAILED' },
          { id: 'i4', workspaceId: 'w', currency: 'NGN', amountMinor: 80, status: 'REVERSED' },
          { id: 'i5', workspaceId: 'w', currency: 'NGN', amountMinor: 160, status: 'DRAFT' },
        ],
      }),
    );
    // A single "paid" figure would hide a reversal and a failure inside it, and a DRAFT instruction
    // is not money anywhere.
    expect(position).toMatchObject({
      settledMinor: 10,
      inFlightMinor: 20,
      failedMinor: 40,
      reversedMinor: 80,
    });
  });

  it('surfaces an unmatched reconciliation as a count, not a rounding note', () => {
    const [position] = computePositions(
      rows({
        reconciliations: [
          { id: 'x1', workspaceId: 'w', currency: 'NGN', providerReportedAmountMinor: 100, matched: true },
          { id: 'x2', workspaceId: 'w', currency: 'NGN', providerReportedAmountMinor: 55, matched: false },
        ],
      }),
    );
    expect(position.providerReportedSettledMinor).toBe(155);
    expect(position.unmatchedReconciliations).toBe(1);
  });

  it('never merges two currencies into one position', () => {
    const positions = computePositions(
      rows({
        commitments: [
          { id: 'a', workspaceId: 'w', currency: 'NGN', committedAmountMinor: 1, status: 'CONFIRMED' },
          { id: 'b', workspaceId: 'w', currency: 'USD', committedAmountMinor: 2, status: 'CONFIRMED' },
        ],
      }),
    );
    expect(positions.map((position) => position.currency)).toEqual(['NGN', 'USD']);
    expect(positions.map((position) => position.confirmedCommittedMinor)).toEqual([1, 2]);
  });

  it('says in the payload that this is not a custodian statement', () => {
    // Carried in the response rather than left to documentation: a client that rendered these
    // figures as an account balance would be asserting custody AssuraPay does not have.
    expect(POSITION_BASIS).toContain('holds no funds');
    expect(POSITION_BASIS).toContain('not a custodian statement');
  });

  it('computes no figure the rows do not contain', () => {
    // A guard against the next change, not against this one. Anything resembling a forecast or an
    // assumed rate would make a traceable figure untraceable.
    const text = source('financial-reads.ts');
    for (const forbidden of [/\bforecast/i, /\bprojected/i, /\bestimate/i, /\bMath\.random/, /\bexchangeRate/i])
      expect(text).not.toMatch(forbidden);
  });
});

describe('paging is bounded and stable', () => {
  const row = (id: string, createdAt: string) => ({ id, createdAt });

  it('caps an oversized limit and falls back on a nonsense one', () => {
    expect(pageParameters('https://x/y?limit=100000').limit).toBe(200);
    expect(pageParameters('https://x/y?limit=abc').limit).toBe(50);
    expect(pageParameters('https://x/y?limit=-3').limit).toBe(50);
    expect(pageParameters('https://x/y').limit).toBe(50);
  });

  it('orders oldest first and breaks ties by id, so a cursor cannot skip or repeat', () => {
    const same = [row('b', '2026-01-01'), row('a', '2026-01-01'), row('c', '2025-01-01')];
    expect(page(same, { limit: 10 }).items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('walks every row exactly once across pages', () => {
    const all = Array.from({ length: 7 }, (_, index) => row(`r${index}`, `2026-01-0${index + 1}`));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = page(all, { limit: 3, cursor });
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((item) => item.id));
    expect(new Set(seen).size).toBe(all.length);
  });

  it('reports the total so a caller knows a page is partial, and omits a cursor on the last page', () => {
    const all = Array.from({ length: 4 }, (_, index) => row(`r${index}`, `2026-01-0${index + 1}`));
    const first = page(all, { limit: 3 });
    expect(first).toMatchObject({ total: 4, nextCursor: 'r2' });
    expect(page(all, { limit: 3, cursor: 'r2' }).nextCursor).toBeUndefined();
  });

  it('starts from the beginning for a cursor that no longer exists', () => {
    // The row a cursor names can legitimately be gone — a release may have been cancelled. Erroring
    // would turn an ordinary lifecycle event into a broken screen.
    const all = [row('a', '2026-01-01'), row('b', '2026-01-02')];
    expect(page(all, { limit: 10, cursor: 'vanished' }).items.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('every read route is governed and grantable', () => {
  const READS = [
    ['/api/v1/funding-commitments|GET', 'funding-commitments:read'],
    ['/api/v1/financial-entitlements|GET', 'financial-entitlements:read'],
    ['/api/v1/invoices|GET', 'invoices:read'],
    ['/api/v1/fund-reservations|GET', 'fund-reservations:read'],
    ['/api/v1/release-requests|GET', 'release-requests:read'],
    ['/api/v1/payment-instructions|GET', 'payment-instructions:read'],
    ['/api/v1/ledger-entries|GET', 'ledger-entries:read'],
    ['/api/v1/reconciliation-records|GET', 'reconciliation-records:read'],
    ['/api/v1/disputes|GET', 'disputes:read'],
    ['/api/v1/final-settlement-accounts|GET', 'final-settlement-accounts:read'],
    ['/api/v1/financial-position|GET', 'financial-position:read'],
  ] as const;

  it('gates each read on its own key, distinct from the write key on the same path', () => {
    const grantable = new Set(catalogueKeys());
    for (const [template, key] of READS) {
      const entry = ROUTE_PERMISSION_REQUIREMENTS[template];
      expect(entry?.access, template).toBe('permission');
      expect(entry, template).toMatchObject({ permissionKey: key });
      // A key no role can hold makes the route permanently unreachable under deny-by-default.
      expect(grantable.has(key), `${key} must be grantable`).toBe(true);
    }
  });

  it('never lets a read key double as a write key', () => {
    // Reading a ledger and posting to it are different authorities. Sharing one key would mean
    // granting the reporting role the ability to write the books.
    for (const [, key] of READS) {
      const writers = Object.entries(ROUTE_PERMISSION_REQUIREMENTS).filter(
        ([template, entry]) =>
          !template.endsWith('|GET') && entry.access === 'permission' && entry.permissionKey === key,
      );
      expect(writers.map(([template]) => template), key).toEqual([]);
    }
  });

  it('keeps the read surface off the founding administrator', () => {
    // `WORKSPACE_ADMINISTRATOR` "deliberately holds no certification, release or payment key, so
    // founding a workspace does not create a principal who can move money alone". Reading every
    // settlement in the workspace is not moving money, but it is not administration either, and
    // granting it here would quietly turn the founder into a finance role — which is also what makes
    // the refusal the browser suite asserts on `/approvals` the correct behaviour rather than a gap.
    const administrator = requireRole('WORKSPACE_ADMINISTRATOR').permissionKeys;
    for (const [, key] of READS) expect(administrator, key).not.toContain(key);
  });

  it('gives the read-only reporting role the whole surface, because that is what it is for', () => {
    // `ASSURANCE_ANALYST` "reads and derives; holds no key that changes contract, certification or
    // settlement state" — and held no financial read key at all, so the one role meant to report on
    // settlement could not see any of it. This is the role a financial operations view runs as.
    const analyst = requireRole('ASSURANCE_ANALYST').permissionKeys;
    for (const [, key] of READS) expect(analyst, key).toContain(key);
  });
});
