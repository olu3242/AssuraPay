import { expect, test } from '@playwright/test';

test('authenticates through the supported browser boundary and recovers the PostgreSQL session', async ({ page }) => {
  const email = `browser-${Date.now()}@assurapay.test`;
  await page.goto('/auth/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill('Browser Buyer');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  const session = await page.request.get('/api/v1/auth/session');
  expect(session.ok()).toBeTruthy();
  expect(await session.json()).toEqual(expect.objectContaining({ status: 'ACTIVE' }));
});
