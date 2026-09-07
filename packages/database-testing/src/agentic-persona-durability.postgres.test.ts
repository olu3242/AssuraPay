import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresTrustStore,
  POSTGRES_TRUST_COLLECTIONS,
  withTrustScope,
} from '@assurapay/database';
import { PersonaAgentRegistryEngine } from '@assurapay/agent-runtime/agentic-os';
import type { RequestContext } from '@assurapay/shared';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * PostgreSQL certification for the Agentic OS persona registry.
 *
 * A green in-memory test is not evidence that an active buyer/finance/risk agent
 * survives a process restart. This suite writes through one PostgresTrustStore,
 * discards that store object, then resolves through a second store against the same
 * database. The profile carries both tenant and workspace scope so the governed
 * trust_records RLS plane can enforce isolation in production.
 */
requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT = 'tenant-agentic-persona';
const WORKSPACE = 'workspace-agentic-persona';
const ACTOR = 'persona-steward';

const context: RequestContext = {
  actorUserId: ACTOR,
  sessionId: 'session-agentic-persona',
  identityAssuranceLevel: 'IAL2_VERIFIED',
  activeWorkspaceId: WORKSPACE,
  tenantId: TENANT,
  organizationId: 'org-agentic-persona',
  memberships: ['ORG_ADMIN'],
  correlationId: 'corr-agentic-persona',
};

const scope = { tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR };

describe('integration: Agentic OS persona registry is durable', () => {
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

    const firstRegistry = new PersonaAgentRegistryEngine(firstStore);
    const registered = await withTrustScope(scope, () =>
      firstRegistry.register(context, {
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
      }),
    );
    await withTrustScope(scope, () => firstRegistry.activate(context, registered.id));

    // A new store/registry pair models a process restart. No in-memory state from
    // the first registry is available to this object.
    const secondStore = new PostgresTrustStore(database.sql);
    const secondRegistry = new PersonaAgentRegistryEngine(secondStore);
    const resolved = await withTrustScope(scope, () =>
      secondRegistry.resolve(context, { persona: 'BUYER' }),
    );

    expect(resolved.id).toBe(registered.id);
    expect(resolved.active).toBe(true);
    expect(resolved.tenantId).toBe(TENANT);
    expect(resolved.workspaceId).toBe(WORKSPACE);
    expect(resolved.version).toBe(1);

    const audits = await secondStore.list<{ eventType: string; aggregateId: string }>('auditRecords');
    expect(audits.some((entry) => entry.eventType === 'PersonaAgentProfileRegistered' && entry.aggregateId === registered.id)).toBe(true);
    expect(audits.some((entry) => entry.eventType === 'PersonaAgentProfileActivated' && entry.aggregateId === registered.id)).toBe(true);
  });
});
