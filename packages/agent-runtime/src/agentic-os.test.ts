import { describe, expect, it, vi } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { AgenticDispatchEngine, PersonaAgentRegistryEngine } from './agentic-os';

const context: RequestContext = {
  actorUserId: 'user-1', sessionId: 'session-1', identityAssuranceLevel: 'IAL2_VERIFIED',
  activeWorkspaceId: 'workspace-1', tenantId: 'tenant-1', organizationId: 'org-1',
  memberships: ['workspace-1'], correlationId: 'correlation-1',
};

async function setup(autonomyLevel: 0 | 1 | 2 | 3 | 4 | 5) {
  const registry = new PersonaAgentRegistryEngine(new InMemoryTrustStore());
  const draft = await registry.register(context, {
    persona: 'BUYER', name: 'Buyer Assurance Agent', mission: 'Protect buyer value.',
    registeredAgentId: 'agent-buyer', promptId: 'prompt-buyer', capabilityId: 'cap-buyer',
    autonomyLevel, allowedRoles: ['BUYER'],
    allowedActionClasses: ['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE'], maxRisk: 'HIGH',
  });
  return { registry, profile: await registry.activate(context, draft.id) };
}

describe('Agentic OS', () => {
  it('requires sufficient autonomy before dispatch', async () => {
    const { registry } = await setup(1);
    const execute = vi.fn();
    const dispatcher = new AgenticDispatchEngine(registry, { execute } as any);
    const decision = await dispatcher.dispatch(context, {
      persona: 'BUYER', actionClass: 'PREPARE', risk: 'MEDIUM', contextSnapshotId: 'snapshot-1',
      model: 'sandbox', roles: ['BUYER'], variables: {},
    });
    expect(decision.status).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(decision.reason).toBe('AUTONOMY_LEVEL_INSUFFICIENT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('escalates work above the persona risk mandate', async () => {
    const { registry } = await setup(2);
    const execute = vi.fn();
    const dispatcher = new AgenticDispatchEngine(registry, { execute } as any);
    const decision = await dispatcher.dispatch(context, {
      persona: 'BUYER', actionClass: 'RECOMMEND', risk: 'CRITICAL', contextSnapshotId: 'snapshot-1',
      model: 'sandbox', roles: ['BUYER'], variables: {},
    });
    expect(decision.status).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(decision.reason).toBe('TASK_RISK_EXCEEDS_AGENT_MANDATE');
  });

  it('uses the canonical runtime for authorized work', async () => {
    const { registry, profile } = await setup(2);
    const execute = vi.fn().mockResolvedValue({ id: 'execution-1' });
    const dispatcher = new AgenticDispatchEngine(registry, { execute } as any);
    const decision = await dispatcher.dispatch(context, {
      persona: 'BUYER', actionClass: 'PREPARE', risk: 'HIGH', contextSnapshotId: 'snapshot-1',
      model: 'sandbox', roles: ['BUYER'], variables: { objective: 'prepare review' },
    });
    expect(decision.status).toBe('DISPATCHED');
    expect(decision.executionId).toBe('execution-1');
    expect(execute).toHaveBeenCalledWith(context, expect.objectContaining({
      agentId: profile.registeredAgentId, capabilityId: profile.capabilityId, promptId: profile.promptId,
    }));
  });
});
