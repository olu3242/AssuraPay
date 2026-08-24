import { describe, expect, it } from 'vitest';
import {
  MINIMUM_ADVISORY_CONFIDENCE,
  TRUST_LEVELS,
  applyAdvisory,
  controlsFor,
  evaluate,
  levelRank,
  type AiRecommendation,
  type GovernedFacts,
  type TrustLevel,
} from './policy';

/**
 * Progressive Trust — the deterministic policy.
 *
 * The assertions that matter here are the negative ones. It is easy to write a policy that produces a
 * plausible level; the property this module has to have is that **no model can loosen it**, and that is
 * only demonstrated by trying.
 */

/** A clean, established, verified relationship — the only shape that reaches L0. */
function establishedFacts(overrides: Partial<GovernedFacts> = {}): GovernedFacts {
  return {
    transactionValueMinor: 100_00,
    cumulativeExposureMinor: 500_00,
    activeExposureMinor: 0,
    relationshipMaturityDays: 400,
    kybStatus: 'VERIFIED',
    kycStatus: 'VERIFIED',
    priorCompletedAgreements: 12,
    disputeCount: 0,
    settlementsOnTime: 12,
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
    recommendedLevel: 'L4_CONTROLLED',
    confidence: 0.95,
    reasonCodes: ['PATTERN_MATCHES_KNOWN_FRAUD'],
    modelId: 'sandbox',
    modelVersion: '1',
    promptVersion: '1',
    capabilityVersion: '1',
    ...overrides,
  };
}

describe('the level is a function of governed facts', () => {
  it('reaches L0 only for a long, clean, verified relationship', () => {
    expect(evaluate(establishedFacts()).level).toBe('L0_VERIFIED');
  });

  it('gives an unestablished but otherwise clean relationship the L1 baseline', () => {
    // Everything verified and quiet, but the relationship is young and has no history to speak of.
    const level = evaluate(
      establishedFacts({ relationshipMaturityDays: 200, priorCompletedAgreements: 2 }),
    ).level;
    expect(level).toBe('L1_STANDARD');
  });

  it('is deterministic: the same facts always produce the same level and reasons', () => {
    const facts = establishedFacts({ transactionValueMinor: 60_000_00, anomalyCount: 1 });
    const first = evaluate(facts);
    const second = evaluate(facts);
    expect(second).toEqual(first);
  });

  it('always explains itself', () => {
    for (const facts of [
      establishedFacts(),
      establishedFacts({ kybStatus: 'FAILED' }),
      establishedFacts({ transactionValueMinor: 600_000_00 }),
      establishedFacts({ relationshipMaturityDays: 5, priorCompletedAgreements: 0 }),
    ]) {
      const { level, reasonCodes } = evaluate(facts);
      expect(reasonCodes.length).toBeGreaterThan(0);
      // The level must be attributable to a reason that actually required it, not merely accompanied
      // by reasons — otherwise "why is this L3" has no answer.
      const strongest = reasonCodes.reduce(
        (rank, reason) => Math.max(rank, levelRank(reason.contributes)),
        0,
      );
      if (level !== 'L1_STANDARD') expect(levelRank(level)).toBe(strongest);
    }
  });
});

describe('the strongest single fact governs, and cannot be averaged away', () => {
  it('pins a failed verification to L4 despite a spotless history', () => {
    // Everything else about this counterparty is perfect. That must not matter.
    const { level, reasonCodes } = evaluate(establishedFacts({ kybStatus: 'FAILED' }));
    expect(level).toBe('L4_CONTROLLED');
    expect(reasonCodes.map((reason) => reason.code)).toContain('VERIFICATION_FAILED');
  });

  it('pins contested evidence to L4', () => {
    expect(evaluate(establishedFacts({ evidenceQuality: 'CONTESTED' })).level).toBe('L4_CONTROLLED');
  });

  it('escalates on repeated disputes regardless of value', () => {
    expect(
      evaluate(establishedFacts({ transactionValueMinor: 1_00, disputeCount: 3 })).level,
    ).toBe('L4_CONTROLLED');
  });

  it('never lowers a level when a fact gets worse', () => {
    // Monotonicity, asserted across each axis independently. A policy where adding risk could reduce
    // control would be worse than no policy, because it would be trusted.
    const base = establishedFacts({ relationshipMaturityDays: 200, priorCompletedAgreements: 2 });
    const worse: Partial<GovernedFacts>[] = [
      { transactionValueMinor: 600_000_00 },
      { activeExposureMinor: 200_000_00 },
      { disputeCount: 1 },
      { settlementsLateOrFailed: 5 },
      { complexityScore: 9 },
      { crossBorder: true },
      { anomalyCount: 4 },
      { evidenceQuality: 'WEAK' },
      { kycStatus: 'PENDING' },
    ];
    for (const change of worse)
      expect(
        levelRank(evaluate({ ...base, ...change }).level),
        JSON.stringify(change),
      ).toBeGreaterThanOrEqual(levelRank(evaluate(base).level));
  });
});

describe('an advisory recommendation can raise scrutiny and never lower it', () => {
  it('AI_LOWERED_NOTHING: a confident recommendation cannot reduce the level', () => {
    // The central guarantee of the whole module, stated as its own test. A model asserting that a
    // failed-KYB transaction is routine must change nothing at all.
    const policy = evaluate(establishedFacts({ kybStatus: 'FAILED' }));
    expect(policy.level).toBe('L4_CONTROLLED');

    for (const recommended of TRUST_LEVELS) {
      const applied = applyAdvisory(
        policy.level,
        recommendation({ recommendedLevel: recommended, confidence: 1 }),
      );
      expect(levelRank(applied.level), recommended).toBeGreaterThanOrEqual(levelRank(policy.level));
    }
  });

  it('raises by exactly one step when the agent is stricter than policy', () => {
    const applied = applyAdvisory('L1_STANDARD', recommendation({ recommendedLevel: 'L2_PROTECTED' }));
    expect(applied.level).toBe('L2_PROTECTED');
    expect(applied.advisoryApplied).toBe(true);
  });

  it('caps an alarmed agent at one step, and says that it capped it', () => {
    // An agent that has been prompt-injected, or is simply wrong, should be able to attract a human —
    // not to escalate a routine transaction to maximum control and stall the platform.
    const applied = applyAdvisory('L1_STANDARD', recommendation({ recommendedLevel: 'L4_CONTROLLED' }));
    expect(applied.level).toBe('L2_PROTECTED');
    expect(applied.advisoryDisregardedReason).toBe('RECOMMENDATION_CAPPED_AT_ONE_STEP');
  });

  it('records and disregards a low-confidence recommendation', () => {
    const applied = applyAdvisory(
      'L1_STANDARD',
      recommendation({ recommendedLevel: 'L4_CONTROLLED', confidence: MINIMUM_ADVISORY_CONFIDENCE - 0.01 }),
    );
    expect(applied.level).toBe('L1_STANDARD');
    expect(applied.advisoryApplied).toBe(false);
    expect(applied.advisoryDisregardedReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });

  it('does nothing when there is no agent at all', () => {
    // Every deployment of this repository today. A governed level must not require a model to exist.
    const applied = applyAdvisory('L3_ENHANCED', undefined);
    expect(applied).toEqual({ level: 'L3_ENHANCED', advisoryApplied: false });
  });
});

describe('controls make the level actionable', () => {
  it('tightens monotonically with the level', () => {
    const ordered = TRUST_LEVELS.map((level) => controlsFor(level));
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      for (const control of [
        'independentReviewRequired',
        'dualApprovalRequired',
        'manualReleaseRequired',
        'reconciliationBeforeNextMilestone',
        'enhancedDueDiligenceRequired',
      ] as const)
        expect(
          Number(current[control]) >= Number(previous[control]),
          `${TRUST_LEVELS[index]}.${control}`,
        ).toBe(true);
    }
  });

  it('requires a human to release money at L3 and above', () => {
    for (const level of ['L3_ENHANCED', 'L4_CONTROLLED'] as TrustLevel[]) {
      expect(controlsFor(level).manualReleaseRequired).toBe(true);
      expect(controlsFor(level).dualApprovalRequired).toBe(true);
    }
  });

  it('demands enhanced due diligence only at L4', () => {
    const demanding = TRUST_LEVELS.filter((level) => controlsFor(level).enhancedDueDiligenceRequired);
    expect(demanding).toEqual(['L4_CONTROLLED']);
  });

  it('cannot be loosened for the whole process by a caller mutating what it was handed', () => {
    // Raised by review on #42, and worth stating as a test rather than trusting the freeze: the control
    // table is process-global, so one assignment on a returned object would have disabled manual release
    // for every L4 assessment until restart — with the already-written assessments still claiming the
    // control was required, and nothing in the audit trail to show the change.
    const handed = controlsFor('L4_CONTROLLED');
    handed.manualReleaseRequired = false;
    handed.dualApprovalRequired = false;

    const next = controlsFor('L4_CONTROLLED');
    expect(next.manualReleaseRequired).toBe(true);
    expect(next.dualApprovalRequired).toBe(true);
  });
});
