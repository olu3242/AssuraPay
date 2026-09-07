import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { FlowOrchestrationEngine, FlowRegistry } from './index';
import { COMMERCIAL_COMMITMENT_FLOW_V1, COMMERCIAL_COMMITMENT_FLOW_V2 } from './canonical-chain';
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

function registryWithBothVersions() {
  const registry = new FlowRegistry();
  registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
  registry.register(COMMERCIAL_COMMITMENT_FLOW_V2);
  return registry;
}

describe('canonical AssuraPay domain-event chain', () => {
  it('keeps V1 immutable so persisted flows do not acquire a missing currency-route dependency', () => {
    expect(COMMERCIAL_COMMITMENT_FLOW_V1.version).toBe(1);
    expect(COMMERCIAL_COMMITMENT_FLOW_V1.steps.some((step) => step.id === 'currency-route')).toBe(false);
    expect(COMMERCIAL_COMMITMENT_FLOW_V1.steps.find((step) => step.id === 'payment')?.dependencies)
      .toEqual(['enhanced-approval']);
  });

  it('publishes currency-aware execution as V2', () => {
    expect(COMMERCIAL_COMMITMENT_FLOW_V2.version).toBe(2);
    expect(COMMERCIAL_COMMITMENT_FLOW_V2.steps.find((step) => step.id === 'currency-route')?.dependencies)
      .toEqual(['enhanced-approval']);
    expect(COMMERCIAL_COMMITMENT_FLOW_V2.steps.find((step) => step.id === 'payment')?.dependencies)
      .toEqual(['currency-route']);
  });

  it('advances V2 only from authoritative events and requires a governed currency route before payment', async () => {
    const store = new InMemoryTrustStore();
    await store.append('memberships', {
      id: 'membership-release-approver',
      workspaceId: 'w',
      userId: 'operator',
      status: 'ACTIVE',
      role: 'RELEASE_APPROVER',
    });
    const flows = new FlowOrchestrationEngine(store, registryWithBothVersions());
    const bridge = new DomainEventFlowBridge(flows);
    const flow = await flows.start(context, {
      flowDefinitionId: COMMERCIAL_COMMITMENT_FLOW_V2.id,
      flowVersion: 2,
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

    await flows.dispatch(context, flow.id, 'currency-route');
    await bridge.apply(context, flow.id, event('e11', 'SettlementCurrencyRouteAuthorized'));
    await flows.dispatch(context, flow.id, 'payment');
    await bridge.apply(context, flow.id, event('e12', 'PaymentInstructionSubmitted'));
    await flows.dispatch(context, flow.id, 'reconciliation');
    await bridge.apply(context, flow.id, event('e13', 'ReconciliationRecorded'));
    await flows.dispatch(context, flow.id, 'closure');
    await bridge.apply(context, flow.id, event('e14', 'FinalSettlementAccountClosed'));

    expect((await flows.get(context, flow.id)).state).toBe('COMPLETED');
  });

  it('deduplicates replayed domain events and rejects wrong-workspace delivery', async () => {
    const store = new InMemoryTrustStore();
    const flows = new FlowOrchestrationEngine(store, registryWithBothVersions());
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
