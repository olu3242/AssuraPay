import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AgentGovernanceEngine,
  AgentRegistryEngine,
  AgentRuntimeEngine,
  AgentTelemetryEngine,
  AiGatewayEngine,
  CapabilityRegistryEngine,
  ContextEngine,
  ExecutionMemoryEngine,
  PromptRegistryEngine,
} from './index';

const c = {
  actorUserId: 'analyst',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'e2e',
};
describe('e2e: deterministic execution-intelligence proposal', () => {
  it('retries a provider failure and produces the same governed readiness proposal', async () => {
    const store = new InMemoryTrustStore();
    const capabilities = new CapabilityRegistryEngine(store);
    const agents = new AgentRegistryEngine(store);
    const prompts = new PromptRegistryEngine(store);
    const contexts = new ContextEngine(store);
    const memory = new ExecutionMemoryEngine(store);
    const telemetry = new AgentTelemetryEngine(store);
    const governance = new AgentGovernanceEngine(store);
    let calls = 0;
    const cap = capabilities.register(c, {
      name: 'blueprint-gap-proposal',
      owner: 'Performance Blueprint',
      permission: 'blueprint:read',
      mode: 'PROPOSE',
      deterministicContract: 'PerformanceBlueprint.validateProposal',
      aiAllowed: true,
      humanApprovalRequired: false,
      protectedState: false,
    });
    const p = prompts.createVersion(c, {
      promptId: 'blueprint',
      template: 'Review {{blueprint}}',
      requiredVariables: ['blueprint'],
      outputContract: 'BlueprintGapProposal',
    });
    prompts.publish(c, p.id);
    const a = agents.register(c, {
      name: 'Blueprint',
      owner: 'Performance Blueprint',
      promptIds: ['blueprint'],
      allowedCapabilityIds: [cap.id],
    });
    agents.activate(c, a.id);
    governance.publish(c, {
      allowedRoles: ['analyst'],
      allowedPromptIds: ['blueprint'],
      allowedCapabilityIds: [cap.id],
      allowedModels: ['deterministic'],
      requireApprovalFor: ['APPROVAL', 'WAIVER', 'OVERRIDE', 'CERTIFICATION'],
    });
    const snapshot = contexts.create(c, {
      blueprintId: 'bp',
      milestoneIds: ['m'],
      definitionOfDoneIds: ['d'],
      historyRefs: [],
      permissions: ['blueprint:read'],
    });
    const runtime = new AgentRuntimeEngine({
      store,
      agents,
      capabilities,
      prompts,
      contexts,
      memory,
      telemetry,
      governance,
      ai: new AiGatewayEngine(
        [
          {
            id: 'test',
            async invoke() {
              calls++;
              if (calls === 1) throw new Error('TRANSIENT');
              return {
                output: { gaps: ['owner'] },
                inputTokens: 1,
                outputTokens: 1,
                costMinor: 0,
              };
            },
          },
        ],
        {
          allowedModels: ['deterministic'],
          maxRequestsPerMinute: 10,
          maxCostMinorPerInvocation: 1,
          retries: 0,
        },
      ),
      deterministic: {
        async invoke(_, value) {
          return value;
        },
      },
    });
    const result = await runtime.execute(c, {
      agentId: a.id,
      capabilityId: cap.id,
      promptId: 'blueprint',
      contextSnapshotId: snapshot.id,
      model: 'deterministic',
      roles: ['analyst'],
      variables: { blueprint: 'bp' },
      maxAttempts: 2,
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.attempts).toBe(2);
    expect(result.proposal).toEqual({ gaps: ['owner'] });
  });
});
