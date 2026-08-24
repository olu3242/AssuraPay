import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import {
  applyAdvisory,
  controlsFor,
  evaluate,
  levelRank,
  type AiRecommendation,
  type GovernedFacts,
  type ReasonCode,
  type RequiredControls,
  type TrustLevel,
} from './policy';

export * from './policy';

/**
 * Progressive Trust & Adaptive Assurance — the record.
 *
 * `policy.ts` decides; this persists the decision in a form that can be audited and argued with years
 * later. §3 and §6 of the convergence brief require the recommendation, its confidence, its reason
 * codes, the model and prompt versions behind it, the policy result, the final level and any override
 * to all survive — so an assessment is a complete account of who said what and what actually decided.
 *
 * The assessment is **append-only**. A re-assessment is a new record that supersedes the previous one,
 * never a mutation: a trust level that could be edited after a release would make the release's
 * justification unfalsifiable, which is the opposite of what an assurance platform is for.
 */

export type TrustAssessmentErrorCode =
  | 'TRUST_FACTS_INVALID'
  | 'TRUST_ASSESSMENT_NOT_FOUND'
  | 'TRUST_OVERRIDE_BELOW_POLICY_FLOOR'
  | 'TRUST_OVERRIDE_REASON_REQUIRED'
  | 'TRUST_OVERRIDE_SELF_APPROVAL'
  | 'TRUST_ASSESSMENT_SUPERSEDED';

export class TrustAssessmentError extends Error {
  constructor(
    readonly code: TrustAssessmentErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TrustAssessmentError';
  }
}

/** An authorized human raising the level above what policy required. */
export type TrustOverride = {
  /** Never below the policy floor — enforced, not merely documented. */
  level: TrustLevel;
  reason: string;
  overriddenBy: string;
  overriddenAt: string;
};

export type TrustAssessment = {
  id: string;
  workspaceId: string;
  /** What is being assessed: an agreement, a milestone, a release request. */
  subjectType: string;
  subjectId: string;
  counterpartyId: string;
  facts: GovernedFacts;
  /** What the deterministic policy required, before any advisory input. */
  policyLevel: TrustLevel;
  policyReasonCodes: ReasonCode[];
  /** The advisory recommendation, recorded whether or not it changed anything. */
  recommendation?: AiRecommendation;
  advisoryApplied: boolean;
  advisoryDisregardedReason?: string;
  override?: TrustOverride;
  /** The level that governs. `max(policyLevel, advisory, override)` by construction. */
  effectiveLevel: TrustLevel;
  controls: RequiredControls;
  status: 'ACTIVE' | 'SUPERSEDED';
  assessedBy: string;
  correlationId: string;
  createdAt: string;
};

const MONEY_FIELDS = [
  'transactionValueMinor',
  'cumulativeExposureMinor',
  'activeExposureMinor',
] as const satisfies readonly (keyof GovernedFacts)[];

const COUNT_FIELDS = [
  'relationshipMaturityDays',
  'priorCompletedAgreements',
  'disputeCount',
  'settlementsOnTime',
  'settlementsLateOrFailed',
  'complexityScore',
  'anomalyCount',
] as const satisfies readonly (keyof GovernedFacts)[];

/**
 * Refuses facts that cannot be true.
 *
 * Checked here rather than trusted from a caller because a level is only as defensible as the numbers
 * behind it: a negative exposure or a fractional dispute count would produce a level that is arithmetically
 * valid and meaningless. Money is minor units and integral, matching `202608110018`'s treatment of every
 * money column in the schema — a fractional kobo is refused rather than rounded.
 */
function assertFacts(facts: GovernedFacts): void {
  for (const field of MONEY_FIELDS) {
    const value = facts[field];
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TrustAssessmentError(
        'TRUST_FACTS_INVALID',
        `${field} must be a non-negative integer of minor units`,
      );
  }
  for (const field of COUNT_FIELDS) {
    const value = facts[field];
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TrustAssessmentError('TRUST_FACTS_INVALID', `${field} must be a non-negative integer`);
  }
}

function assertRecommendation(recommendation: AiRecommendation | undefined): void {
  if (!recommendation) return;
  if (!Number.isFinite(recommendation.confidence) || recommendation.confidence < 0 || recommendation.confidence > 1)
    throw new TrustAssessmentError('TRUST_FACTS_INVALID', 'recommendation confidence must be within 0..1');
  // A recommendation with no reason is not advice, it is an assertion — and an assertion from a model is
  // exactly what this design refuses to act on.
  if (recommendation.reasonCodes.length === 0)
    throw new TrustAssessmentError('TRUST_FACTS_INVALID', 'recommendation must carry at least one reason code');
  for (const field of ['agentId', 'modelId', 'modelVersion', 'promptVersion', 'capabilityVersion'] as const)
    if (!recommendation[field]?.trim())
      throw new TrustAssessmentError(
        'TRUST_FACTS_INVALID',
        `recommendation must name ${field} so the decision can be replayed`,
      );
}

export class ProgressiveTrustEngine {
  constructor(private readonly store: TrustPersistence) {}

  /**
   * Assesses a subject and supersedes any previous active assessment of it.
   *
   * The recommendation is passed in rather than fetched, because this engine must not depend on the
   * agent runtime: Progressive Trust has to work identically whether an agent ran, ran and was
   * disregarded, or was never configured at all. A deployment with no model provider — which is every
   * deployment of this repository today — still gets a fully governed level.
   */
  async assess(
    context: RequestContext,
    input: {
      subjectType: string;
      subjectId: string;
      counterpartyId: string;
      facts: GovernedFacts;
      recommendation?: AiRecommendation;
    },
  ): Promise<TrustAssessment> {
    requireActiveWorkspace(context);
    assertFacts(input.facts);
    assertRecommendation(input.recommendation);

    const policy = evaluate(input.facts);
    const advisory = applyAdvisory(policy.level, input.recommendation);

    const assessment: TrustAssessment = {
      id: randomUUID(),
      workspaceId: context.activeWorkspaceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      counterpartyId: input.counterpartyId,
      facts: input.facts,
      policyLevel: policy.level,
      policyReasonCodes: policy.reasonCodes,
      recommendation: input.recommendation,
      advisoryApplied: advisory.advisoryApplied,
      advisoryDisregardedReason: advisory.advisoryDisregardedReason,
      effectiveLevel: advisory.level,
      controls: controlsFor(advisory.level),
      status: 'ACTIVE',
      assessedBy: context.actorUserId,
      correlationId: context.correlationId,
      createdAt: new Date().toISOString(),
    };

    await this.supersedePrevious(context, input.subjectType, input.subjectId);
    await this.store.append('trustAssessments', assessment);
    await this.store.audit({
      actorId: context.actorUserId,
      workspaceId: context.activeWorkspaceId,
      tenantId: context.tenantId,
      eventType: 'TrustAssessed',
      aggregateType: 'TrustAssessment',
      aggregateId: assessment.id,
      correlationId: context.correlationId,
      // The disagreement is the interesting part, so it is audited explicitly rather than left to be
      // reconstructed by comparing two fields.
      metadata: {
        policyLevel: assessment.policyLevel,
        effectiveLevel: assessment.effectiveLevel,
        advisoryApplied: assessment.advisoryApplied,
        recommendedLevel: input.recommendation?.recommendedLevel,
        agentId: input.recommendation?.agentId,
      },
    });
    return assessment;
  }

  /**
   * Raises the level above what policy required.
   *
   * Three refusals, and each closes a different hole. An override may not go **below** the policy floor —
   * that is the whole guarantee of this module, and an override that could lower a level would hand
   * back everything the deterministic policy exists to hold. It may not be applied by the person who
   * produced the assessment, matching `HumanApprovalEngine`'s refusal of self-approval. And it must
   * carry a reason, because an unexplained escalation is indistinguishable from a mistake later.
   */
  async override(
    context: RequestContext,
    assessmentId: string,
    input: { level: TrustLevel; reason: string },
  ): Promise<TrustAssessment> {
    requireActiveWorkspace(context);
    const assessment = await this.require(context, assessmentId);

    if (assessment.status !== 'ACTIVE')
      throw new TrustAssessmentError('TRUST_ASSESSMENT_SUPERSEDED', assessmentId);
    if (!input.reason?.trim())
      throw new TrustAssessmentError('TRUST_OVERRIDE_REASON_REQUIRED');
    if (assessment.assessedBy === context.actorUserId)
      throw new TrustAssessmentError('TRUST_OVERRIDE_SELF_APPROVAL', assessmentId);
    if (levelRank(input.level) < levelRank(assessment.policyLevel))
      throw new TrustAssessmentError(
        'TRUST_OVERRIDE_BELOW_POLICY_FLOOR',
        `policy requires ${assessment.policyLevel}`,
      );

    const overridden: TrustAssessment = {
      ...assessment,
      override: {
        level: input.level,
        reason: input.reason,
        overriddenBy: context.actorUserId,
        overriddenAt: new Date().toISOString(),
      },
      effectiveLevel: input.level,
      controls: controlsFor(input.level),
    };
    await this.store.replace('trustAssessments', overridden);
    await this.store.audit({
      actorId: context.actorUserId,
      workspaceId: context.activeWorkspaceId,
      tenantId: context.tenantId,
      eventType: 'TrustOverridden',
      aggregateType: 'TrustAssessment',
      aggregateId: assessmentId,
      correlationId: context.correlationId,
      metadata: { from: assessment.effectiveLevel, to: input.level, reason: input.reason },
    });
    return overridden;
  }

  /** The assessment that currently governs a subject, if any. */
  async active(
    context: RequestContext,
    subjectType: string,
    subjectId: string,
  ): Promise<TrustAssessment | undefined> {
    requireActiveWorkspace(context);
    return (await this.store.list<TrustAssessment>('trustAssessments')).find(
      (entry) =>
        entry.workspaceId === context.activeWorkspaceId &&
        entry.subjectType === subjectType &&
        entry.subjectId === subjectId &&
        entry.status === 'ACTIVE',
    );
  }

  private async require(context: RequestContext, id: string): Promise<TrustAssessment> {
    requireActiveWorkspace(context);
    const found = (await this.store.list<TrustAssessment>('trustAssessments')).find(
      (entry) => entry.id === id && entry.workspaceId === context.activeWorkspaceId,
    );
    if (!found) throw new TrustAssessmentError('TRUST_ASSESSMENT_NOT_FOUND', id);
    return found;
  }

  private async supersedePrevious(
    context: RequestContext,
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    requireActiveWorkspace(context);
    const previous = (await this.store.list<TrustAssessment>('trustAssessments')).filter(
      (entry) =>
        entry.workspaceId === context.activeWorkspaceId &&
        entry.subjectType === subjectType &&
        entry.subjectId === subjectId &&
        entry.status === 'ACTIVE',
    );
    for (const entry of previous)
      await this.store.replace('trustAssessments', { ...entry, status: 'SUPERSEDED' as const });
  }
}
