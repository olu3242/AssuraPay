import path from 'node:path';

/** Explicit deployment paths must be absolute; local execution is package-relative. */
export function resolveMigrationsDirectory(
  environment: Record<string, string | undefined> = process.env,
  moduleDirectory: string = __dirname,
): string {
  const configured = environment.ASSURAPAY_MIGRATIONS_DIRECTORY;
  if (configured !== undefined) {
    if (!configured.trim() || !path.isAbsolute(configured))
      throw new Error('RUNTIME_MIGRATIONS_DIRECTORY_INVALID');
    return path.normalize(configured);
  }
  return path.resolve(moduleDirectory, '../../../supabase/migrations');
}
