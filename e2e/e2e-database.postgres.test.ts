import { describe, expect, it } from 'vitest';
import { applyMigrations, createPostgresPool, verifySchemaCompatibility } from '@assurapay/database';
import { adminDatabaseUrl, e2eDatabaseName, e2eDatabaseUrl } from './database';

/**
 * Provisions the database the browser suites run against, and asserts it is one a host would start against.
 *
 * A vitest suite rather than a script, because there is no other runnable path to the governed migration runner.
 * `packages/database` is resolved by path alias in the vitest configs and its modules use extensionless relative
 * imports, so bare Node cannot load it — `node e2e/apply-migrations.ts` failed with ERR_MODULE_NOT_FOUND on
 * `./trust-store`. `scripts/run-migrations.js` is still the single `console.log` that `migrations.ts` describes. The
 * alternative was applying the SQL with `psql`, which would skip the ledger, the checksum verification and the
 * required-migration contract — and would therefore certify a schema built by a shortcut.
 *
 * So the provisioning step *is* an assertion: the browser gate cannot start until this suite has confirmed the
 * migration set applies and the result is schema-compatible. `playwright.config.ts` runs it before anything else.
 *
 * Its name ends in `.postgres.test.ts`, so the PostgreSQL config's include pattern picks it up and
 * `certify:postgres` runs it too. That is deliberate rather than
 * tolerated: dropping and recreating this database is idempotent, and a repository whose browser gate depends on
 * a provisioning path should exercise that path in the gate that owns PostgreSQL as well.
 */
describe('integration: the browser suites have a database a host would start against', () => {
  it('creates it, applies every migration through the governed runner, and reports compatible', async () => {
    const admin = createPostgresPool({
      databaseUrl: adminDatabaseUrl(),
      max: 1,
      applicationName: 'assurapay-e2e-provision',
    });
    try {
      // Backends first. A previous run's application may still hold connections — `next start` outlives the
      // Playwright process when a run is interrupted — and PostgreSQL refuses `DROP DATABASE` with
      // "database is being accessed by other users" rather than waiting. That failure aborted a whole browser
      // run for a reason two layers away from the suite that reported it.
      await admin.sql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${e2eDatabaseName()}' AND pid <> pg_backend_pid()`,
      );
      // Recreated every run, so a stale database cannot leak rows into a journey.
      await admin.sql.unsafe(`DROP DATABASE IF EXISTS ${e2eDatabaseName()}`);
      await admin.sql.unsafe(`CREATE DATABASE ${e2eDatabaseName()}`);
    } finally {
      await admin.dispose();
    }

    const target = createPostgresPool({
      databaseUrl: e2eDatabaseUrl(),
      max: 1,
      applicationName: 'assurapay-e2e-migrate',
    });
    try {
      const outcomes = await applyMigrations(target.sql, 'supabase/migrations', {
        appliedBy: 'browser-e2e',
      });
      expect(outcomes.filter((outcome) => outcome.applied).length).toBeGreaterThan(0);

      // The check readiness performs at startup. If this is not compatible, the application would refuse to
      // serve and every browser assertion would fail against a 503 — so it is asserted here, where the reason is
      // legible, rather than discovered as a timeout.
      const compatibility = await verifySchemaCompatibility(target.sql, 'supabase/migrations');
      expect(compatibility.pendingRequired).toEqual([]);
      expect(compatibility.divergent).toEqual([]);
      expect(compatibility.missingTables).toEqual([]);
      expect(compatibility.compatible).toBe(true);
    } finally {
      await target.dispose();
    }
  }, 300_000);
});
