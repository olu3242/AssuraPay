import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { ExecutionHealthEngine, WorkflowIntelligenceEngine } from './index';
const c = {
  actorUserId: 'agent-runtime',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'integration',
};
describe('integration: canonical outputs to governed Agent Runtime capability', () => {
  it('turns canonical execution snapshots into advisory workflow and health artifacts', () => {
    const store = new InMemoryTrustStore();
    const workflow = new WorkflowIntelligenceEngine(store).assess(c, {
      agreementId: 'a',
      stalledAfterHours: 24,
      observedAt: '2026-08-03T00:00:00Z',
      edges: [],
      nodes: [
        {
          id: 'milestone',
          kind: 'MILESTONE',
          state: 'IN_PROGRESS',
          progressPercent: 70,
          updatedAt: '2026-08-03T00:00:00Z',
        },
        {
          id: 'dod',
          kind: 'DOD',
          state: 'IN_PROGRESS',
          progressPercent: 80,
          updatedAt: '2026-08-03T00:00:00Z',
        },
      ],
    });
    const health = new ExecutionHealthEngine(store).compute(c, {
      agreementId: 'a',
      signals: {
        milestoneCompletion: workflow.progressScore,
        dodCompliance: 80,
        evidenceQuality: 75,
        validationStatus: 80,
        approvalVelocity: 70,
        settlementReadiness: 50,
        executionRisk: 20,
      },
    });
    expect(workflow.status).toBe('ACTIVE');
    expect(health.score).toBeGreaterThan(60);
    expect(store.list('auditRecords')).toHaveLength(2);
    expect(store.list('outboxEvents')).toHaveLength(2);
  });
});
