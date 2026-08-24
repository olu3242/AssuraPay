import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { governance, trustStore } from './trust-app';

type GovernedExecution = {
  id: string;
  workspaceId: string;
};

type GovernedMilestone = {
  id: string;
  workspaceId: string;
  executionId: string;
};

type DodEvaluation = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  mandatoryPassed: boolean;
};

type Membership = {
  workspaceId: string;
  userId: string;
  status: string;
};

export type CertificationRequestInput = {
  executionId: string;
  milestoneId: string;
  dodEvaluationId: string;
  reviewerIds: string[];
};

/**
 * Product-boundary invariant for Engine 40 certification requests.
 *
 * The underlying governance engine already requires a passing DoD evaluation and
 * an independent reviewer. This guard closes the remaining cross-aggregate gaps at
 * the only HTTP entry point used by the product: the evaluation must belong to the
 * requested milestone, the milestone must belong to the requested execution, and
 * every reviewer must be an ACTIVE member of the current workspace.
 */
export async function assertCertificationRequestBinding(
  store: TrustPersistence,
  context: RequestContext,
  input: CertificationRequestInput,
): Promise<void> {
  if (!context.activeWorkspaceId) throw new Error('ACTIVE_WORKSPACE_REQUIRED');
  const workspaceId = context.activeWorkspaceId;

  const execution = (await store.list<GovernedExecution>('governedExecutions')).find(
    (entry) => entry.id === input.executionId && entry.workspaceId === workspaceId,
  );
  if (!execution) throw new Error('CERTIFICATION_EXECUTION_NOT_FOUND');

  const milestone = (await store.list<GovernedMilestone>('governedMilestones')).find(
    (entry) =>
      entry.id === input.milestoneId &&
      entry.workspaceId === workspaceId &&
      entry.executionId === execution.id,
  );
  if (!milestone) throw new Error('CERTIFICATION_MILESTONE_MISMATCH');

  const evaluation = (await store.list<DodEvaluation>('dodEvaluations')).find(
    (entry) =>
      entry.id === input.dodEvaluationId &&
      entry.workspaceId === workspaceId &&
      entry.milestoneId === milestone.id &&
      entry.mandatoryPassed,
  );
  if (!evaluation) throw new Error('CERTIFICATION_DOD_NOT_SATISFIED');

  const reviewers = [...new Set(input.reviewerIds.filter(Boolean))];
  if (!reviewers.length || reviewers.includes(context.actorUserId))
    throw new Error('INDEPENDENT_REVIEWER_REQUIRED');

  const activeMembers = new Set(
    (await store.list<Membership>('memberships'))
      .filter((entry) => entry.workspaceId === workspaceId && entry.status === 'ACTIVE')
      .map((entry) => entry.userId),
  );
  if (reviewers.some((reviewerId) => !activeMembers.has(reviewerId)))
    throw new Error('CERTIFICATION_REVIEWER_MEMBERSHIP_REQUIRED');
}

export async function requestBoundCertification(
  context: RequestContext,
  input: CertificationRequestInput,
) {
  await assertCertificationRequestBinding(trustStore, context, input);
  return await governance.certifications.request(context, input);
}
