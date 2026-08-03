import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ExceptionManagementEngine,
  ExecutionHealthEngine,
  EscalationIntelligenceEngine,
} from './index';
const c = (w: string) => ({
  actorUserId: 'u',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: w,
  tenantId: `t-${w}`,
  memberships: [w],
  correlationId: 'security',
});
describe('architecture and security', () => {
  it('produces only advisory artifacts and isolates persisted records by workspace', () => {
    const store = new InMemoryTrustStore();
    const plan = new ExceptionManagementEngine(store).createPlan(c('a'), {
      agreementId: 'a',
      scopeId: 'm',
      type: 'FAILED_MILESTONE',
      facts: ['failed validation'],
    });
    expect(plan.status).toBe('PROPOSED');
    expect(
      new EscalationIntelligenceEngine().recommend({
        type: 'EXECUTION_FAILURE',
        severity: 90,
        rationale: 'failure',
      }).status,
    ).toBe('PROPOSED');
    new ExecutionHealthEngine(store).compute(c('b'), {
      agreementId: 'b',
      signals: {
        milestoneCompletion: 0,
        dodCompliance: 0,
        evidenceQuality: 0,
        validationStatus: 0,
        approvalVelocity: 0,
        settlementReadiness: 0,
        executionRisk: 100,
      },
    });
    const values = store.list<{ workspaceId: string }>('executionHealthScores');
    expect(values).toHaveLength(1);
    expect(values[0].workspaceId).toBe('b');
  });
});
