import path from 'node:path';
import { applyMigrations, createPostgresPool } from '@assurapay/database';

const databaseUrl = process.env.ASSURAPAY_MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('ASSURAPAY_MIGRATION_DATABASE_URL is required for browser preparation');

const pool = createPostgresPool({ databaseUrl, applicationName: 'assurapay-browser-setup' });
try {
  await applyMigrations(pool.sql, path.resolve(process.cwd(), 'supabase/migrations'), {
    appliedBy: 'browser-certification',
  });
} finally {
  await pool.dispose();
}
