import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresTrustStore,
  POSTGRES_TRUST_COLLECTIONS,
  withTrustScope,
} from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * PostgreSQL certification for Agentic OS persona assignments.
 *
 * Registry behavior is covered in @assurapay/agent-runtime. This suite proves the
 * persistence boundary underneath that registry: canonical collection writes survive
 * restart and are projected into the dedicated relational table whose constraints are
 * authoritative for versioning and active-profile uniqueness.
 */
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

describe('integration: Agentic OS persona profiles are relationally durable', () => {
  it('routes personaAgentProfiles through the durable trust store', () => {
    expect(POSTGRES_TRUST_COLLECTIONS).toContain('personaAgentProfiles');
  });

  it('survives a fresh store instance and projects the profile into the relational table', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const firstStore = await seedWorkspace(database);
    const buyer = profile('persona-buyer-v1', 1);

    await withTrustScope(scope, () => firstStore.append('personaAgentProfiles', buyer));
    await withTrustScope(scope, () =>
      firstStore.replace('personaAgentProfiles', { ...buyer, active: true }),
    );

    // New store instance models a process restart: no state can be inherited from
    // the first PostgresTrustStore object.
    const secondStore = new PostgresTrustStore(database.sql);
    const rows = await withTrustScope(scope, () =>
      secondStore.list<typeof buyer>('personaAgentProfiles'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: buyer.id,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      persona: 'BUYER',
      active: true,
      version: 1,
    });

    const relational = await withTrustScope(scope, () =>
      database.sql<{ id: string; active: boolean; version: number }[]>`
        SELECT id, active, version FROM persona_agent_profiles WHERE id = ${buyer.id}
      `,
    );
    expect(relational).toEqual([{ id: buyer.id, active: true, version: 1 }]);
  });

  it('allows only one active profile for a persona/specialization scope', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const store = await seedWorkspace(database);
    const v1 = profile('persona-buyer-v1-unique', 1, true);
    const v2 = profile('persona-buyer-v2-unique', 2, true);

    await withTrustScope(scope, () => store.append('personaAgentProfiles', v1));
    await expect(withTrustScope(scope, () => store.append('personaAgentProfiles', v2))).rejects.toThrow();
  });

  it('refuses semantic mutation of an existing profile; new configuration requires a new version', async () => {
    const database = await createTestDatabase({ applyAllMigrations: true });
    databases.push(database);
    const store = await seedWorkspace(database);
    const v1 = profile('persona-buyer-v1-immutable', 1, false);

    await withTrustScope(scope, () => store.append('personaAgentProfiles', v1));
    await expect(
      withTrustScope(scope, () =>
        store.replace('personaAgentProfiles', { ...v1, mission: 'Changed mission', active: true }),
      ),
    ).rejects.toThrow();
  });
});
