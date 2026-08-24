import { afterEach, describe, expect, it } from 'vitest';
import { PostgresTrustStore, withTrustScope } from '@assurapay/database';
import { ProgressiveTrustEngine, type GovernedFacts, type TrustAssessment } from '@assurapay/progressive-trust';
import type { RequestContext } from '@assurapay/shared';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Progressive Trust survives the durable store and its tenancy boundary.
 *
 * §11 of the convergence brief is explicit that an in-memory pass is not certification, and the reason
 * is specific rather than ceremonial: a trust level is the record that justifies releasing money, so
 * "it worked in a Map" is the weakest possible evidence for the one decision that most needs to be
 * defensible years later.
 *
 * What these probes add over `assessment.test.ts`, which covers the same engine against
 * `InMemoryTrustStore`: the record round-trips through `trust_records` with its nested facts, reason
 * codes and controls intact; supersession is durable rather than an artefact of object identity; and
 * one tenant's assessments are invisible to another under forced row-level security.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

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

function facts(overrides: Partial<GovernedFacts> = {}): GovernedFacts {
  return {
    transactionValueMinor: 100_00,
    cumulativeExposureMinor: 0,
    activeExposureMinor: 0,
    relationshipMaturityDays: 200,
    kybStatus: 'VERIFIED',
    kycStatus: 'VERIFIED',
    priorCompletedAgreements: 3,
    disputeCount: 0,
    settlementsOnTime: 3,
    settlementsLateOrFailed: 0,
    complexityScore: 1,
    crossBorder: false,
    anomalyCount: 0,
    evidenceQuality: 'STRONG',
    ...overrides,
  };
}

/** A schema with the trust store and its tenancy boundary, and the two tenants seeded. */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
  databases.push(database);

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

const subject = { subjectType: 'ReleaseRequest', subjectId: 'release-1', counterpartyId: 'party-1' };

describe('integration: a trust assessment is durable', () => {
  it('round-trips facts, reason codes and controls through PostgreSQL', async () => {
    const database = await seededDatabase();
    const trust = new ProgressiveTrustEngine(new PostgresTrustStore(database.sql));

    const written = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId },
      () =>
        trust.assess(context(TENANT_A), {
          ...subject,
          facts: facts({ transactionValueMinor: 600_000_00, crossBorder: true }),
          recommendation: {
            agentId: 'Risk',
            recommendedLevel: 'L4_CONTROLLED',
            confidence: 0.91,
            reasonCodes: ['SANCTIONS_ADJACENT'],
            modelId: 'sandbox',
            modelVersion: '1',
            promptVersion: '1',
            capabilityVersion: '1',
          },
        }),
    );

    const read = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId },
      () => trust.active(context(TENANT_A), subject.subjectType, subject.subjectId),
    );

    // Value alone already requires the maximum, so there is nothing for the agent to add — and the
    // record has to show that the agent was heard and made no difference.
    expect(read?.policyLevel).toBe('L4_CONTROLLED');
    expect(read?.effectiveLevel).toBe('L4_CONTROLLED');
    expect(read?.advisoryApplied).toBe(false);
    expect(read?.advisoryDisregardedReason).toBe('RECOMMENDATION_NOT_STRICTER_THAN_POLICY');
    // The nested structures survive the jsonb round trip rather than arriving as `[object Object]`.
    expect(read?.facts.transactionValueMinor).toBe(600_000_00);
    expect(read?.controls.enhancedDueDiligenceRequired).toBe(true);
    expect(read?.policyReasonCodes.map((reason) => reason.code)).toContain('VALUE_VERY_HIGH');
    expect(read?.recommendation?.reasonCodes).toEqual(['SANCTIONS_ADJACENT']);
    expect(read?.id).toBe(written.id);
  });

  it('supersedes durably, leaving one active assessment and the earlier facts intact', async () => {
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);
    const trust = new ProgressiveTrustEngine(store);
    const scope = { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId };

    await withTrustScope(scope, () => trust.assess(context(TENANT_A), { ...subject, facts: facts() }));
    await withTrustScope(scope, () =>
      trust.assess(context(TENANT_A), { ...subject, facts: facts({ disputeCount: 4 }) }),
    );

    const all = await withTrustScope(scope, () => store.list<TrustAssessment>('trustAssessments'));
    expect(all).toHaveLength(2);
    expect(all.filter((entry) => entry.status === 'ACTIVE')).toHaveLength(1);
    expect(all.find((entry) => entry.status === 'SUPERSEDED')?.facts.disputeCount).toBe(0);
    expect(all.find((entry) => entry.status === 'ACTIVE')?.effectiveLevel).toBe('L4_CONTROLLED');
  });

  it('refuses an override below the policy floor against the durable record', async () => {
    // The same refusal as the in-memory suite, re-proved here because it is the guarantee the whole
    // module exists for and it now has to survive a read-modify-write across a real transaction.
    const database = await seededDatabase();
    const trust = new ProgressiveTrustEngine(new PostgresTrustStore(database.sql));
    const scope = { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId };

    const assessment = await withTrustScope(scope, () =>
      trust.assess(context(TENANT_A), { ...subject, facts: facts({ kybStatus: 'FAILED' }) }),
    );
    expect(assessment.policyLevel).toBe('L4_CONTROLLED');

    await expect(
      withTrustScope(scope, () =>
        trust.override(context(TENANT_A, 'user-reviewer'), assessment.id, {
          level: 'L1_STANDARD',
          reason: 'known counterparty',
        }),
      ),
    ).rejects.toThrow('TRUST_OVERRIDE_BELOW_POLICY_FLOOR');

    const still = await withTrustScope(scope, () =>
      trust.active(context(TENANT_A), subject.subjectType, subject.subjectId),
    );
    expect(still?.effectiveLevel).toBe('L4_CONTROLLED');
  });

  it('records a durable override with its reason and reviewer', async () => {
    const database = await seededDatabase();
    const trust = new ProgressiveTrustEngine(new PostgresTrustStore(database.sql));
    const scope = { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId };

    const assessment = await withTrustScope(scope, () =>
      trust.assess(context(TENANT_A), { ...subject, facts: facts() }),
    );
    await withTrustScope(scope, () =>
      trust.override(context(TENANT_A, 'user-reviewer'), assessment.id, {
        level: 'L4_CONTROLLED',
        reason: 'related party under investigation',
      }),
    );

    const read = await withTrustScope(scope, () =>
      trust.active(context(TENANT_A), subject.subjectType, subject.subjectId),
    );
    expect(read?.effectiveLevel).toBe('L4_CONTROLLED');
    expect(read?.override?.overriddenBy).toBe('user-reviewer');
    // The policy's own finding is still there to be compared against the override.
    expect(read?.policyLevel).toBe('L1_STANDARD');
  });
});

describe('integration: assessments do not cross the tenancy boundary', () => {
  it('shows a tenant only its own assessments', async () => {
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);
    const trust = new ProgressiveTrustEngine(store);

    for (const tenant of [TENANT_A, TENANT_B])
      await withTrustScope(
        { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, actorId: tenant.userId },
        () =>
          trust.assess(context(tenant), {
            ...subject,
            subjectId: `release-${tenant.tenantId}`,
            facts: facts(),
          }),
      );

    const visibleToA = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId },
      () => store.list<TrustAssessment>('trustAssessments'),
    );
    expect(visibleToA).toHaveLength(1);
    expect(visibleToA[0].subjectId).toBe('release-tenant-a');
  });

  it('hides another tenant’s assessment from a lookup by subject', async () => {
    const database = await seededDatabase();
    const trust = new ProgressiveTrustEngine(new PostgresTrustStore(database.sql));

    await withTrustScope(
      { tenantId: TENANT_B.tenantId, workspaceId: TENANT_B.workspaceId, actorId: TENANT_B.userId },
      () => trust.assess(context(TENANT_B), { ...subject, facts: facts() }),
    );

    // Tenant A asks for the same subject id. Under forced RLS it must get nothing rather than B's row.
    const found = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: TENANT_A.userId },
      () => trust.active(context(TENANT_A), subject.subjectType, subject.subjectId),
    );
    expect(found).toBeUndefined();
  });
});
