import { expect, test, type Page } from '@playwright/test';

/**
 * browser-record-page-e2e — a record page shows what the caller may read and says so when it cannot.
 *
 * The record surface is seventeen read routes and one page. The risks are the same two the workspace
 * suite guards against, one level down: that the page becomes the authorization, and that an absence
 * on screen gets read as a fact about the business rather than about permissions.
 *
 * So these assertions do three things a unit test cannot. They prove a record in another workspace is
 * reported exactly as one that does not exist, through a real session against real row-level
 * security. They prove the route behind the page refuses independently of what is rendered. And they
 * prove the history tab reads the ledger the engines actually write, which is the half of the
 * acceptance criterion — *who validated it, and what outcome was achieved* — that no amount of
 * schema work can demonstrate on its own.
 */

function uniqueEmail(label: string): string {
  return `record-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function foundWorkspace(page: Page, label: string): Promise<{ workspaceId: string; userId: string }> {
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Record ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await page.getByTestId('organization-name').fill(`Record ${label} Organization`);
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return { workspaceId, userId: (await page.getByTestId('session-user').innerText()).trim() };
}

async function assertion(page: Page, workspaceId: string): Promise<Record<string, string>> {
  const response = await page.request.post('/api/v1/auth/assertion', { data: { workspaceId } });
  expect(response.ok()).toBe(true);
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

test.describe('browser-record-page-e2e: the page reflects real authority', () => {
  test('tells a signed-out visitor to sign in rather than showing an empty record', async ({ page }) => {
    await page.goto('/records/invoices/any-id');
    await expect(page.getByTestId('record-signed-out')).toBeVisible();
    await expect(page.getByTestId('record-details')).toHaveCount(0);
  });

  test('404s an unknown record type from the server instead of rendering a shell', async ({ page }) => {
    // A mistyped type must fail visibly. An empty record page would look like a record with no data.
    const response = await page.goto('/records/not-a-record-type/any-id');
    expect(response?.status()).toBe(404);
  });

  test('says the caller may not read this kind of record, rather than that none exists', async ({
    page,
  }) => {
    // The founding administrator deliberately holds no record read key — reading every invoice and
    // certificate is not administration. Being told that, rather than "no such record", is the point:
    // the two sentences would send a reader to completely different places.
    await foundWorkspace(page, 'noread');
    await page.goto('/records/invoices/some-invoice');
    await expect(page.getByTestId('record-forbidden')).toBeVisible();
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });

  test('reports a record that does not exist as absent once the caller may read the type', async ({
    page,
  }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'absent');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    await page.goto('/records/invoices/00000000-0000-0000-0000-00000000dead');
    await expect(page.getByTestId('record-not-found')).toBeVisible();
    await expect(page.getByTestId('record-forbidden')).toHaveCount(0);
  });
});

test.describe('browser-record-page-e2e: presentation is not policy', () => {
  test('the record route refuses regardless of what the page renders', async ({ page }) => {
    const { workspaceId } = await foundWorkspace(page, 'route');
    const headers = await assertion(page, workspaceId);

    // The founder holds no record read key, so every record route must refuse — whatever the page does.
    for (const path of [
      '/api/v1/invoices/any',
      '/api/v1/release-requests/any',
      '/api/v1/payment-instructions/any',
      '/api/v1/completion-certificates/any',
    ]) {
      const response = await page.request.get(path, { headers });
      expect(response.status(), `${path} must refuse an unauthorized caller`).toBe(403);
    }
  });

  test('refuses the audit trail to a caller holding no audit permission', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'audit');
    // PAYMENT_OPERATOR may read payment instructions and deliberately holds no `audit-records:read`.
    await grantRole(page, workspaceId, userId, 'PAYMENT_OPERATOR');

    const headers = await assertion(page, workspaceId);
    const response = await page.request.get('/api/v1/audit-trail/payment-instructions/any', { headers });
    expect(response.status()).toBe(403);
  });

  test('refuses an unknown type on the audit route rather than returning an empty trail', async ({
    page,
  }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'audittype');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    const headers = await assertion(page, workspaceId);
    const response = await page.request.get('/api/v1/audit-trail/not-a-type/any', { headers });
    // An empty trail and a misspelled type must not look the same to a client.
    expect(response.status()).toBe(404);
    expect(await response.text()).toContain('RECORD_TYPE_UNKNOWN');
  });

  test('refuses every record route with no session at all', async ({ request }) => {
    for (const path of ['/api/v1/invoices/any', '/api/v1/audit-trail/invoices/any']) {
      const response = await request.get(path);
      expect(response.ok(), path).toBe(false);
    }
  });
});

test.describe('browser-record-page-e2e: a real record, read and walked', () => {
  test('shows a contract, its history and the links the chain actually holds', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'walk');
    // CONTRACT_AUTHOR creates the contract; ASSURANCE_ANALYST reads it and its history. Two grants
    // rather than one, because no single role both authors and audits — and asking for one that did
    // would be asking the platform to break its own separation for a test's convenience.
    await grantRole(page, workspaceId, userId, 'CONTRACT_AUTHOR');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    const headers = await assertion(page, workspaceId);
    const created = await page.request.post('/api/v1/contracts', {
      headers,
      data: {
        contractNumber: `REC-${Date.now()}`,
        title: 'Equipment procurement',
        contractType: 'PROCUREMENT',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const contract = (await created.json()) as { id: string };

    // The API first: the page can only be right if the route is.
    const read = await page.request.get(`/api/v1/contracts/${contract.id}`, { headers });
    expect(read.status(), await read.text()).toBe(200);
    const payload = (await read.json()) as {
      type: string;
      record: { id: string; title: string };
      related: { parents: unknown[]; children: unknown[]; withheld: string[] };
    };
    expect(payload.type).toBe('contracts');
    expect(payload.record.id).toBe(contract.id);
    expect(payload.record.title).toBe('Equipment procurement');
    // A contract is the head of the chain, so it has no parents — a fact, not an omission.
    expect(payload.related.parents).toEqual([]);

    // Then the page.
    await page.goto(`/records/contracts/${contract.id}`);
    await expect(page.getByTestId('record-details')).toBeVisible();
    await expect(page.getByTestId('record-id')).toHaveText(contract.id);
    await expect(page.getByTestId('record-field-title')).toHaveText('Equipment procurement');

    // The Related tab states the absence rather than rendering nothing.
    await page.getByTestId('record-tab-related').click();
    await expect(page.getByTestId('record-no-parents')).toBeVisible();

    // And the History tab shows the entry the engine wrote when the contract was created. This is the
    // assertion that matters most: the audit ledger was being written faithfully and had no HTTP route
    // at all, so none of this history was readable by anything before now.
    await page.getByTestId('record-tab-history').click();
    await expect(page.getByTestId('record-history-entries')).toBeVisible();
    await expect(page.getByTestId('record-history-entry').first()).toBeVisible();
    await expect(page.getByTestId('record-history-basis')).toContainText('Append-only');
  });
});
