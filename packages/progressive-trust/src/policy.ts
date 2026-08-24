/**
 * Progressive Trust & Adaptive Assurance — the deterministic policy.
 *
 * This module is the «policy evaluates» link of AssuraPay's governing rule:
 *
 *   AI proposes → **policy evaluates** → human approves where required →
 *   deterministic engines execute → audit records everything.
 *
 * Before it, that link did not exist. `docs/product/ASSURA_AI_CONVERGENCE_AUDIT.md` records the
 * measurement: no `L0_VERIFIED`, no `trustLevel`, no progressive-trust symbol anywhere in `packages/`,
 * `apps/` or `supabase/`. An agent recommendation therefore had nothing deterministic to be evaluated
 * against, which is why this was built before any agent was wired into the product — admitting advisory
 * output into a product that has no policy to constrain it is the failure mode the rule exists to prevent.
 *
 * ## The level is a function of governed facts, never of a model
 *
 * `evaluate()` is pure and total: the same facts always produce the same level, and every level comes
 * with the reason codes that produced it. There is no score, no weighting a model can influence, and no
 * path by which a confident recommendation becomes an authoritative level.
 *
 * An AI recommendation is an **input that can only ever raise scrutiny**. It is recorded in full —
 * recommended level, confidence, reason codes, model and prompt versions — and then bounded:
 *
 *   final = max(policyFloor, min(aiRecommendation, policyFloor + 1))
 *
 * so a model that sees something the facts do not can pull the transaction one level tighter, and a
 * model that is wrong, gamed, or hallucinating cannot loosen anything at all. `AI_LOWERED_NOTHING` is
 * asserted directly in the suite rather than left as a property of the arithmetic.
 *
 * ## Why "controls" and not just a number
 *
 * A level nothing acts on is decoration. Each level carries the controls it requires, so the decision
 * is legible to the engines that must honour it and to the auditor who must later ask why a payment
 * waited. The controls are deliberately expressed as capabilities of the existing platform —
 * independent review, dual approval, evidence thresholds — rather than as new machinery.
 */

/** The authoritative assurance levels, ordered from least to most controlled. */
export const TRUST_LEVELS = [
  'L0_VERIFIED',
  'L1_STANDARD',
  'L2_PROTECTED',
  'L3_ENHANCED',
  'L4_CONTROLLED',
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Ordinal position, so levels can be compared and bounded without exposing a score. */
export function levelRank(level: TrustLevel): number {
  return TRUST_LEVELS.indexOf(level);
}

function levelAt(rank: number): TrustLevel {
  return TRUST_LEVELS[Math.max(0, Math.min(TRUST_LEVELS.length - 1, rank))];
}

/** The stronger (more controlled) of two levels. */
export function strongerLevel(a: TrustLevel, b: TrustLevel): TrustLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

export type VerificationStatus = 'VERIFIED' | 'PENDING' | 'EXPIRED' | 'FAILED';
export type EvidenceQuality = 'STRONG' | 'ADEQUATE' | 'WEAK' | 'CONTESTED';

/**
 * The governed facts a level is computed from.
 *
 * Every field is something the platform already knows from a durable record — not a judgement, not a
 * model output, and not anything a caller can assert about itself. Money is minor units, per CLAUDE.md.
 */
export type GovernedFacts = {
  /** Value of the transaction under assessment, in minor units. */
  transactionValueMinor: number;
  /** Everything already released to this counterparty, in minor units. */
  cumulativeExposureMinor: number;
  /** Committed but not yet settled, in minor units — the amount actually at risk right now. */
  activeExposureMinor: number;
  /** Days since the relationship was established. */
  relationshipMaturityDays: number;
  kybStatus: VerificationStatus;
  kycStatus: VerificationStatus;
  /** Agreements completed with this counterparty without dispute. */
  priorCompletedAgreements: number;
  /** Disputes raised against this counterparty, ever. */
  disputeCount: number;
  /** Settlements that completed on time. */
  settlementsOnTime: number;
  /** Settlements that were late or failed. */
  settlementsLateOrFailed: number;
  /** Structural complexity of the agreement: milestones, dependencies, conditional triggers. */
  complexityScore: number;
  crossBorder: boolean;
  /** Anomalies raised by deterministic detectors on this transaction. */
  anomalyCount: number;
  evidenceQuality: EvidenceQuality;
};

/** A reason code and the fact that produced it. Every level carries at least one. */
export type ReasonCode = {
  code: string;
  detail: string;
  /** The level this single reason on its own would require. */
  contributes: TrustLevel;
};

/** What a level obliges the platform to do. Named for capabilities that already exist. */
export type RequiredControls = {
  independentReviewRequired: boolean;
  dualApprovalRequired: boolean;
  /** Evidence must be at least this strong before completion may be certified. */
  minimumEvidenceQuality: EvidenceQuality;
  /** Release is held until a human with release authority acts. */
  manualReleaseRequired: boolean;
  /** Settlement must be reconciled before the next milestone may start. */
  reconciliationBeforeNextMilestone: boolean;
  /** Enhanced due diligence on the counterparty before any release. */
  enhancedDueDiligenceRequired: boolean;
};

/**
 * The control table itself, frozen.
 *
 * This is process-global mutable state holding the obligations that keep money from moving without a
 * human, so it is worth being blunt about the failure it would otherwise permit: one assignment to the
 * object a caller was handed — `controls.manualReleaseRequired = false` — would disable manual release
 * for every L4 assessment in the process until restart, silently and with no audit record, because the
 * assessments already written would still claim the control was required. Freezing turns that into a
 * `TypeError` under strict mode (which every module here is, being ESM) instead of a policy change.
 */
const CONTROLS: Record<TrustLevel, Readonly<RequiredControls>> = {
  L0_VERIFIED: {
    independentReviewRequired: false,
    dualApprovalRequired: false,
    minimumEvidenceQuality: 'ADEQUATE',
    manualReleaseRequired: false,
    reconciliationBeforeNextMilestone: false,
    enhancedDueDiligenceRequired: false,
  },
  L1_STANDARD: {
    independentReviewRequired: false,
    dualApprovalRequired: false,
    minimumEvidenceQuality: 'ADEQUATE',
    manualReleaseRequired: false,
    reconciliationBeforeNextMilestone: false,
    enhancedDueDiligenceRequired: false,
  },
  L2_PROTECTED: {
    independentReviewRequired: true,
    dualApprovalRequired: false,
    minimumEvidenceQuality: 'ADEQUATE',
    manualReleaseRequired: false,
    reconciliationBeforeNextMilestone: true,
    enhancedDueDiligenceRequired: false,
  },
  L3_ENHANCED: {
    independentReviewRequired: true,
    dualApprovalRequired: true,
    minimumEvidenceQuality: 'STRONG',
    manualReleaseRequired: true,
    reconciliationBeforeNextMilestone: true,
    enhancedDueDiligenceRequired: false,
  },
  L4_CONTROLLED: {
    independentReviewRequired: true,
    dualApprovalRequired: true,
    minimumEvidenceQuality: 'STRONG',
    manualReleaseRequired: true,
    reconciliationBeforeNextMilestone: true,
    enhancedDueDiligenceRequired: true,
  },
};

for (const controls of Object.values(CONTROLS)) Object.freeze(controls);
Object.freeze(CONTROLS);

/**
 * The controls a level requires, as a fresh object the caller owns.
 *
 * A copy rather than the frozen original because the result is written into a `TrustAssessment` and
 * persisted, and a caller holding a shared frozen reference would either throw on an unrelated
 * assignment or silently alias the table across every assessment in the process. The copy is the
 * caller's; the table is nobody's.
 */
export function controlsFor(level: TrustLevel): RequiredControls {
  return { ...CONTROLS[level] };
}

/** An advisory recommendation. Recorded in full; authoritative for nothing. */
export type AiRecommendation = {
  agentId: string;
  recommendedLevel: TrustLevel;
  /** 0..1. A recommendation below `MINIMUM_ADVISORY_CONFIDENCE` is recorded and then ignored. */
  confidence: number;
  reasonCodes: string[];
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  capabilityVersion: string;
};

/**
 * Below this, a recommendation is recorded and disregarded.
 *
 * Fail-closed in the direction that matters: a low-confidence recommendation cannot raise a level
 * either, because acting on a model's uncertainty is how a level stops being explicable. The
 * recommendation stays in the record so the disagreement is auditable.
 */
export const MINIMUM_ADVISORY_CONFIDENCE = 0.7;

/** Money thresholds, in minor units (kobo). Stated here so a level can be explained by a number. */
const VALUE_L2 = 5_000_00;
const VALUE_L3 = 50_000_00;
const VALUE_L4 = 500_000_00;
const ACTIVE_EXPOSURE_L3 = 100_000_00;

/**
 * The deterministic decision.
 *
 * Reason codes accumulate; the floor is the strongest single reason. That is deliberate and is the
 * whole reason there is no score: a transaction is as controlled as its most serious fact requires,
 * and no quantity of mild reassurance can offset one disqualifying one. A failed KYB is not averaged
 * away by a long history.
 */
export function evaluate(facts: GovernedFacts): {
  level: TrustLevel;
  reasonCodes: ReasonCode[];
  controls: RequiredControls;
} {
  const reasons: ReasonCode[] = [];
  const add = (code: string, detail: string, contributes: TrustLevel) =>
    reasons.push({ code, detail, contributes });

  // Identity and business verification. A failure is disqualifying on its own — this is the fact that
  // must never be averaged against anything.
  if (facts.kybStatus === 'FAILED' || facts.kycStatus === 'FAILED')
    add('VERIFICATION_FAILED', 'KYB or KYC verification failed', 'L4_CONTROLLED');
  else if (facts.kybStatus === 'EXPIRED' || facts.kycStatus === 'EXPIRED')
    add('VERIFICATION_EXPIRED', 'KYB or KYC verification has expired', 'L3_ENHANCED');
  else if (facts.kybStatus === 'PENDING' || facts.kycStatus === 'PENDING')
    add('VERIFICATION_PENDING', 'KYB or KYC verification is not complete', 'L3_ENHANCED');
  else add('VERIFICATION_COMPLETE', 'KYB and KYC verified', 'L0_VERIFIED');

  // Value at stake.
  if (facts.transactionValueMinor >= VALUE_L4)
    add('VALUE_VERY_HIGH', `transaction value ${facts.transactionValueMinor} minor units`, 'L4_CONTROLLED');
  else if (facts.transactionValueMinor >= VALUE_L3)
    add('VALUE_HIGH', `transaction value ${facts.transactionValueMinor} minor units`, 'L3_ENHANCED');
  else if (facts.transactionValueMinor >= VALUE_L2)
    add('VALUE_MODERATE', `transaction value ${facts.transactionValueMinor} minor units`, 'L2_PROTECTED');

  // Exposure already carried. Active exposure matters more than cumulative: cumulative is history,
  // active is what is currently unrecoverable if this counterparty fails.
  if (facts.activeExposureMinor >= ACTIVE_EXPOSURE_L3)
    add('ACTIVE_EXPOSURE_HIGH', `active exposure ${facts.activeExposureMinor} minor units`, 'L3_ENHANCED');
  else if (facts.cumulativeExposureMinor >= VALUE_L4)
    add('CUMULATIVE_EXPOSURE_HIGH', `cumulative exposure ${facts.cumulativeExposureMinor} minor units`, 'L2_PROTECTED');

  // Relationship maturity and demonstrated performance. These can lower the floor only by being
  // absent from the reason list — they never subtract from another reason.
  if (facts.relationshipMaturityDays < 30)
    add('RELATIONSHIP_NEW', `relationship is ${facts.relationshipMaturityDays} days old`, 'L2_PROTECTED');

  if (facts.disputeCount > 0)
    add(
      facts.disputeCount >= 3 ? 'DISPUTES_REPEATED' : 'DISPUTES_PRESENT',
      `${facts.disputeCount} dispute(s) on record`,
      facts.disputeCount >= 3 ? 'L4_CONTROLLED' : 'L3_ENHANCED',
    );

  if (facts.settlementsLateOrFailed > 0) {
    const total = facts.settlementsOnTime + facts.settlementsLateOrFailed;
    const failureRate = facts.settlementsLateOrFailed / total;
    add(
      failureRate >= 0.25 ? 'SETTLEMENT_HISTORY_POOR' : 'SETTLEMENT_HISTORY_MIXED',
      `${facts.settlementsLateOrFailed} of ${total} settlements late or failed`,
      failureRate >= 0.25 ? 'L3_ENHANCED' : 'L2_PROTECTED',
    );
  }

  // Structure and jurisdiction.
  if (facts.complexityScore >= 8)
    add('COMPLEXITY_HIGH', `complexity score ${facts.complexityScore}`, 'L3_ENHANCED');
  else if (facts.complexityScore >= 4)
    add('COMPLEXITY_MODERATE', `complexity score ${facts.complexityScore}`, 'L2_PROTECTED');

  if (facts.crossBorder) add('CROSS_BORDER', 'cross-border settlement', 'L2_PROTECTED');

  // Signals from this transaction.
  if (facts.anomalyCount >= 3)
    add('ANOMALIES_MANY', `${facts.anomalyCount} anomalies detected`, 'L4_CONTROLLED');
  else if (facts.anomalyCount > 0)
    add('ANOMALIES_PRESENT', `${facts.anomalyCount} anomaly/anomalies detected`, 'L3_ENHANCED');

  if (facts.evidenceQuality === 'CONTESTED')
    add('EVIDENCE_CONTESTED', 'submitted evidence is contested', 'L4_CONTROLLED');
  else if (facts.evidenceQuality === 'WEAK')
    add('EVIDENCE_WEAK', 'submitted evidence is weak', 'L3_ENHANCED');

  // An established, clean, verified relationship is the only route to L0, and it is stated as its own
  // reason so that "why was this barely controlled" has an answer too.
  const established =
    facts.relationshipMaturityDays >= 365 &&
    facts.priorCompletedAgreements >= 10 &&
    facts.disputeCount === 0 &&
    facts.settlementsLateOrFailed === 0;
  if (established) add('RELATIONSHIP_ESTABLISHED', 'long, clean, verified relationship', 'L0_VERIFIED');

  // The floor is the strongest single reason, with L1 as the baseline for anything not established.
  const baseline: TrustLevel = established ? 'L0_VERIFIED' : 'L1_STANDARD';
  const level = reasons.reduce<TrustLevel>(
    (strongest, reason) => strongerLevel(strongest, reason.contributes),
    baseline,
  );

  return { level, reasonCodes: reasons, controls: controlsFor(level) };
}

/**
 * Bounds an advisory recommendation against the deterministic floor.
 *
 * Two rules, and both are one-directional:
 *
 *   1. A recommendation can never lower the level. `strongerLevel` guarantees it arithmetically and
 *      `AI_LOWERED_NOTHING` asserts it behaviourally.
 *   2. A recommendation can raise the level by at most one step. An agent that sees something the facts
 *      do not deserves to be heard; an agent that is wrong, prompt-injected or gamed should not be able
 *      to escalate a routine transaction to maximum control and stall the platform. One step is enough
 *      to route a human at it, which is the point of advisory output.
 *
 * A recommendation below `MINIMUM_ADVISORY_CONFIDENCE` is recorded and disregarded entirely.
 */
export function applyAdvisory(
  policyLevel: TrustLevel,
  recommendation: AiRecommendation | undefined,
): { level: TrustLevel; advisoryApplied: boolean; advisoryDisregardedReason?: string } {
  if (!recommendation) return { level: policyLevel, advisoryApplied: false };

  if (recommendation.confidence < MINIMUM_ADVISORY_CONFIDENCE)
    return {
      level: policyLevel,
      advisoryApplied: false,
      advisoryDisregardedReason: 'CONFIDENCE_BELOW_THRESHOLD',
    };

  if (levelRank(recommendation.recommendedLevel) <= levelRank(policyLevel))
    return {
      level: policyLevel,
      advisoryApplied: false,
      advisoryDisregardedReason: 'RECOMMENDATION_NOT_STRICTER_THAN_POLICY',
    };

  const capped = levelAt(levelRank(policyLevel) + 1);
  return {
    level: capped,
    advisoryApplied: true,
    advisoryDisregardedReason:
      levelRank(recommendation.recommendedLevel) > levelRank(capped)
        ? 'RECOMMENDATION_CAPPED_AT_ONE_STEP'
        : undefined,
  };
}
