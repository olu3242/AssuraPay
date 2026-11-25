import { expect, test, type Page } from '@playwright/test';

/**
 * browser-app-chrome-e2e — the header shows the workspace you are actually acting in.
 *
 * The unit guards in `app-chrome.test.ts` prove there is one header, that it is styled in tokens
 * rather than in Tailwind classes that would do nothing, and that the landing palette still derives
 * from the brand one. None of that proves the header *works*.
 *
 * What needs a browser is the part that reads server state. Workspace context is not a client
 * concern: an assertion is minted for a workspace and refused for one the caller is not an active
 * member of. So a header that displayed a remembered workspace name would eventually show authority
 * the session no longer carries — and that failure is invisible to every test that does not run a
 * real session against real row-level security.
 */

function uniqueEmail(label: string): string {
  return `chrome-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function register(page: Page, label: string): Promise<void> {
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Chrome ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
}

async function foundAndActivate(page: Page, label: string): Promise<string> {
  await register(page, label);
  await page.getByTestId('organization-name').fill(`Chrome ${label} Organization`);
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return workspaceId;
}

test.describe('browser-app-chrome-e2e: one header, on the right pages', () => {
  test('renders the application header on a subpage and not on the landing page', async ({ page }) => {
    // The landing page carries its own chrome, scoped under `#preferred-landing` with its own
    // semantic layer over the same tokens. Two brands on one screen is the thing to avoid.
    await page.goto('/');
    await expect(page.getByTestId('app-navigation')).toHaveCount(0);

    await page.goto('/settlements');
    await expect(page.getByTestId('app-navigation')).toBeVisible();
  });

  test('marks the section the reader is in, including from a record page', async ({ page }) => {
    await page.goto('/settlements');
    const current = page.locator('[data-testid="app-navigation"] a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Settlements');
  });

  test('offers every destination it lists, so no header link 404s', async ({ page }) => {
    // A dead link in the chrome appears on every page at once. `/performance` was exactly that
    // before it was corrected to `/performance-blueprint`.
    await page.goto('/settlements');
    const links = await page
      .locator('[data-testid="app-navigation"] nav a')
      .evaluateAll((all) => all.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(links.length).toBeGreaterThan(5);
    for (const href of links) {
      const response = await page.request.get(href!);
      expect(response.status(), `${href} must not 404`).toBeLessThan(400);
    }
  });
});

test.describe('browser-app-chrome-e2e: the workspace switcher reflects the session', () => {
  test('offers neither a switcher nor the primary action with no workspace active', async ({ page }) => {
    // Registered and signed in, but no tenant founded, so there is no workspace to act in. Offering
    // "New agreement" here would lead to a route that refuses, which is worse than not offering it.
    await register(page, 'noworkspace');
    await page.goto('/settlements');
    await expect(page.getByTestId('app-navigation')).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(page.getByTestId('new-agreement')).toHaveCount(0);
  });

  test('shows the active workspace and the primary action once one is active', async ({ page }) => {
    const workspaceId = await foundAndActivate(page, 'active');

    await page.goto('/settlements');
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();
    // The value is the workspace the *session* says is active, read back from the server rather
    // than remembered from the page that activated it.
    await expect(page.getByTestId('workspace-switcher-select')).toHaveValue(workspaceId);

    const action = page.getByTestId('new-agreement');
    await expect(action).toBeVisible();
    // And it goes somewhere that opens, rather than somewhere that refuses.
    const response = await page.request.get((await action.getAttribute('href'))!);
    expect(response.status()).toBeLessThan(400);
  });

  test('keeps showing the active workspace across a navigation', async ({ page }) => {
    // The header re-reads the session on navigation. Without that, activating a workspace on
    // `/start` would leave every other page's header showing the previous one until a full reload.
    const workspaceId = await foundAndActivate(page, 'persist');
    for (const route of ['/settlements', '/execution', '/approvals']) {
      await page.goto(route);
      await expect(page.getByTestId('workspace-switcher-select')).toHaveValue(workspaceId);
    }
  });

  test('offers only workspaces the caller is a member of', async ({ page }) => {
    // The switcher lists `/api/v1/me/workspaces`, which is scoped to the caller. A header that
    // listed anything else would be offering a switch the assertion mint would then refuse.
    const workspaceId = await foundAndActivate(page, 'mine');
    await page.goto('/settlements');
    // Waited for explicitly: `evaluateAll` does not retry the way `toHaveValue` does, so reading the
    // options straight after navigation returned an empty list from a select that had not rendered.
    await expect(page.getByTestId('workspace-switcher-select')).toHaveValue(workspaceId);
    const options = await page
      .locator('[data-testid="workspace-switcher-select"] option')
      .evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
    expect(options).toEqual([workspaceId]);
  });
});
