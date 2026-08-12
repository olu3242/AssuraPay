import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  DOMAIN_AGGREGATE_OWNERSHIP,
  PostgresDomainStore,
  withTrustScope,
} from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
const tenantA = { tenantId: 'tenant-domain-a', workspaceId: 'workspace-domain-a', actorId: 'buyer-a' };
const tenantB = { tenantId: 'tenant-domain-b', workspaceId: 'workspace-domain-b', actorId: 'buyer-b' };

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase() {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'domain-store-test' });
  return database;
}

describe('integration: PostgreSQL domain store', () => {
  it('owns every legacy browser snapshot collection explicitly', () => {
    expect(DOMAIN_AGGREGATE_OWNERSHIP).toHaveLength(35);
    expect(new Set(DOMAIN_AGGREGATE_OWNERSHIP).size).toBe(DOMAIN_AGGREGATE_OWNERSHIP.length);
  });

  it('survives a fresh store instance and isolates tenants through forced RLS', async () => {
    const database = await migratedDatabase();
    const first = new PostgresDomainStore(database.sql);
    await withTrustScope(tenantA, () => first.upsertContracts([{
      id: 'contract-domain-a', tenantId: tenantA.tenantId, workspaceId: tenantA.workspaceId,
      title: 'Durable agreement', status: 'DRAFT',
    }]));

    const fresh = new PostgresDomainStore(database.sql);
    const recovered = await withTrustScope(tenantA, () => fresh.getSnapshot());
    expect(recovered.contracts).toEqual([
      expect.objectContaining({ id: 'contract-domain-a', title: 'Durable agreement' }),
    ]);
    expect(await withTrustScope(tenantB, () => fresh.getSnapshot()))
      .toEqual(expect.objectContaining({ contracts: [] }));
  }, 300_000);

  it('rejects cross-tenant payloads before PostgreSQL is asked to persist them', async () => {
    const database = await migratedDatabase();
    const store = new PostgresDomainStore(database.sql);
    await expect(withTrustScope(tenantA, () => store.upsertContracts([{
      id: 'contract-domain-b', tenantId: tenantB.tenantId, workspaceId: tenantB.workspaceId,
    }]))).rejects.toMatchObject({ code: 'DOMAIN_STORE_SCOPE_REQUIRED' });
  }, 300_000);
});
