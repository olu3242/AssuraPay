import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTrustStore, withTrustScope } from '@assurapay/database';
import { registerAgentRuntime, type GatewayPolicy, type ModelProvider } from '@assurapay/agent-runtime';
import { ProgressiveTrustEngine } from '@assurapay/progressive-trust';
import { AgreementIntelligenceEngine } from '@assurapay/agreement-intelligence';
import { AtlasConvergenceService, type AtlasProposalRecord } from '@assurapay/agreement-atlas';
import type { RequestContext } from '@assurapay/shared';
import { applyMigrations } from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: the Atlas golden loop, against PostgreSQL with row-level security in force.
 *
 * §11 of the convergence brief refuses to certify a governed chain on in-memory stores, and the
 * reason is specific rather than ceremonial. The whole loop is a claim about what *persists*: that an
 * approval is single-use, that a digest ties an approval to the exact content published, and that one
 * tenant cannot reach another's proposal. Each of those is a property of the store, and "it worked in
 * a Map" is the weakest possible evidence for the one chain that ends in authoritative state.
 *
 * What this adds over `atlas.test.ts`, which covers the same service in memory: the proposal and its
 * nested parsed structure survive the jsonb round trip; approval consumption is durable rather than
 * an artefact of object identity, so replay is refused across a real transaction boundary; and a
 * second tenant is denied by the database rather than by a filter in application code.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const POLICY: GatewayPolicy = {
  allowedModels: ['sandbox'],
  maxRequestsPerMinute: 100,
  maxCostMinorPerInvocation: 1_000,
  retries: 0,
};

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b' };

function context(tenant: typeof TENANT_A, actorUserId = tenant.userId): RequestContext {
  return {
    actorUserId,
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: tenant.workspaceId,
    tenantId: tenant.tenantId,
    memberships: [tenant.workspaceId],
    correlationId: 'corr-1',
  };
}

const REFERENCE = [{ documentVersionId: 'v1', section: 'Scope' }];

const PAYLOAD = {
  proposal: {
    parties: [{ role: 'BUYER', legalName: 'Acme Ltd', confidence: 0.9, sourceReferences: REFERENCE }],
    obligations: [
      { owedBy: 'Acme Ltd', owedTo: 'Vendor', description: 'Pay on milestone', confidence: 0.9, sourceReferences: REFERENCE },
    ],
    milestones: [
      {
        reference: 'M1',
        title: 'Deliver phase one',
        completionCriteria: ['Signed handover'],
        evidenceRequirements: ['Handover certificate'],
        dependsOn: [],
        confidence: 0.9,
        sourceReferences: REFERENCE,
      },
    ],
    paymentTriggers: [
      { milestoneReference: 'M1', amountMinor: 500_00, currency: 'NGN', confidence: 0.9, sourceReferences: REFERENCE },
    ],
    risks: [],
  },
};

const provider: ModelProvider = {
  id: 'fake',
  async invoke() {
    return { output: PAYLOAD, inputTokens: 1, outputTokens: 1, costMinor: 0 };
  },
};

/**
 * A request per test, because the describe block shares one database.
 *
 * `publish` supersedes any earlier PUBLISHED version for the same contract, so tests sharing a
 * contract id would quietly depend on their own ordering.
 */
function requestFor(contractId: string) {
  return { ...request, contractId, contractVersionId: `${contractId}-v1` };
}

const request = {
  contractId: 'contract-1',
  contractVersionId: 'version-1',
  contentReference: 'secure://workspace-a/abc',
  contentHash: 'a'.repeat(64),
  counterpartyId: 'party-1',
};

/**
 * A database with the whole migration set applied, and the two tenants seeded.
 *
 * Its own database rather than its own schema, because the historical migration set is not
 * schema-relocatable — a SECURITY DEFINER function in it pins `search_path=public` — and Atlas needs
 * the Batch M agent tables, which only the full set creates. Row-level security is in force from the
 * first statement, so the tenant rows are seeded with FORCE lifted and restored immediately after.
 */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

  for (const table of ['trust_tenants', 'trust_workspaces'])
    await database.sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant.tenantId})`;
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${tenant.workspaceId}, ${tenant.tenantId}, 'ACTIVE', ${database.sql.json({ id: tenant.workspaceId })}, ${'0'.repeat(64)})
      `;
    }
  } finally {
    for (const table of ['trust_tenants', 'trust_workspaces'])
      await database.sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  return database;
}

/**
 * The contract version a published proposal must hang from.
 *
 * `agreement_intelligence_versions` has a foreign key to `contract_versions_v2`, so publishing
 * intelligence for a contract version that does not exist is refused by the database. That refusal is
 * correct — authoritative structure for a non-existent agreement would be worse than none — so the
 * fixture creates the agreement rather than the suite working around the constraint.
 */
async function seedContractVersion(database: TestDatabase, contractId: string): Promise<void> {
  await withTrustScope(scopeOf(TENANT_A), async () => {
    const store = new PostgresTrustStore(database.sql);
    await store.append('contractVersionsV2', {
      id: `${contractId}-v1`,
      workspaceId: TENANT_A.workspaceId,
      contractId,
      number: 1,
      kind: 'EXECUTED',
      documentReference: `vault://${contractId}/executed.pdf`,
      // Unique per workspace, enforced by `contract_versions_v2_ws_hash_unique`: two agreements
      // with the same document hash would be the same document.
      documentHash: createHash('sha256').update(contractId).digest('hex'),
      executionCertificateId: `ec-${contractId}`,
      status: 'ACTIVE',
      createdAt: '2026-08-18T09:00:00.000Z',
    });
  });
}

/** One database per describe block: a database per test exhausts the connection allowance. */
function sharedDatabase(): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () => (pending ??= seededDatabase());
}

function atlasFor(database: TestDatabase) {
  const store = new PostgresTrustStore(database.sql);
  const runtime = registerAgentRuntime(store, { providers: [provider], policy: POLICY });
  return {
    store,
    atlas: new AtlasConvergenceService({
      store,
      runtime: runtime.runtime,
      capabilities: runtime.capabilities,
      agents: runtime.agents,
      prompts: runtime.prompts,
      governance: runtime.governance,
      contexts: runtime.contexts,
      approvals: runtime.approvals,
      trust: new ProgressiveTrustEngine(store),
      publication: new AgreementIntelligenceEngine(store),
      model: 'sandbox',
    }),
  };
}

function scopeOf(tenant: typeof TENANT_A, actorId = tenant.userId) {
  return { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, actorId };
}

describe('integration: the governed chain completes against PostgreSQL', () => {
  const database = sharedDatabase();

  it('proposes, assesses, approves and publishes, all durably', async () => {
    const contractId = 'atlas-1';
    const live = await database();
    await seedContractVersion(live, contractId);
    const { atlas, store } = atlasFor(live);

    const bootstrap = await withTrustScope(scopeOf(TENANT_A), () => atlas.bootstrap(context(TENANT_A)));
    const proposed = await withTrustScope(scopeOf(TENANT_A), () =>
      atlas.propose(context(TENANT_A), { ...requestFor(contractId), bootstrap }),
    );

    // Link 1 and Link 2 survived the round trip, nested structure included — a jsonb column that
    // stored `[object Object]` would pass an in-memory suite and fail here.
    expect(proposed.proposal.milestones[0].completionCriteria).toEqual(['Signed handover']);
    expect(proposed.trustAssessmentId).toBeTruthy();
    expect(['L3_ENHANCED', 'L4_CONTROLLED']).toContain(proposed.trustLevel);

    // Link 3, by a different human.
    const approverScope = scopeOf(TENANT_A, 'user-reviewer');
    await withTrustScope(approverScope, () =>
      atlas.decide(context(TENANT_A, 'user-reviewer'), proposed.id, 'APPROVED'),
    );

    // Link 4.
    const published = await withTrustScope(approverScope, () =>
      atlas.publish(context(TENANT_A, 'user-reviewer'), proposed.id),
    );
    expect(published.status).toBe('PUBLISHED');

    const versions = await withTrustScope(approverScope, () =>
      store.list<{ id: string; status: string; items: Array<{ type: string }> }>('agreementIntelligenceVersions'),
    );
    const authoritative = versions.find((entry) => entry.id === published.publishedVersionId);
    expect(authoritative?.status).toBe('PUBLISHED');
    expect(new Set(authoritative?.items.map((item) => item.type))).toEqual(
      new Set(['PARTY', 'OBLIGATION', 'MILESTONE', 'PAYMENT_TRIGGER']),
    );
  });

  it('refuses to replay an approval across a real transaction boundary', async () => {
    const contractId = 'atlas-2';
    // Replay protection is a durability claim: the consumed marker has to be in the database, not in
    // a process that may have restarted between the two attempts.
    const live = await database();
    await seedContractVersion(live, contractId);
    const { atlas, store } = atlasFor(live);
    const scope = scopeOf(TENANT_A);
    const approverScope = scopeOf(TENANT_A, 'user-reviewer');

    const bootstrap = await withTrustScope(scope, () => atlas.bootstrap(context(TENANT_A)));
    const proposed = await withTrustScope(scope, () =>
      atlas.propose(context(TENANT_A), { ...requestFor(contractId), bootstrap }),
    );
    await withTrustScope(approverScope, () =>
      atlas.decide(context(TENANT_A, 'user-reviewer'), proposed.id, 'APPROVED'),
    );
    await withTrustScope(approverScope, () => atlas.publish(context(TENANT_A, 'user-reviewer'), proposed.id));

    // Rewind only the Atlas record, leaving the consumed approval durable.
    const stored = (await withTrustScope(approverScope, () =>
      store.list<AtlasProposalRecord>('atlasProposals'),
    )).find((entry) => entry.id === proposed.id)!;
    await withTrustScope(approverScope, () =>
      store.replace('atlasProposals', { ...stored, status: 'APPROVED', publishedVersionId: undefined }),
    );

    await expect(
      withTrustScope(approverScope, () => atlas.publish(context(TENANT_A, 'user-reviewer'), proposed.id)),
    ).rejects.toThrow('APPROVAL_ALREADY_CONSUMED');
  });

  it('refuses publication when the stored proposal no longer matches the approved digest', async () => {
    const contractId = 'atlas-3';
    const live = await database();
    await seedContractVersion(live, contractId);
    const { atlas, store } = atlasFor(live);
    const scope = scopeOf(TENANT_A);
    const approverScope = scopeOf(TENANT_A, 'user-reviewer');

    const bootstrap = await withTrustScope(scope, () => atlas.bootstrap(context(TENANT_A)));
    const proposed = await withTrustScope(scope, () =>
      atlas.propose(context(TENANT_A), { ...requestFor(contractId), bootstrap }),
    );
    await withTrustScope(approverScope, () =>
      atlas.decide(context(TENANT_A, 'user-reviewer'), proposed.id, 'APPROVED'),
    );

    const stored = (await withTrustScope(approverScope, () =>
      store.list<AtlasProposalRecord>('atlasProposals'),
    )).find((entry) => entry.id === proposed.id)!;
    await withTrustScope(approverScope, () =>
      store.replace('atlasProposals', {
        ...stored,
        proposal: {
          ...stored.proposal,
          paymentTriggers: [{ ...stored.proposal.paymentTriggers[0], amountMinor: 9_000_000_00 }],
        },
      }),
    );

    await expect(
      withTrustScope(approverScope, () => atlas.publish(context(TENANT_A, 'user-reviewer'), proposed.id)),
    ).rejects.toThrow('APPROVAL_PROPOSAL_MISMATCH');
  });
});

describe('integration: Atlas proposals do not cross the tenancy boundary', () => {
  const database = sharedDatabase();

  it('hides one tenant’s proposal from another under forced row-level security', async () => {
    const contractId = 'atlas-4';
    const live = await database();
    await seedContractVersion(live, contractId);
    const { atlas, store } = atlasFor(live);

    const bootstrap = await withTrustScope(scopeOf(TENANT_A), () => atlas.bootstrap(context(TENANT_A)));
    const proposed = await withTrustScope(scopeOf(TENANT_A), () =>
      atlas.propose(context(TENANT_A), { ...requestFor(contractId), bootstrap }),
    );

    // Tenant B asks for the same id. The database must refuse it, not an application-level filter.
    const visibleToB = await withTrustScope(scopeOf(TENANT_B), () =>
      store.list<AtlasProposalRecord>('atlasProposals'),
    );
    expect(visibleToB).toHaveLength(0);
    expect(await withTrustScope(scopeOf(TENANT_B), () => atlas.get(context(TENANT_B), proposed.id))).toBeUndefined();
  });

  it('refuses another tenant’s attempt to approve or publish', async () => {
    const contractId = 'atlas-5';
    const live = await database();
    await seedContractVersion(live, contractId);
    const { atlas } = atlasFor(live);

    const bootstrap = await withTrustScope(scopeOf(TENANT_A), () => atlas.bootstrap(context(TENANT_A)));
    const proposed = await withTrustScope(scopeOf(TENANT_A), () =>
      atlas.propose(context(TENANT_A), { ...requestFor(contractId), bootstrap }),
    );

    for (const act of ['decide', 'publish'] as const)
      await expect(
        withTrustScope(scopeOf(TENANT_B), () =>
          act === 'decide'
            ? atlas.decide(context(TENANT_B), proposed.id, 'APPROVED')
            : atlas.publish(context(TENANT_B), proposed.id),
        ),
        act,
      ).rejects.toThrow('ATLAS_PROPOSAL_NOT_FOUND');
  });
});
