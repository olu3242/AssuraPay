import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readMigrations } from '@assurapay/database';
import { resolveMigrationsDirectory } from './migration-directory';

describe('deployment migration discovery', () => {
  it('reads the canonical migration set relative to the runtime package', () => {
    const directory = resolveMigrationsDirectory({}, __dirname);
    expect(directory).toBe(
      path.resolve(__dirname, '../../../supabase/migrations'),
    );
    expect(readMigrations(directory).length).toBeGreaterThan(0);
  });
  it('honors an absolute deployment path independently of the bundled module location', () => {
    const directory = path.resolve(__dirname, '../../../supabase/migrations');
    for (const location of ['.', 'apps/web', 'apps/web/.next/server/chunks']) {
      expect(
        resolveMigrationsDirectory(
          { ASSURAPAY_MIGRATIONS_DIRECTORY: directory },
          path.resolve(location),
        ),
      ).toBe(directory);
    }
  });
  it.each(['', ' ', 'supabase/migrations', '../migrations'])(
    'refuses ambiguous override %j',
    (directory) => {
      expect(() =>
        resolveMigrationsDirectory({
          ASSURAPAY_MIGRATIONS_DIRECTORY: directory,
        }),
      ).toThrow('RUNTIME_MIGRATIONS_DIRECTORY_INVALID');
    },
  );
});
