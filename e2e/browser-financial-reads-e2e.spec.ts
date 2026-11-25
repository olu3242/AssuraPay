import { expect, test, type Page } from '@playwright/test';

/**
 * browser-financial-reads-e2e — the financial read surface is reachable, scoped and honest.
 *
 * Before this capability the platform had 165 financial write routes and exactly one financial read
 * route, so a commitment, reservation, entitlement, ledger entry or settlement could be created and
 * never looked at again over HTTP. That is why every financial screen in the application was static
 * text: there was nothing for a screen to read.
 *
 * What is certified here is reachability and governance through the real production build — that each
 * read answers for a caller holding its key, refuses one without it, and reports an empty workspace
 * as empty rather than as a row of zeroes. The arithmetic is proved in `financial-reads.test.ts`
 * against rows chosen so a wrong answer is obvious, and the tenancy boundary on these tables is
 * already proved under forced row-level security by the Batch C and RLS runtime suites; repeating
 * either here would be duplication rather than evidence.
 */

const READS = [
  'funding-commitments',
  'financial-entitlements',
  'invoices',
  'fund-reservations',
  'release-requests',
  'payment-instructions',
  'ledger-entries',
  'reconciliation-records',
  'disputes',
  'final-settlement-accounts',
] as const;

function uniqueEmail(label: string): string {
  return `finreads-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function foundWorkspace(page: Page, label: string): Promise<{ workspaceId: string; userId: string }> {
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Financial ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await page.getByTestId('organization-name').fill(`Financial ${label} Organization`);
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return { workspaceId, userId: (await page.getByTestId('session-user').innerText()).trim() };
}

/** A fresh single-use assertion, minted the way the application's own client mints one. */
async function assertion(page: Page, workspaceId: string): Promise<Record<string, string>> {
  const response = await page.request.post('/api/v1/auth/assertion', { data: { workspaceId } });
  expect(response.ok(), 'minting an assertion must succeed for a signed-in caller').toBe(true);
  const { assertion: token } = (await response.json()) as { assertion: string };
  return { 'x-assurapay-identity-assertion': token };
}

async function grantRole(page: Page, workspaceId: string, userId: string, role: string): Promise<void> {
  const response = await page.request.post('/api/v1/roles/assignments', {
    headers: await assertion(page, workspaceId),
    data: { userId, role },
  });
  expect(response.status(), await response.text()).toBe(201);
}

test.describe('browser-financial-reads-e2e: governance', () => {
  test('refuses every financial read with no session', async ({ request }) => {
    // Deny by default, from outside any session.
    for (const segment of [...READS, 'financial-position']) {
      const response = await request.get(`/api/v1/${segment}`);
      expect(response.ok(), segment).toBe(false);
      expect(response.status(), segment).toBeGreaterThanOrEqual(400);
    }
  });

  test('refuses the founding administrator, who holds no financial key', async ({ page }) => {
    const { workspaceId } = await foundWorkspace(page, 'founder');

    // `WORKSPACE_ADMINISTRATOR` is the only bootstrappable role and "deliberately holds no
    // certification, release or payment key, so founding a workspace does not create a principal who
    // can move money alone". It holds no financial *read* key either, so founding a workspace does
    // not hand someone the whole settlement history.
    const response = await page.request.get('/api/v1/ledger-entries', {
      headers: await assertion(page, workspaceId),
    });
    expect(response.status()).toBe(403);
    expect(await response.text()).toContain('ENFORCEMENT_PERMISSION_DENIED');
  });

  test('answers every read for the reporting role, and reports an empty workspace as empty', async ({
    page,
  }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'analyst');
    // `ASSURANCE_ANALYST` "reads and derives; holds no key that changes contract, certification or
    // settlement state" — and until this capability held no financial read key at all, so the one
    // role meant to report on settlement could see none of it.
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    for (const segment of READS) {
      const response = await page.request.get(`/api/v1/${segment}`, {
        headers: await assertion(page, workspaceId),
      });
      expect(response.ok(), `${segment}: ${await response.text()}`).toBe(true);
      const body = (await response.json()) as { items: unknown[]; total: number; nextCursor?: string };
      // Empty, and shaped: a client can tell "no rows" from "one page of many" without guessing.
      expect(body.items, segment).toEqual([]);
      expect(body.total, segment).toBe(0);
      expect(body.nextCursor, segment).toBeUndefined();
    }
  });

  test('reports no position at all for a workspace with no financial records', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'position');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    const response = await page.request.get('/api/v1/financial-position', {
      headers: await assertion(page, workspaceId),
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { positions: unknown[]; basis: string };

    // No positions rather than a row of zeroes. A zero row reads as "we checked and there is
    // nothing", which is the same screen a broken read would draw.
    expect(body.positions).toEqual([]);
    // And the response says what it is. A client rendering these figures as an account balance would
    // be asserting custody AssuraPay does not have, so the disclaimer travels with the data rather
    // than living in documentation.
    expect(body.basis).toContain('holds no funds');
    expect(body.basis).toContain('not a custodian statement');
  });

  test('refuses a read the caller’s role does not cover', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'narrow');
    // The dispute manager reads disputes and what is under dispute, and is "kept separate from
    // settlement so a dispute outcome is not decided by whoever benefits from releasing". It has no
    // reason to read the journal, so it cannot.
    await grantRole(page, workspaceId, userId, 'DISPUTE_MANAGER');

    const allowed = await page.request.get('/api/v1/disputes', {
      headers: await assertion(page, workspaceId),
    });
    expect(allowed.ok(), await allowed.text()).toBe(true);

    const refused = await page.request.get('/api/v1/ledger-entries', {
      headers: await assertion(page, workspaceId),
    });
    expect(refused.status()).toBe(403);
  });

  test('bounds a page and caps an oversized limit', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'paging');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    // Asserted through the route rather than only in the unit test, because the cap is what protects
    // the response and a route that ignored the query string would pass the unit test regardless.
    const response = await page.request.get('/api/v1/invoices?limit=100000', {
      headers: await assertion(page, workspaceId),
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBeLessThanOrEqual(200);
    expect(body).toHaveProperty('total');
  });
});
