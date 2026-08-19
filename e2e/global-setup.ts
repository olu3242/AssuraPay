import { execFileSync } from 'node:child_process';
import { requireTestDatabaseUrl } from './database';

/**
 * Provisions the browser suites' database, exactly once per run.
 *
 * `globalSetup` rather than a side effect of loading `playwright.config.ts`, which is what the first version did
 * and is a trap: Playwright imports the config in every worker process, so provisioning there **dropped and
 * recreated the database while the application was serving requests against it**. Two journeys failed with the
 * provisioning command reported as the error inside the test — a symptom whose cause was three layers away.
 *
 * The ordering problem this replaced is solved from the other side instead. Playwright may launch the web server
 * before global setup finishes, so the server is not waited on with `/api/health/live` — which answers 200
 * without a database — but with `/api/health/ready`, which answers 503 until the schema this function applies is
 * present and compatible. The wait then bridges the gap rather than assuming an order.
 */
export default function globalSetup(): void {
  requireTestDatabaseUrl();
  // Through vitest because `packages/database` is alias-resolved and cannot be loaded by bare Node. The suite it
  // runs asserts the migration set applies and the result is schema-compatible, so provisioning is itself a
  // certification step. See `e2e-database.postgres.test.ts`.
  execFileSync(
    'pnpm',
    ['vitest', 'run', '--config', 'vitest.postgres.config.ts', 'e2e/e2e-database.postgres.test.ts'],
    { stdio: 'inherit' },
  );
}
