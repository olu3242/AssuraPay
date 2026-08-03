import { describe, expect, it } from 'vitest';
import {
  BottleneckDetectionEngine,
  DependencyIntelligenceEngine,
  ExecutionHealthEngine,
  ScheduleOptimizationEngine,
} from './index';
import { InMemoryTrustStore } from '@assurapay/database';
const c = {
  actorUserId: 'coordinator',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'e2e',
};
describe('e2e: deterministic execution-aware recommendation', () => {
  it('finds downstream impact, bottleneck, safe schedule and stable health score', () => {
    const edges = [{ from: 'm1', to: 'm2', type: 'MILESTONE' as const }];
    expect(
      new DependencyIntelligenceEngine().analyze(['m1', 'm2'], edges).downstream
        .m1,
    ).toEqual(['m2']);
    expect(
      new BottleneckDetectionEngine().detect({
        delayedNodeIds: ['m1'],
        approvalQueueHours: {},
        missingEvidenceByMilestone: {},
        validationFailuresByMilestone: {},
      })[0].scopeId,
    ).toBe('m1');
    expect(
      new ScheduleOptimizationEngine().recommend({
        nodes: [
          { id: 'm1', ownerId: 'o', durationHours: 5 },
          { id: 'm2', ownerId: 'o', durationHours: 5 },
        ],
        edges,
        capacityHoursByOwner: { o: 8 },
      }).status,
    ).toBe('PROPOSED');
    const health = new ExecutionHealthEngine(new InMemoryTrustStore()).compute(
      c,
      {
        agreementId: 'a',
        signals: {
          milestoneCompletion: 50,
          dodCompliance: 60,
          evidenceQuality: 70,
          validationStatus: 80,
          approvalVelocity: 50,
          settlementReadiness: 40,
          executionRisk: 60,
        },
      },
    );
    expect(health.score).toBe(58);
    expect(health.health).toBe('AT_RISK');
  });
});
