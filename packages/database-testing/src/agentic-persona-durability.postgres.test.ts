import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresStoreError,
  PostgresTrustStore,
  POSTGRES_ROUTED_TABLES,
  POSTGRES_TRUST_COLLECTIONS,
  withTrustScope,
} from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT = 'tenant-agentic-persona';
const WORKSPACE = 'workspace-agentic-persona';
const ACTOR = 'persona-steward';
const scope = { tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR };

async function seedWorkspace(database: TestDatabase) {
  const store = new PostgresTrustStore(database.sql);
  await withTrustScope({ tenantId: TENANT, actorId: ACTOR }, () =>
    store.append('trustWorkspaces', {
      id: WORKSPACE,
      tenantId: TENANT,
      name: 'Agentic Persona Workspace',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      version: 1,
    }),
  );
  return store;
}

function profile(id: string, version: number, active = false) {
  return {
    id,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    persona: 'BUYER',
    name: `Buyer Assurance Agent v${version}`,
    mission: 'Protect the buyer from paying for unproven performance.',
    registeredAgentId: `agent-buyer-v${version}`,
    promptId: `prompt-buyer-v${version}`,
    capabilityId: 'cap-buyer-assurance',
    autonomyLevel: 2,
    allowedRoles: ['BUYER', 'ORG_ADMIN'],
    allowedActionClasses: ['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE'],
    maxRisk: 'HIGH',
    active,
    version,
    createdAt: new Date().toISOString(),
  };
}

describe('integration: Agentic OS persona profiles are directly relational', () => {
  it('declares the canonical collection and dedicated table as routed', () => {
    expect(POSTGRES_TRUST_COLLECTIONS).toContain('personaAgentProfiles');
    expect(POSTGRES_ROUTED_TABLES).toContain('persona_agent_profiles');
  });

  it('writes, activates, restarts, and reads only from the dedicated relational table', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const firstStore = await seedWorkspace(database);
    const buyer = profile('persona-buyer-v1', 1);

    await withTrustScope(scope, () => firstStore.append('personaAgentProfiles', buyer));
    await withTrustScope(scope, () => firstStore.replace('personaAgentProfiles', { ...buyer, active: true }));

    const [generic] = await database.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_records WHERE collection = 'personaAgentProfiles'
    `;
    expect(generic.n).toBe('0');

    const secondStore = new PostgresTrustStore(database.sql);
    const rows = await withTrustScope(scope, () => secondStore.list<typeof buyer>('personaAgentProfiles'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: buyer.id, tenantId: TENANT, workspaceId: WORKSPACE, persona: 'BUYER', active: true, version: 1 });

    const relational = await withTrustScope(scope, () =>
      database.sql<{ id: string; active: boolean; version: number }[]>`
        SELECT id, active, version FROM persona_agent_profiles WHERE id = ${buyer.id}
      `,
    );
    expect(relational).toEqual([{ id: buyer.id, active: true, version: 1 }]);
  });

  it('allows only one active profile for the same persona and specialization scope', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const store = await seedWorkspace(database);
    await withTrustScope(scope, () => store.append('personaAgentProfiles', profile('persona-buyer-v1-unique', 1, true)));
    await expect(withTrustScope(scope, () => store.append('personaAgentProfiles', profile('persona-buyer-v2-unique', 2, true))))
      .rejects.toMatchObject({ code: 'PERSISTENCE_DUPLICATE_RECORD' });
  });

  it('refuses semantic mutation and requires a new version', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const store = await seedWorkspace(database);
    const v1 = profile('persona-buyer-v1-immutable', 1, false);
    await withTrustScope(scope, () => store.append('personaAgentProfiles', v1));

    await expect(
      withTrustScope(scope, () => store.replace('personaAgentProfiles', { ...v1, mission: 'Changed mission', active: true })),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_HISTORY_IMMUTABLE' } satisfies Partial<PostgresStoreError>);
  });

  it('serializes concurrent activation so two versions cannot both become active', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const store = await seedWorkspace(database);
    const v1 = profile('persona-buyer-v1-concurrent', 1, false);
    const v2 = profile('persona-buyer-v2-concurrent', 2, false);
    await withTrustScope(scope, () => store.append('personaAgentProfiles', v1));
    await withTrustScope(scope, () => store.append('personaAgentProfiles', v2));

    const results = await Promise.allSettled([
      withTrustScope(scope, () => store.replace('personaAgentProfiles', { ...v1, active: true })),
      withTrustScope(scope, () => store.replace('personaAgentProfiles', { ...v2, active: true })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const active = await withTrustScope(scope, () => store.list<typeof v1>('personaAgentProfiles'));
    expect(active.filter((entry) => entry.active)).toHaveLength(1);
  });
});
