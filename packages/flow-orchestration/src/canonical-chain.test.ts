import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { FlowOrchestrator, FlowRegistry } from './index';
import { COMMERCIAL_COMMITMENT_FLOW_V1 } from './canonical-chain';
import { DomainEventFlowBridge } from './domain-event-bridge';

const context = {
  actorUserId: 'operator', sessionId: 's', identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w', tenantId: 't', memberships: ['w'], correlationId: 'corr-1',
};

function event(eventId: string, eventType: string) {
  return {
    eventId, eventType, aggregateType: 'CanonicalAggregate', aggregateId: eventId,
    workspaceId: 'w', correlationId: 'corr-1', payload: {},
  };
}

describe('canonical AssuraPay domain-event chain', () => {
  it('advances only from authoritative events and requires enhanced approval when assurance demands it', async () => {
    const store = new InMemoryTrustStore();
    await store.append('memberships', {
      id: 'm-operator-w-release-approver',
      workspaceId: 'w',
      userId: context.actorUserId,
      membershipType: 'RELEASE_APPROVER',
      role: 'RELEASE_APPROVER',
      status: 'ACTIVE',
    });
    const registry = new FlowRegistry();
    registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
    const flows = new FlowOrchestrator(store, registry);
    const bridge = new DomainEventFlowBridge(flows);
    const flow = await flows.start(context, {
      flowDefinitionId: COMMERCIAL_COMMITMENT_FLOW_V1.id,
      flowVersion: 1,
      organizationId: 'org', transactionId: 'tx', agreementId: 'agreement',
      assuranceLevel: 'ENHANCED', idempotencyKey: 'start:tx',
    });

    await flows.dispatch(context, flow.id, 'agreement-executed');
    const ordered = [
      ['e1', 'AgreementExecuted', 'agreement-intelligence'],
      ['e2', 'AgreementIntelligencePublished', 'blueprint'],
      ['e3', 'PerformanceBlueprintActivated', 'dod'],
      ['e4', 'DefinitionOfDonePackagePublished', 'execution'],
      ['e5', 'ExecutionWorkspaceActivated', 'evidence'],
      ['e6', 'EvidencePackageVerified', 'validation'],
      ['e7', 'ValidationRecorded', 'completion'],
      ['e8', 'CompletionCertificateIssued', 'eligibility'],
      ['e9', 'PaymentEligibilityAssessed', 'release'],
    ] as const;

    for (const [id, type, next] of ordered) {
      await bridge.apply(context, flow.id, event(id, type));
      await flows.dispatch(context, flow.id, next);
    }

    await bridge.apply(context, flow.id, event('e10', 'ReleaseRequestEvaluated'));
    const approval = await flows.dispatch(context, flow.id, 'enhanced-approval');
    expect('status' in approval && approval.status).toBe('OPEN');
    await flows.decide(context, approval.id, 'APPROVE');

    await flows.dispatch(context, flow.id, 'payment');
    await bridge.apply(context, flow.id, event('e11', 'PaymentInstructionSubmitted'));
    await flows.dispatch(context, flow.id, 'reconciliation');
    await bridge.apply(context, flow.id, event('e12', 'ReconciliationRecorded'));
    await flows.dispatch(context, flow.id, 'closure');
    await bridge.apply(context, flow.id, event('e13', 'FinalSettlementAccountClosed'));

    expect((await flows.get(context, flow.id)).state).toBe('COMPLETED');
  });

  it('deduplicates replayed domain events and rejects wrong-workspace delivery', async () => {
    const store = new InMemoryTrustStore();
    const registry = new FlowRegistry();
    registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
    const flows = new FlowOrchestrator(store, registry);
    const bridge = new DomainEventFlowBridge(flows);
    const flow = await flows.start(context, {
      flowDefinitionId: COMMERCIAL_COMMITMENT_FLOW_V1.id, flowVersion: 1,
      organizationId: 'org', transactionId: 'tx', idempotencyKey: 'start:tx',
    });
    await flows.dispatch(context, flow.id, 'agreement-executed');
    const e = event('same-event', 'AgreementExecuted');
    await bridge.apply(context, flow.id, e);
    await bridge.apply(context, flow.id, e);
    expect((await store.list('flowSignals')).length).toBe(1);
    await expect(bridge.apply(context, flow.id, { ...event('bad', 'AgreementExecuted'), workspaceId: 'other' }))
      .rejects.toThrow('FLOW_EVENT_WORKSPACE_MISMATCH');
  });
});
