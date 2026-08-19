/**
 * Where the browser suites' database lives.
 *
 * Derived here and used by `playwright.config.ts` alone, which both provisions the database and starts the
 * application against it. That consolidation is deliberate: the first version of this harness split the two
 * across a `globalSetup` file, and Playwright launched the web server before global setup had created the
 * database — the runtime logged `RUNTIME_DATABASE_UNREACHABLE: database "assurapay_e2e" does not exist` and
 * readiness stayed 503, a failure that reads like a runtime defect rather than an ordering mistake.
 *
 * A fixed database name rather than one keyed on the process id, so a run's database is predictable from the
 * environment alone. It is dropped and recreated on every run, so a stale database cannot leak rows into one.
 */

const E2E_DATABASE = 'assurapay_e2e';

/** The instance the suites provision inside. Required — the browser gate must never pass by skipping. */
export function requireTestDatabaseUrl(): string {
  const base = process.env.ASSURAPAY_TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      'ASSURAPAY_TEST_DATABASE_URL is required for browser certification. It names the PostgreSQL instance the ' +
        'suites provision a database inside; the durable runtime refuses to start without one.',
    );
  return base;
}

/** The same URL with the database name replaced. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function e2eDatabaseName(): string {
  return E2E_DATABASE;
}

/** The URL the application under test is started with. */
export function e2eDatabaseUrl(): string {
  return withDatabase(requireTestDatabaseUrl(), E2E_DATABASE);
}

/** The administrative URL, for creating and dropping the database above. */
export function adminDatabaseUrl(): string {
  return withDatabase(requireTestDatabaseUrl(), 'postgres');
}
