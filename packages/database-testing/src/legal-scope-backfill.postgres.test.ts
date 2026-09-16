import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMigrations, readMigrations, PostgresTrustStore, withTrustScope } from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl, type TestDatabase } from './index';
requireTestDatabaseUrl();
let database: TestDatabase | undefined;
afterEach(async () => { await database?.dispose(); database = undefined; });

async function legacyDatabase() {
  database = await createTestDatabaseInstance();
  const migrations = readMigrations(migrationsDirectory());
  const correction = migrations.find(m => m.id === '20260915215154_legal_policy_scope_convergence')!;
  const directory = mkdtempSync(path.join(tmpdir(), 'assurapay-legal-backfill-'));
  try {
    for (const migration of migrations.filter(m => m.ordinal < correction.ordinal)) copyFileSync(migration.path, path.join(directory, path.basename(migration.path)));
    await applyMigrations(database.sql, directory, {appliedBy: 'legal-backfill-test'});
  } finally { rmSync(directory, {recursive: true, force: true}); }
  return {database, correction};
}

describe('integration: legal scope forward migration', () => {
  it('backfills a legacy unscoped version without changing its ID or content hash', async () => {
    const {database, correction} = await legacyDatabase();
    const store = new PostgresTrustStore(database.sql);
    const scope = {tenantId: 'legacy-tenant', workspaceId: 'legacy-workspace', actorId: 'legal'};
    await withTrustScope(scope, async () => {
      await store.append('trustWorkspaces', {id: scope.workspaceId, tenantId: scope.tenantId, status: 'ACTIVE', version: 1});
      await store.append('legalPolicies', {id: 'legacy-policy', workspaceId: scope.workspaceId, policyKey: 'terms'});
      await store.append('legalPolicyVersions', {id: 'legacy-version', legalPolicyId: 'legacy-policy', contentHash: 'a'.repeat(64), publicationStatus: 'PUBLISHED'});
    });
    await database.sql.begin(tx => tx.unsafe(correction.sql));
    expect(await store.list('legalPolicyVersions')).toEqual([]);
    await withTrustScope(scope, async () => {
      const [version] = await store.list<{id: string; tenantId: string; workspaceId: string; contentHash: string}>('legalPolicyVersions');
      expect(version).toMatchObject({id: 'legacy-version', tenantId: scope.tenantId, workspaceId: scope.workspaceId, contentHash: 'a'.repeat(64)});
      await store.replace('legalPolicyVersions', {...version, publicationStatus: 'SUPERSEDED'});
    });
  });
  it('refuses an orphan and rolls back temporary owner visibility', async () => {
    const {database, correction} = await legacyDatabase();
    await withTrustScope({tenantId: 'legacy-tenant', actorId: 'legal'}, () => new PostgresTrustStore(database.sql).append('legalPolicyVersions', {id: 'orphan-version', legalPolicyId: 'missing-policy'}));
    await expect(database.sql.begin(tx => tx.unsafe(correction.sql))).rejects.toThrow('LEGAL_POLICY_SCOPE_BACKFILL_REQUIRED');
    const [row] = await database.sql<{relforcerowsecurity: boolean}[]>`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'trust_records'::regclass`;
    expect(row.relforcerowsecurity).toBe(true);
  });
});
