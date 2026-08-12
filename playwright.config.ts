import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const databaseUrl = process.env.ASSURAPAY_TEST_DATABASE_URL ?? process.env.ASSURAPAY_DATABASE_URL;
if (!databaseUrl) throw new Error('Playwright requires PostgreSQL; set ASSURAPAY_TEST_DATABASE_URL. File-backed browser runs are forbidden.');

export default defineConfig({
  testDir: './tests/browser',
  outputDir: 'artifacts/playwright/results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm start', url: 'http://127.0.0.1:3000/api/health/live', reuseExistingServer: false,
    env: {
      ASSURAPAY_DEPLOYMENT: 'test', ASSURAPAY_PERSISTENCE_ADAPTER: 'postgres',
      ASSURAPAY_DATABASE_URL: databaseUrl, ASSURAPAY_DATABASE_SSL: 'disable',
      ASSURAPAY_MIGRATIONS_DIRECTORY: path.resolve(process.cwd(), 'supabase/migrations'),
    },
    stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
