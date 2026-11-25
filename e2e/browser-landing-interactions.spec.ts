import { expect, test } from '@playwright/test';

test('local file intake populates a draft and rejects unsupported documents', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Clear agreements',
  );
  await expect(page.locator('img.brand-symbol')).toBeVisible();
  expect(
    await page
      .locator('img.brand-symbol')
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  await page.getByLabel('Upload an agreement text file').setInputFiles({
    name: 'invoice.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'Website refresh\nBuyer: Acme\nSeller: Studio Blue\nMilestone 1: Design | $1,200\nMilestone 2: Build | $2,400',
    ),
  });
  const room = page.locator('.ap-room');
  await expect(room).toContainText('Website refresh');
  await expect(room).toContainText('Acme');
  await expect(room).toContainText('$3,600.00');
  await page
    .getByRole('textbox', {
      name: 'Agreement text Preview updates as you type',
    })
    .fill('New plan\nBuyer: Beta\nMilestone 1: Audit | $500');
  await expect(room).toContainText('New plan');
  await expect(room).toContainText('$500.00');
  await page.getByLabel('Upload an agreement text file').setInputFiles({
    name: 'contract.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF'),
  });
  await expect(page.locator('#product').getByRole('alert')).toContainText(
    'PDF and DOCX files are not supported',
  );
  await expect(room).toContainText('New plan');
  expect(errors).toEqual([]);
});

test('carousel controls preserve milestone state and load selected templates into intake', async ({
  page,
}) => {
  await page.goto('/');
  const carousel = page.locator('#use-cases');
  await carousel
    .getByRole('button', { name: 'Next template', exact: true })
    .click();
  await expect(carousel.getByRole('heading', { level: 3 })).toHaveText(
    'Construction & Renovations',
  );
  await carousel
    .getByRole('button', { name: /Final walkthrough.*Change to Completed/ })
    .click();
  await expect(carousel.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '3',
  );
  await carousel
    .getByRole('button', { name: 'Next template', exact: true })
    .click();
  await expect(carousel.getByRole('heading', { level: 3 })).toHaveText(
    'Digital Deliverables & Software',
  );
  await carousel
    .getByRole('button', { name: 'Previous template', exact: true })
    .click();
  await expect(carousel.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '3',
  );
  await carousel
    .getByRole('button', { name: 'Use this template', exact: true })
    .click();
  await expect(page.locator('.ap-room h2')).toHaveText(
    'Construction & Renovations',
  );
  await carousel
    .getByRole('button', { name: 'Next template', exact: true })
    .focus();
  await page.keyboard.press('End');
  await expect(carousel.getByRole('heading', { level: 3 })).toHaveText(
    'Cross-Border Procurement',
  );
  await page.keyboard.press('ArrowRight');
  await expect(carousel.getByRole('heading', { level: 3 })).toHaveText(
    'Professional Services SOW',
  );
});

test('theme persists and governance tabs support keyboard navigation', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('#assurapay-landing')).toHaveAttribute(
    'data-theme',
    'dark',
  );
  await page.reload();
  await expect(page.locator('#assurapay-landing')).toHaveAttribute(
    'data-theme',
    'dark',
  );
  await page.getByRole('tab', { name: 'AI extraction' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Human authorization' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText(
    'The final call is yours.',
  );
  await page.getByRole('tab', { name: 'Human authorization' }).blur();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: 'test-results/landing-dark.png',
    fullPage: true,
  });
});

test('mobile navigation closes with Escape and the page fits its viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Mobile navigation' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
  await expect(
    page.getByRole('navigation', { name: 'Mobile navigation' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/landing-mobile.png',
    fullPage: true,
  });
});

test('desktop layout and primary destinations render', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.locator('header.app-navigation')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Create an agreement' }).first(),
  ).toHaveAttribute('href', '/start');
  await expect(
    page.getByRole('link', { name: 'Book a demo' }).first(),
  ).toHaveAttribute('href', /^mailto:hello@assurapay.com/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/landing-desktop.png',
    fullPage: true,
  });
});
