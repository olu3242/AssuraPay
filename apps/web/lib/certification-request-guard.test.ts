import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { assertCertificationRequestBinding } from './certification-request-guard';

const context: RequestContext = {
  actorUserId: 'requester',
  sessionId: 'session',
  identityAssuranceLevel: 'AAL1',
  activeWorkspaceId: 'workspace-1',
  tenantId: 'tenant-1',
  memberships: ['workspace-1'],
  correlationId: 'correlation',
};

async function seeded() {
  const store = new InMemoryTrustStore();
  await store.append('governedExecutions', {
    id: 'execution-1',
    workspaceId: 'workspace-1',
  });
  await store.append('governedMilestones', {
    id: 'milestone-1',
    workspaceId: 'workspace-1',
    executionId: 'execution-1',
  });
  await store.append('dodEvaluations', {
    id: 'evaluation-1',
    workspaceId: 'workspace-1',
    milestoneId: 'milestone-1',
    mandatoryPassed: true,
  });
  await store.append('memberships', {
    id: 'membership-requester',
    workspaceId: 'workspace-1',
    userId: 'requester',
    status: 'ACTIVE',
  });
  await store.append('memberships', {
    id: 'membership-reviewer',
    workspaceId: 'workspace-1',
    userId: 'reviewer',
    status: 'ACTIVE',
  });
  return store;
}

const validInput = {
  executionId: 'execution-1',
  milestoneId: 'milestone-1',
  dodEvaluationId: 'evaluation-1',
  reviewerIds: ['reviewer'],
};

describe('certification request product binding', () => {
  it('accepts a passing DoD evaluation bound to the requested milestone and execution', async () => {
    const store = await seeded();
    await expect(
      assertCertificationRequestBinding(store, context, validInput),
    ).resolves.toBeUndefined();
  });

  it('refuses an evaluation from another milestone even when that evaluation passed', async () => {
    const store = await seeded();
    await store.append('governedMilestones', {
      id: 'milestone-2',
      workspaceId: 'workspace-1',
      executionId: 'execution-1',
    });
    await store.append('dodEvaluations', {
      id: 'evaluation-2',
      workspaceId: 'workspace-1',
      milestoneId: 'milestone-2',
      mandatoryPassed: true,
    });

    await expect(
      assertCertificationRequestBinding(store, context, {
        ...validInput,
        dodEvaluationId: 'evaluation-2',
      }),
    ).rejects.toThrow('CERTIFICATION_DOD_NOT_SATISFIED');
  });

  it('refuses a milestone that does not belong to the requested execution', async () => {
    const store = await seeded();
    await store.append('governedExecutions', {
      id: 'execution-2',
      workspaceId: 'workspace-1',
    });
    await store.append('governedMilestones', {
      id: 'milestone-2',
      workspaceId: 'workspace-1',
      executionId: 'execution-2',
    });
    await store.append('dodEvaluations', {
      id: 'evaluation-2',
      workspaceId: 'workspace-1',
      milestoneId: 'milestone-2',
      mandatoryPassed: true,
    });

    await expect(
      assertCertificationRequestBinding(store, context, {
        ...validInput,
        milestoneId: 'milestone-2',
        dodEvaluationId: 'evaluation-2',
      }),
    ).rejects.toThrow('CERTIFICATION_MILESTONE_MISMATCH');
  });

  it('requires every reviewer to be an active member of the workspace', async () => {
    const store = await seeded();
    await expect(
      assertCertificationRequestBinding(store, context, {
        ...validInput,
        reviewerIds: ['outsider'],
      }),
    ).rejects.toThrow('CERTIFICATION_REVIEWER_MEMBERSHIP_REQUIRED');
  });

  it('preserves maker-checker separation', async () => {
    const store = await seeded();
    await expect(
      assertCertificationRequestBinding(store, context, {
        ...validInput,
        reviewerIds: ['requester'],
      }),
    ).rejects.toThrow('INDEPENDENT_REVIEWER_REQUIRED');
  });
});
