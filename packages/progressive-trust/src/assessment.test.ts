import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { ProgressiveTrustEngine, type TrustAssessment } from './index';
import type { AiRecommendation, GovernedFacts } from './policy';

/**
 * Progressive Trust — the assessment record.
 *
 * `policy.test.ts` proves the decision; this proves the account of it survives. The requirement these
 * assertions come from is §6 of the convergence brief: enough must persist to replay a decision and
 * argue with it later, including the recommendation that was *not* acted on.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-assessor',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    memberships: ['workspace-1'],
    correlationId: 'corr-1',
    ...overrides,
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

function recommendation(overrides: Partial<AiRecommendation> = {}): AiRecommendation {
  return {
    agentId: 'Risk',
    recommendedLevel: 'L3_ENHANCED',
    confidence: 0.9,
    reasonCodes: ['UNUSUAL_BENEFICIARY_PATTERN'],
    modelId: 'sandbox',
    modelVersion: '1',
    promptVersion: '1',
    capabilityVersion: '1',
    ...overrides,
  };
}

function engine() {
  const store = new InMemoryTrustStore();
  return { store, trust: new ProgressiveTrustEngine(store) };
}

const subject = { subjectType: 'ReleaseRequest', subjectId: 'release-1', counterpartyId: 'party-1' };

describe('an assessment is a complete account of the decision', () => {
  it('records the policy level, the effective level and the controls', async () => {
    const { trust } = engine();
    const assessment = await trust.assess(context(), { ...subject, facts: facts() });

    expect(assessment.policyLevel).toBe('L1_STANDARD');
    expect(assessment.effectiveLevel).toBe('L1_STANDARD');
    expect(assessment.controls.manualReleaseRequired).toBe(false);
    expect(assessment.policyReasonCodes.length).toBeGreaterThan(0);
    expect(assessment.status).toBe('ACTIVE');
  });

  it('records a recommendation that was acted on, with its model and prompt versions', async () => {
    const { trust } = engine();
    const assessment = await trust.assess(context(), {
      ...subject,
      facts: facts(),
      recommendation: recommendation(),
    });

    // Policy said L1; the agent said L3; one step is the most it may move.
    expect(assessment.policyLevel).toBe('L1_STANDARD');
    expect(assessment.effectiveLevel).toBe('L2_PROTECTED');
    expect(assessment.advisoryApplied).toBe(true);
    expect(assessment.recommendation?.modelVersion).toBe('1');
    expect(assessment.recommendation?.promptVersion).toBe('1');
  });

  it('records a recommendation that was disregarded, and why', async () => {
    // The disagreement is the part worth keeping: an auditor asking "did anything warn us" needs the
    // answer to survive even when the platform declined to act on the warning.
    const { trust } = engine();
    const assessment = await trust.assess(context(), {
      ...subject,
      facts: facts(),
      recommendation: recommendation({ confidence: 0.2 }),
    });

    expect(assessment.effectiveLevel).toBe('L1_STANDARD');
    expect(assessment.advisoryApplied).toBe(false);
    expect(assessment.advisoryDisregardedReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(assessment.recommendation?.reasonCodes).toEqual(['UNUSUAL_BENEFICIARY_PATTERN']);
  });

  it('audits the disagreement rather than only the outcome', async () => {
    const { store, trust } = engine();
    await trust.assess(context(), { ...subject, facts: facts(), recommendation: recommendation() });

    const audit = (await store.list<{ eventType: string; metadata: Record<string, unknown> }>(
      'auditRecords',
    )).find((entry) => entry.eventType === 'TrustAssessed');
    expect(audit?.metadata).toMatchObject({
      policyLevel: 'L1_STANDARD',
      effectiveLevel: 'L2_PROTECTED',
      advisoryApplied: true,
      recommendedLevel: 'L3_ENHANCED',
      agentId: 'Risk',
    });
  });
});

describe('assessments supersede rather than mutate', () => {
  it('leaves exactly one active assessment per subject', async () => {
    const { store, trust } = engine();
    await trust.assess(context(), { ...subject, facts: facts() });
    await trust.assess(context(), { ...subject, facts: facts({ anomalyCount: 1 }) });

    const all = await store.list<TrustAssessment>('trustAssessments');
    expect(all).toHaveLength(2);
    expect(all.filter((entry) => entry.status === 'ACTIVE')).toHaveLength(1);
    // The superseded record keeps its own facts and level: history is not rewritten to match the present.
    const superseded = all.find((entry) => entry.status === 'SUPERSEDED');
    expect(superseded?.facts.anomalyCount).toBe(0);
    expect((await trust.active(context(), 'ReleaseRequest', 'release-1'))?.effectiveLevel).toBe(
      'L3_ENHANCED',
    );
  });

  it('does not disturb another subject’s assessment', async () => {
    const { trust } = engine();
    await trust.assess(context(), { ...subject, facts: facts() });
    await trust.assess(context(), { ...subject, subjectId: 'release-2', facts: facts() });

    expect((await trust.active(context(), 'ReleaseRequest', 'release-1'))?.status).toBe('ACTIVE');
    expect((await trust.active(context(), 'ReleaseRequest', 'release-2'))?.status).toBe('ACTIVE');
  });
});

describe('an override may only ever tighten', () => {
  it('refuses a level below the policy floor', async () => {
    // The guarantee that makes the deterministic policy worth having. A reviewer who disagrees with
    // the floor may escalate; nobody may quietly lower it.
    const { trust } = engine();
    const assessment = await trust.assess(context(), {
      ...subject,
      facts: facts({ kybStatus: 'FAILED' }),
    });
    expect(assessment.policyLevel).toBe('L4_CONTROLLED');

    await expect(
      trust.override(context({ actorUserId: 'user-reviewer' }), assessment.id, {
        level: 'L1_STANDARD',
        reason: 'counterparty is known to us',
      }),
    ).rejects.toThrow('TRUST_OVERRIDE_BELOW_POLICY_FLOOR');
  });

  it('accepts a stricter level, and records who and why', async () => {
    const { trust } = engine();
    const assessment = await trust.assess(context(), { ...subject, facts: facts() });
    const overridden = await trust.override(context({ actorUserId: 'user-reviewer' }), assessment.id, {
      level: 'L4_CONTROLLED',
      reason: 'related party under investigation',
    });

    expect(overridden.effectiveLevel).toBe('L4_CONTROLLED');
    expect(overridden.controls.enhancedDueDiligenceRequired).toBe(true);
    expect(overridden.override?.overriddenBy).toBe('user-reviewer');
    expect(overridden.override?.reason).toBe('related party under investigation');
    // The policy's own finding is untouched, so "what did the rules say" survives the override.
    expect(overridden.policyLevel).toBe('L1_STANDARD');
  });

  it('refuses self-approval, matching the agent approval engine', async () => {
    const { trust } = engine();
    const assessment = await trust.assess(context(), { ...subject, facts: facts() });
    await expect(
      trust.override(context(), assessment.id, { level: 'L3_ENHANCED', reason: 'because' }),
    ).rejects.toThrow('TRUST_OVERRIDE_SELF_APPROVAL');
  });

  it('refuses an unexplained override', async () => {
    const { trust } = engine();
    const assessment = await trust.assess(context(), { ...subject, facts: facts() });
    await expect(
      trust.override(context({ actorUserId: 'user-reviewer' }), assessment.id, {
        level: 'L3_ENHANCED',
        reason: '   ',
      }),
    ).rejects.toThrow('TRUST_OVERRIDE_REASON_REQUIRED');
  });

  it('refuses to override a superseded assessment', async () => {
    const { trust } = engine();
    const first = await trust.assess(context(), { ...subject, facts: facts() });
    await trust.assess(context(), { ...subject, facts: facts() });

    await expect(
      trust.override(context({ actorUserId: 'user-reviewer' }), first.id, {
        level: 'L3_ENHANCED',
        reason: 'stale',
      }),
    ).rejects.toThrow('TRUST_ASSESSMENT_SUPERSEDED');
  });
});

describe('facts and recommendations are validated before they can decide anything', () => {
  it('refuses negative or fractional money', async () => {
    const { trust } = engine();
    for (const bad of [{ transactionValueMinor: -1 }, { transactionValueMinor: 100.5 }])
      await expect(
        trust.assess(context(), { ...subject, facts: facts(bad) }),
      ).rejects.toThrow('TRUST_FACTS_INVALID');
  });

  it('refuses a recommendation with no reason', async () => {
    const { trust } = engine();
    await expect(
      trust.assess(context(), {
        ...subject,
        facts: facts(),
        recommendation: recommendation({ reasonCodes: [] }),
      }),
    ).rejects.toThrow('TRUST_FACTS_INVALID');
  });

  it('refuses a recommendation that cannot be replayed', async () => {
    // No prompt version means the decision cannot be reproduced, which makes it evidence of nothing.
    const { trust } = engine();
    await expect(
      trust.assess(context(), {
        ...subject,
        facts: facts(),
        recommendation: recommendation({ promptVersion: '' }),
      }),
    ).rejects.toThrow('TRUST_FACTS_INVALID');
  });

  it('refuses an impossible confidence', async () => {
    const { trust } = engine();
    await expect(
      trust.assess(context(), {
        ...subject,
        facts: facts(),
        recommendation: recommendation({ confidence: 1.5 }),
      }),
    ).rejects.toThrow('TRUST_FACTS_INVALID');
  });

  it('requires an active workspace', async () => {
    const { trust } = engine();
    await expect(
      trust.assess(context({ activeWorkspaceId: undefined, memberships: [] }), {
        ...subject,
        facts: facts(),
      }),
    ).rejects.toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });
});
