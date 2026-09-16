import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('the supplied logo loads unchanged and every brand links home', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const logo = await request.get('/images/assurapay-symbol.png');
  expect(logo.ok()).toBe(true);
  expect(
    createHash('sha256')
      .update(await logo.body())
      .digest('hex'),
  ).toBe(
    createHash('sha256')
      .update(readFileSync('apps/web/public/images/assurapay-symbol.png'))
      .digest('hex'),
  );
  const brands = page.getByRole('link', { name: 'AssuraPay home' });
  expect(await brands.count()).toBe(2);
  for (const brand of await brands.all()) {
    await expect(brand).toHaveAttribute('href', '/');
    await expect(brand.locator('img')).toBeVisible();
  }
  await page.goto('/start');
  await page.getByRole('link', { name: 'AssuraPay home' }).click();
  await expect(page).toHaveURL(/\/$/);
});
test('landing links have real targets and tabs and FAQs respond', async ({
  page,
  request,
}) => {
  await page.goto('/');
  expect(
    await page.locator('a[href="#"], a[aria-disabled="true"]').count(),
  ).toBe(0);
  const links = await page
    .locator('a[href]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')!));
  for (const href of new Set(links)) {
    if (href.startsWith('#'))
      expect(await page.locator(href).count(), href).toBeGreaterThan(0);
    else if (href.startsWith('/'))
      expect((await request.get(href)).status(), href).toBeLessThan(400);
  }
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = await tab.getAttribute('aria-controls');
    if (panel) await expect(page.locator('#' + panel)).toBeVisible();
  }
  for (const faq of await page.locator('.faq-q').all()) {
    const initial = await faq.getAttribute('aria-expanded');
    await faq.click();
    await expect(faq).toHaveAttribute(
      'aria-expanded',
      initial === 'true' ? 'false' : 'true',
    );
    await faq.click();
    await expect(faq).toHaveAttribute('aria-expanded', initial!);
  }
});
test('mobile menu opens and closes after navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.locator('#menuToggle');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page
    .locator('#mobile-menu')
    .getByRole('link', { name: 'Product', exact: true })
    .click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});
test('application navigation and legacy entry routes load', async ({
  page,
  request,
}) => {
  await page.goto('/start');
  const hrefs = await page
    .getByRole('navigation', { name: 'Application' })
    .locator('a')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href')!));
  for (const href of hrefs)
    expect((await request.get(href)).status(), href).toBeLessThan(400);
  for (const href of [
    '/auth/login',
    '/auth/register',
    '/onboarding/organization',
  ]) {
    await page.goto(href);
    await expect(page).toHaveURL(/\/start$/);
  }
});

test('agreement intake gives a recoverable sign-in message instead of a dead action', async ({
  page,
}) => {
  await page.goto('/agreements/new');
  await page
    .getByLabel('Describe or paste what has been agreed')
    .fill('Replace the roof after both parties approve the milestones.');
  await page.getByRole('button', { name: 'Structure agreement' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Sign in',
  );
  await page
    .getByRole('link', { name: 'Sign in or select a workspace' })
    .click();
  await expect(page).toHaveURL(/\/start$/);
});

test('flow recovery sends its reason and a fresh assertion, then refreshes visible state', async ({
  page,
}) => {
  let recovered = false;
  let assertions = 0;
  const usedAssertions: string[] = [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { activeWorkspaceId: 'workspace-1' } }),
  );
  await page.route('**/api/v1/auth/assertion', (route) =>
    route.fulfill({ json: { assertion: `assertion-${++assertions}` } }),
  );
  await page.route('**/api/v1/flows?view=health', (route) => {
    const assertion = route.request().headers()[
      'x-assurapay-identity-assertion'
    ];
    expect(assertion).toBeTruthy();
    expect(usedAssertions).not.toContain(assertion);
    usedAssertions.push(assertion);
    return route.fulfill({
      json: {
        metrics: {
          totalFlows: 1,
          healthyFlows: recovered ? 1 : 0,
          attentionFlows: 0,
          criticalFlows: recovered ? 0 : 1,
          openHumanTasks: 0,
          stalledFlows: recovered ? 0 : 1,
        },
        records: [
          {
            flowId: 'flow-1',
            transactionId: 'transaction-1',
            state: recovered ? 'RUNNING' : 'FAILED',
            status: recovered ? 'HEALTHY' : 'CRITICAL',
            ageMs: 60000,
            openTaskCount: 0,
            oldestOpenTaskAgeMs: 0,
            recommendedAction: recovered ? 'MONITOR' : 'RECOVER_FAILED_FLOW',
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/flows/flow-1/resume', (route) => {
    const assertion = route.request().headers()[
      'x-assurapay-identity-assertion'
    ];
    expect(assertion).toBeTruthy();
    expect(usedAssertions).not.toContain(assertion);
    usedAssertions.push(assertion);
    expect(route.request().postDataJSON()).toEqual({
      action: 'RECOVER',
      reason: 'Provider connection restored',
    });
    recovered = true;
    return route.fulfill({ json: { status: 'RUNNING' } });
  });
  page.on('dialog', (dialog) => dialog.accept('Provider connection restored'));
  await page.goto('/workflow-intelligence');
  await page.getByRole('button', { name: 'Recover flow' }).click();
  await expect(
    page.getByRole('cell', { name: 'RUNNING', exact: true }),
  ).toBeVisible();
  expect(usedAssertions.length).toBeGreaterThanOrEqual(3);
  expect(new Set(usedAssertions).size).toBe(usedAssertions.length);
});
