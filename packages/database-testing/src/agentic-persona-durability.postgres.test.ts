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
 * persistence boundary underneath that registry: a scoped persona profile written
 * through one PostgresTrustStore survives creation of a second store instance.
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

describe('integration: Agentic OS persona profiles are durable', () => {
  it('routes personaAgentProfiles through the durable trust store', () => {
    expect(POSTGRES_TRUST_COLLECTIONS).toContain('personaAgentProfiles');
  });

  it('survives a fresh store instance and preserves tenant/workspace scope', async () => {
    const database = await createTestDatabase({ applyRls: false });
    databases.push(database);

    const firstStore = new PostgresTrustStore(database.sql);
    await withTrustScope({ tenantId: TENANT, actorId: ACTOR }, () =>
      firstStore.append('trustWorkspaces', {
        id: WORKSPACE,
        tenantId: TENANT,
        name: 'Agentic Persona Workspace',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );

    const profile = {
      id: 'persona-buyer-v1',
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      persona: 'BUYER',
      name: 'Buyer Assurance Agent',
      mission: 'Protect the buyer from paying for unproven performance.',
      registeredAgentId: 'agent-buyer-v1',
      promptId: 'prompt-buyer-v1',
      capabilityId: 'cap-buyer-assurance',
      autonomyLevel: 2,
      allowedRoles: ['BUYER', 'ORG_ADMIN'],
      allowedActionClasses: ['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE'],
      maxRisk: 'HIGH',
      active: false,
      version: 1,
      createdAt: new Date().toISOString(),
    };

    await withTrustScope(scope, () => firstStore.append('personaAgentProfiles', profile));
    await withTrustScope(scope, () =>
      firstStore.replace('personaAgentProfiles', { ...profile, active: true }),
    );

    // New store instance models a process restart: no state can be inherited from
    // the first PostgresTrustStore object.
    const secondStore = new PostgresTrustStore(database.sql);
    const rows = await withTrustScope(scope, () =>
      secondStore.list<typeof profile>('personaAgentProfiles'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: profile.id,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      persona: 'BUYER',
      active: true,
      version: 1,
    });
  });
});
