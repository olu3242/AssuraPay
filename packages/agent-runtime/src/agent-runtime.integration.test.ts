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
  actorUserId: 'operator',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'integration',
};

describe('integration: governed Agent Runtime pipeline', () => {
  it('routes User → Gateway → Prompt → Runtime → Capability → deterministic contract → Governance → Audit', async () => {
    const store = new InMemoryTrustStore();
    const capabilities = new CapabilityRegistryEngine(store);
    const agents = new AgentRegistryEngine(store);
    const prompts = new PromptRegistryEngine(store);
    const contexts = new ContextEngine(store);
    const memory = new ExecutionMemoryEngine(store);
    const telemetry = new AgentTelemetryEngine(store);
    const governance = new AgentGovernanceEngine(store);
    const capability = capabilities.register(c, {
      name: 'assess-dod-readiness',
      owner: 'Completion Assurance',
      permission: 'dod:read',
      mode: 'EXECUTE_DETERMINISTIC',
      deterministicContract: 'DefinitionOfDone.assessReadiness',
      aiAllowed: true,
      humanApprovalRequired: false,
      protectedState: false,
    });
    const prompt = prompts.createVersion(c, {
      promptId: 'dod-readiness',
      template: 'Propose gaps for {{dod}}',
      requiredVariables: ['dod'],
      outputContract: 'DoDReadinessProposal',
    });
    prompts.publish(c, prompt.id);
    const agent = agents.register(c, {
      name: 'DoD',
      owner: 'Performance Readiness',
      promptIds: ['dod-readiness'],
      allowedCapabilityIds: [capability.id],
    });
    agents.activate(c, agent.id);
    governance.publish(c, {
      allowedRoles: ['operator'],
      allowedPromptIds: ['dod-readiness'],
      allowedCapabilityIds: [capability.id],
      allowedModels: ['governed-model'],
      requireApprovalFor: ['APPROVAL', 'WAIVER', 'OVERRIDE', 'CERTIFICATION'],
    });
    const snapshot = contexts.create(c, {
      agreementId: 'a',
      blueprintId: 'b',
      milestoneIds: ['m'],
      definitionOfDoneIds: ['dod-1'],
      historyRefs: ['event-1'],
      permissions: ['dod:read'],
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
            id: 'primary',
            async invoke() {
              return {
                output: { missingEvidence: ['inspection'] },
                inputTokens: 10,
                outputTokens: 5,
                costMinor: 2,
              };
            },
          },
        ],
        {
          allowedModels: ['governed-model'],
          maxRequestsPerMinute: 10,
          maxCostMinorPerInvocation: 10,
          retries: 0,
        },
      ),
      deterministic: {
        async invoke(contract, proposal) {
          expect(contract).toBe('DefinitionOfDone.assessReadiness');
          return { kind: 'PROPOSAL', proposal };
        },
      },
    });
    const run = await runtime.execute(c, {
      agentId: agent.id,
      capabilityId: capability.id,
      promptId: 'dod-readiness',
      contextSnapshotId: snapshot.id,
      model: 'governed-model',
      roles: ['operator'],
      variables: { dod: 'dod-1' },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.proposal).toEqual({
      kind: 'PROPOSAL',
      proposal: { missingEvidence: ['inspection'] },
    });
    expect(memory.history(c, run.id)).toHaveLength(2);
    expect(telemetry.summarize(c, agent.id).totalCostMinor).toBe(2);
    expect(store.list('auditRecords').length).toBeGreaterThanOrEqual(5);
  });
});
