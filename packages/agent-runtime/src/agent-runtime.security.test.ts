import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AgentGovernanceEngine,
  ContextEngine,
  ExecutionMemoryEngine,
} from './index';
const context = (workspaceId: string) => ({
  actorUserId: 'u',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: workspaceId,
  tenantId: `t-${workspaceId}`,
  memberships: [workspaceId],
  correlationId: 'security',
});
describe('security and architecture boundaries', () => {
  it('isolates context and memory by workspace and denies governance by default', async () => {
    const store = new InMemoryTrustStore();
    const contexts = new ContextEngine(store);
    const memory = new ExecutionMemoryEngine(store);
    const governance = new AgentGovernanceEngine(store);
    const created = await contexts.create(context('a'), {
      milestoneIds: [],
      definitionOfDoneIds: [],
      historyRefs: [],
      permissions: [],
    });
    await expect(contexts.get(context('b'), created.id)).rejects.toThrow('NOT_FOUND');
    await memory.append(context('a'), {
      executionId: 'run',
      agentId: 'agent',
      kind: 'REASONING_METADATA',
      content: { sources: ['agreement:a'] },
    });
    expect(await memory.history(context('b'), 'run')).toEqual([]);
    await expect(governance.authorize(context('a'), {
        roles: ['admin'],
        promptId: 'p',
        capabilityId: 'c',
        model: 'm',
      })).rejects.toThrow('ACTIVE_AGENT_GOVERNANCE_POLICY_REQUIRED');
  });
});
