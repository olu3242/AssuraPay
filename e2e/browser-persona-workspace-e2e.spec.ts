import { expect, test, type Page } from '@playwright/test';

/**
 * browser-persona-workspace-e2e — a workspace presents authority and never confers it.
 *
 * The whole risk in a persona-shaped interface is that the interface quietly becomes the authorization: a
 * menu that hides a button starts to feel like a control, and then someone types the URL. These assertions
 * exist to make that impossible to believe. A caller is given a role, their workspace fills; a caller without
 * it reaches the same URL and is told so plainly while the routes behind it refuse independently.
 *
 * The unit suite proves navigation is *derived* from grants. This proves the derivation survives the round
 * trip through a real production build, a real session and real row-level security.
 */

function uniqueEmail(label: string): string {
  return `persona-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function foundWorkspace(page: Page, label: string): Promise<{ workspaceId: string; userId: string }> {
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Persona ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await page.getByTestId('organization-name').fill(`Persona ${label} Organization`);
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

test.describe('browser-persona-workspace-e2e: the workspace reflects real authority', () => {
  test('tells a signed-out visitor to sign in rather than showing an empty workspace', async ({ page }) => {
    await page.goto('/workspace/finance');
    await expect(page.getByTestId('workspace-signed-out')).toBeVisible();
    await expect(page.getByTestId('workspace-modules')).toHaveCount(0);
  });

  test('says plainly when the caller holds no authority here, rather than rendering a blank page', async ({
    page,
  }) => {
    // The founding administrator holds `roles:read` and so belongs in the admin workspace — and holds nothing
    // the finance workspace gates on. Being told so is the point: "you cannot act here" and "there is nothing
    // here" are different facts.
    await foundWorkspace(page, 'nofinance');
    await page.goto('/workspace/finance');

    await expect(page.getByTestId('workspace-not-yours')).toBeVisible();

    // The gated areas are withheld and counted, not rendered.
    await expect(page.getByTestId('workspace-withheld')).toBeVisible();
    await expect(page.locator('[data-testid="workspace-modules"] a[href="/settlement-execution"]')).toHaveCount(
      0,
    );

    // The ungated ones still appear, and should: Settings and the account screen are reachable by anyone
    // signed in, and hiding them from someone who lacks finance authority would be punishing the wrong thing.
    await expect(page.locator('[data-testid="workspace-modules"] a[href="/settings"]')).toBeVisible();
  });

  test('fills the workspace a granted role opens, and only with what that role reaches', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'finance');
    await grantRole(page, workspaceId, userId, 'PAYMENT_OPERATOR');

    await page.goto('/workspace/finance');
    await expect(page.getByTestId('persona-workspace')).toBeVisible();
    await expect(page.getByTestId('workspace-not-yours')).toHaveCount(0);
    await expect(page.getByTestId('workspace-modules')).toBeVisible();

    // Every module offered must actually open. A menu entry that 403s is worse than one that is absent.
    const links = await page
      .locator('[data-testid="workspace-modules"] a')
      .evaluateAll((all) => all.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      const response = await page.request.get(href!);
      expect(response.status(), `${href} must not 404`).toBeLessThan(400);
    }
  });

  test('the admin workspace opens for the founder, because founding grants roles:read', async ({ page }) => {
    await foundWorkspace(page, 'admin');
    await page.goto('/workspace/admin');
    await expect(page.getByTestId('workspace-modules')).toBeVisible();
    await expect(page.getByTestId('workspace-not-yours')).toHaveCount(0);
  });

  test('404s an unknown workspace name instead of rendering an empty shell', async ({ page }) => {
    const response = await page.goto('/workspace/not-a-workspace');
    expect(response?.status()).toBe(404);
  });
});

test.describe('browser-persona-workspace-e2e: the dashboard shows only what it read', () => {
  test('omits a tile the caller may not read, rather than showing it as zero', async ({ page }) => {
    // The rule the dashboard turns on. "Settled: 0" to someone who lacks `financial-position:read` states
    // something false — that the platform looked and found nothing, when it was not allowed to look. The
    // founding administrator holds no financial key, so the tile must be absent.
    await foundWorkspace(page, 'notiles');
    await page.goto('/workspace/finance');

    await expect(page.getByTestId('persona-workspace')).toBeVisible();
    await expect(page.getByTestId('tile-position')).toHaveCount(0);
  });

  test('shows an honest empty position once the caller may read it', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'tiles');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    await page.goto('/workspace/finance');
    await expect(page.getByTestId('tile-position')).toBeVisible();

    // A fresh workspace has no position at all, which is a different statement from a row of zeroes.
    await expect(page.getByTestId('tile-position-empty')).toBeVisible();
    await expect(page.getByTestId('tile-position-rows')).toHaveCount(0);

    // And the non-custody statement travels with the figures rather than living in documentation.
    await expect(page.getByTestId('tile-position')).toContainText('holds no funds');
  });

  test('counts the caller’s own approvals rather than the workspace’s', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'queue');
    await grantRole(page, workspaceId, userId, 'EXECUTION_MANAGER');

    await page.goto('/workspace/enterprise');
    await expect(page.getByTestId('tile-approvals')).toBeVisible();
    // Nothing is in flight in a new workspace, so the honest count is zero — and here a zero is a
    // measurement, because the caller holds the key and the platform did look.
    await expect(page.getByTestId('tile-approvals-count')).toHaveText('0');
  });
});

test.describe('browser-persona-workspace-e2e: presentation is not policy', () => {
  test('reaching a workspace by URL grants nothing the caller did not already hold', async ({ page }) => {
    const { workspaceId } = await foundWorkspace(page, 'url');

    // Visiting the finance workspace directly.
    await page.goto('/workspace/finance');
    await expect(page.getByTestId('workspace-not-yours')).toBeVisible();

    // The route behind it refuses regardless, which is the assertion that matters: the screen is a view, and
    // the gateway is what decides.
    const response = await page.request.get('/api/v1/ledger-entries', {
      headers: await assertion(page, workspaceId),
    });
    expect(response.status()).toBe(403);
  });

  test('reports the caller’s own permissions and nobody else’s', async ({ page }) => {
    const { workspaceId, userId } = await foundWorkspace(page, 'mine');
    await grantRole(page, workspaceId, userId, 'ASSURANCE_ANALYST');

    const response = await page.request.get('/api/v1/me/permissions', {
      headers: await assertion(page, workspaceId),
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { permissionKeys: string[]; workspaces: string[] };

    // The analyst reads; it holds no key that changes settlement state. Asserted both ways, because a
    // self-report that over-claims is worse than none.
    expect(body.permissionKeys).toContain('ledger-entries:read');
    expect(body.permissionKeys).not.toContain('payment-instructions:submit');
    expect(body.workspaces.length).toBeGreaterThan(0);
  });

  test('refuses the self-permission read with no session', async ({ request }) => {
    const response = await request.get('/api/v1/me/permissions');
    expect(response.ok()).toBe(false);
  });
});
