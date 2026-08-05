import { describe, expect, it } from 'vitest';
import { DependencyIntelligenceEngine, ExecutionHealthEngine } from './index';
import { InMemoryTrustStore } from '@assurapay/database';
const c = {
  actorUserId: 'u',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'load',
};
describe('performance', () => {
  it('analyzes a 1,000-node dependency chain and computes 1,000 health snapshots', async () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => `m${i}`);
    const edges = nodes.slice(1).map((node, i) => ({
      from: nodes[i],
      to: node,
      type: 'MILESTONE' as const,
    }));
    expect(
      new DependencyIntelligenceEngine().analyze(nodes, edges).topologicalOrder,
    ).toHaveLength(1000);
    const health = new ExecutionHealthEngine(new InMemoryTrustStore());
    for (let i = 0; i < 1000; i++)
      await health.compute(c, {
        agreementId: `a${i}`,
        signals: {
          milestoneCompletion: 50,
          dodCompliance: 50,
          evidenceQuality: 50,
          validationStatus: 50,
          approvalVelocity: 50,
          settlementReadiness: 50,
          executionRisk: 50,
        },
      });
  });
});
