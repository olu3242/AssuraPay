import { expect, test } from '@playwright/test';

/**
 * browser-landing-e2e — the landing page is the designed one, and its brand renders.
 *
 * This suite exists because the design went missing. The blue-and-navy identity — the ribbon
 * symbol, the palette, the Agreement Room illustration — was built on
 * `feat/assurapay-full-production-convergence` and never merged, so `main` carried a different
 * landing page and `assurapay-symbol.png` was not in the tree at all. Nothing failed when that
 * happened: there was no assertion anywhere that the landing page looked like the product, so the
 * loss was silent and stayed that way until someone noticed.
 *
 * These are deliberately shallow. A test cannot judge a design, and one asserting exact colours or
 * copy would break on every legitimate revision and teach people to delete it. What it can do is
 * fail loudly if the landing page stops being the designed one, if the brand mark stops loading, or
 * if the application chrome loses its logo — which is exactly the regression that occurred.
 */

test.describe('browser-landing-e2e: the designed landing page', () => {
  test('serves the designed landing, with its brand mark actually loading', async ({ page }) => {
    await page.goto('/');

    // The marketing landing, not an application screen: the app chrome hides itself on `/`.
    await expect(page.locator('header.app-navigation')).toHaveCount(0);
    await expect(page.locator('header.site')).toBeVisible();

    const symbol = page.locator('img.brand-symbol').first();
    await expect(symbol).toBeVisible();
    // `naturalWidth` rather than visibility, because a broken image is still a visible element with
    // alt text. This is the assertion that fails if the asset is missing from the tree again.
    expect(await symbol.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Clear agreements');
  });

  test('carries the design system’s own palette rather than a default stylesheet', async ({ page }) => {
    await page.goto('/');

    // The tokens the identity is built from. Asserted as "defined and non-empty" rather than as
    // exact hex values, so re-tuning the brand does not fail this, but losing the stylesheet does.
    const tokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return ['--ap-blue', '--ap-navy'].map((name) => styles.getPropertyValue(name).trim());
    });
    for (const token of tokens) expect(token).not.toBe('');
  });

  test('shows the product illustration as sample data, never as platform state', async ({ page }) => {
    await page.goto('/');

    // The hero carries a mock agreement with real-looking figures. That is ordinary marketing
    // illustration and not the defect this repository removed from `/workflow-intelligence`, where
    // invented numbers were served to a signed-in user as if computed — but the distinction holds
    // only while the mock says what it is. If that label is ever dropped, the same figures become a
    // claim about the platform.
    await expect(page.getByText('SAMPLE DATA', { exact: false }).first()).toBeVisible();
  });
});

test.describe('browser-landing-e2e: the application chrome', () => {
  test('puts the brand and a working nav on an application screen', async ({ page }) => {
    await page.goto('/approvals');

    const nav = page.locator('header.app-navigation');
    await expect(nav).toBeVisible();
    expect(
      await nav.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);
  });

  test('links only to pages that exist', async ({ page }) => {
    await page.goto('/approvals');

    // Restored as written, the chrome linked to `/performance`, which is not a route — a dead link
    // on every authenticated page. Each destination is followed rather than assumed, because a nav
    // that 404s is worse than no nav.
    const targets = await page
      .locator('header.app-navigation nav a')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(targets.length).toBeGreaterThan(0);

    for (const target of targets) {
      const response = await page.request.get(target!);
      expect(response.status(), `${target} must not 404`).toBeLessThan(400);
    }
  });
});
