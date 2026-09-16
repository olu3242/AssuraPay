import { defineConfig } from '@playwright/test';
/** Public navigation proof only; authenticated PostgreSQL certification remains separate. */
export default defineConfig({
  testDir: './e2e/navigation',
  use: { baseURL: process.env.ASSURAPAY_NAVIGATION_BASE_URL ?? 'http://127.0.0.1:3220', headless: true },
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/convergence/navigation-browser.json' }],
  ],
});
