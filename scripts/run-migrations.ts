import { applyMigrations, createPostgresPool } from '@assurapay/database';
import {
  loadPersistenceConfig,
  resolveMigrationsDirectory,
} from '@assurapay/runtime';

async function main(): Promise<void> {
  const config = loadPersistenceConfig(process.env);
  if (config.adapter !== 'postgres' || !config.databaseUrl)
    throw new Error('MIGRATION_DATABASE_REQUIRED');
  const directory = resolveMigrationsDirectory(process.env);
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    ssl: config.ssl,
    max: 1,
    connectTimeoutSeconds: config.connectTimeoutSeconds,
    statementTimeoutSeconds: config.statementTimeoutSeconds,
    applicationName: 'assurapay-migrations',
  });
  try {
    const results = await applyMigrations(pool.sql, directory, {
      appliedBy: 'assurapay-deployment',
    });
    process.stdout.write(
      JSON.stringify({
        code: 'MIGRATIONS_APPLIED',
        applied: results.filter((result) => result.applied).length,
        total: results.length,
      }) + '\n',
    );
  } finally {
    await pool.dispose();
  }
}

void main().catch((error: unknown) => {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : '';
  const code = /^[A-Z][A-Z_]+$/.test(candidate)
    ? candidate
    : 'MIGRATION_COMMAND_FAILED';
  process.stderr.write(JSON.stringify({ code }) + '\n');
  process.exitCode = 1;
});
