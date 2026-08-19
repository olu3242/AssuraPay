import { expect, test } from '@playwright/test';

function uniqueEmail(label: string): string {
  return `rc1-agreement-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

/**
 * Establishes the same real bootstrap preconditions a user has to establish.
 * Nothing seeds the engine or writes directly to PostgreSQL: every transition is a
 * browser click against the production build.
 */
async function bootstrapWorkspace(page: import('@playwright/test').Page) {
  const email = uniqueEmail('owner');
  await page.goto('/start');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('display-name').fill('RC1 Agreement Owner');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Registration succeeded');

  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();

  await page.getByTestId('organization-name').fill('RC1 Agreement Organization');
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');

  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  expect(workspaceId).not.toHaveLength(0);
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
}

test.describe('browser-agreement-e2e: Phase C agreement reachability', () => {
  test('assigns contract authority and creates a governed contract in the active workspace', async ({ page }) => {
    await bootstrapWorkspace(page);

    await page.goto('/contracts');
    await expect(page.getByTestId('agreement-console')).toBeVisible();
    await expect(page.getByTestId('agreement-workspace-required')).toHaveCount(0);

    await page.getByTestId('grant-contract-author').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('Contract-author role assignment succeeded');

    const number = `RC1-${Date.now()}`;
    await page.getByTestId('contract-number').fill(number);
    await page.getByTestId('contract-title').fill('Browser-certified commercial agreement');
    await page.getByTestId('contract-type').fill('COMMERCIAL');
    await page.getByTestId('create-contract').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('Contract creation succeeded');

    const rows = page.getByTestId('contract-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(number);
    await expect(rows.first()).toContainText('Browser-certified commercial agreement');
  });
});
