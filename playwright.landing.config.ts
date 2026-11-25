import { defineConfig, devices } from '@playwright/test';

/** Public marketing interactions need no account, database, or payment provider. */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'browser-landing-interactions.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://localhost:3000',
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
