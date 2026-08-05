import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  CertificationEngine,
  DefinitionOfDoneEngine,
  ExecutionEngine,
  MilestoneEngine,
  PaymentTriggerEngine,
} from './index';
const ctx = {
  actorUserId: 'owner',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};
describe('Engine 06 Execution Engine', () => {
  it('enforces lifecycle and preserves immutable ordered history and projection', async () => {
    const store = new InMemoryTrustStore();
    const service = new ExecutionEngine(store);
    const e = await service.create(ctx, {
      contractId: 'c1',
      title: 'Delivery',
      ownerUserId: 'owner',
    });
    await service.transition(ctx, e.id, 'PLANNED', 'approved plan');
    await service.transition(ctx, e.id, 'ACTIVE', 'start');
    await expect(service.transition(ctx, e.id, 'DRAFT', 'rewind')).rejects.toThrow(
      'INVALID_EXECUTION_TRANSITION',
    );
    expect((await service.history(ctx, e.id)).map((x) => x.toState)).toEqual([
      'DRAFT',
      'PLANNED',
      'ACTIVE',
    ]);
    expect((await service.project(ctx, e.id)).historyCount).toBe(3);
  });
});
describe('Engine 07 Milestone Engine', () => {
  it('rejects cycles, respects dependencies, hierarchy, ownership and computes critical path', async () => {
    const store = new InMemoryTrustStore();
    const service = new MilestoneEngine(store);
    const a = await service.create(ctx, {
      executionId: 'e',
      title: 'A',
      ownerUserId: 'u1',
      durationDays: 3,
    });
    const b = await service.create(ctx, {
      executionId: 'e',
      parentMilestoneId: a.id,
      title: 'B',
      ownerUserId: 'u2',
      durationDays: 5,
    });
    await service.addDependency(ctx, {
      executionId: 'e',
      predecessorId: a.id,
      successorId: b.id,
    });
    await expect(service.addDependency(ctx, {
        executionId: 'e',
        predecessorId: b.id,
        successorId: a.id,
      })).rejects.toThrow('MILESTONE_CYCLE');
    expect((await service.evaluateReadiness(ctx, b.id)).ready).toBe(false);
    expect(await service.criticalPath(ctx, 'e')).toEqual({
      days: 8,
      path: [a.id, b.id],
    });
  });
});
describe('Engine 08 Definition of Done Engine', () => {
  it('keeps published definitions immutable and evaluates mandatory automated and manual criteria', async () => {
    const store = new InMemoryTrustStore();
    const service = new DefinitionOfDoneEngine(store);
    const dod = await service.publish(
      ctx,
      (await service.createVersion(ctx, 'm', [
        {
          key: 'count',
          description: 'Count delivered',
          mandatory: true,
          evidenceRequirementKeys: ['manifest'],
          evaluationType: 'AUTOMATED',
          rule: { field: 'count', operator: 'GTE', value: 10 },
        },
        {
          key: 'review',
          description: 'Human review',
          mandatory: true,
          evidenceRequirementKeys: ['review'],
          evaluationType: 'MANUAL',
        },
      ])).id,
    );
    await expect(service.publish(ctx, dod.id)).rejects.toThrow('IMMUTABLE');
    const failed = await service.evaluate(ctx, dod.id, {
      facts: { count: 10 },
      evidence: { manifest: 'ev1', review: 'ev2' },
    });
    expect(failed).toMatchObject({
      mandatoryPassed: false,
      manualReviewRequired: true,
    });
    const passed = await service.evaluate(ctx, dod.id, {
      facts: { count: 10 },
      evidence: { manifest: 'ev1', review: 'ev2' },
      manualResults: { review: true },
    });
    expect(passed.mandatoryPassed).toBe(true);
  });
});
describe('Engine 09 Certification Engine', () => {
  it('requires independent human review, preserves decisions and publishes deterministic certification evidence', async () => {
    const store = new InMemoryTrustStore();
    const dod = new DefinitionOfDoneEngine(store);
    const definition = await dod.publish(
      ctx,
      (await dod.createVersion(ctx, 'm', [
        {
          key: 'done',
          description: 'Done',
          mandatory: true,
          evidenceRequirementKeys: ['ev'],
          evaluationType: 'AUTOMATED',
          rule: { field: 'done', operator: 'EQ', value: true },
        },
      ])).id,
    );
    const evaluation = await dod.evaluate(ctx, definition.id, {
      facts: { done: true },
      evidence: { ev: 'hash' },
    });
    const certification = new CertificationEngine(store);
    await expect(certification.request(ctx, {
        executionId: 'e',
        milestoneId: 'm',
        dodEvaluationId: evaluation.id,
        reviewerIds: ['owner'],
      })).rejects.toThrow('INDEPENDENT');
    const request = await certification.request(ctx, {
      executionId: 'e',
      milestoneId: 'm',
      dodEvaluationId: evaluation.id,
      reviewerIds: ['reviewer'],
    });
    const reviewer = { ...ctx, actorUserId: 'reviewer' };
    await certification.decide(reviewer, request.id, 'APPROVE', 'Evidence verified', [
      'hash',
    ]);
    await expect(certification.decide(reviewer, request.id, 'APPROVE', 'again', [])).rejects.toThrow('IMMUTABLE');
    const first = await certification.issue(reviewer, request.id);
    expect((await certification.issue(reviewer, request.id)).id).toBe(first.id);
  });
});
describe('Engine 10 Payment Trigger Engine', () => {
  it('only produces idempotent governed proposals and never moves money directly', async () => {
    const store = new InMemoryTrustStore();
    const dod = new DefinitionOfDoneEngine(store);
    const definition = await dod.publish(
      ctx,
      (await dod.createVersion(ctx, 'm', [
        {
          key: 'done',
          description: 'Done',
          mandatory: true,
          evidenceRequirementKeys: ['ev'],
          evaluationType: 'AUTOMATED',
          rule: { field: 'done', operator: 'EQ', value: true },
        },
      ])).id,
    );
    await dod.evaluate(ctx, definition.id, {
      facts: { done: true },
      evidence: { ev: 'hash' },
    });
    const service = new PaymentTriggerEngine(store);
    const trigger = await service.define(ctx, {
      milestoneId: 'm',
      name: 'Completion',
      requiredDodDefinitionId: definition.id,
      certificationRequired: false,
      amountMinor: 10000,
      currency: 'NGN',
    });
    const proposal = await service.propose(ctx, trigger.id, 'key-1');
    expect(proposal.status).toBe('PROPOSED');
    expect((await service.propose(ctx, trigger.id, 'key-1')).id).toBe(proposal.id);
    await expect(
      service.createEscrowReleaseIntent(ctx, proposal.id),
    ).rejects.toThrow('NOT_CONFIGURED');
  });
});
