import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ASSURAPAY_AGENT_IDENTITIES,
  AgentRegistryEngine,
  CapabilityRegistryEngine,
  HumanApprovalEngine,
  PromptRegistryEngine,
} from './index';

const c = {
  actorUserId: 'human-1',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engines 62–64 and 68 registries and approval', () => {
  it('publishes the ten governed AssuraPay agent identities', () => {
    expect(ASSURAPAY_AGENT_IDENTITIES).toEqual([
      'Atlas',
      'Blueprint',
      'DoD',
      'Evidence',
      'Validation',
      'Risk',
      'Settlement',
      'Analytics',
      'Advisor',
      'Coordinator',
    ]);
  });
  it('versions agents and prompts, validates prompt contracts, and rolls published prompts back', () => {
    const store = new InMemoryTrustStore();
    const agents = new AgentRegistryEngine(store);
    const prompts = new PromptRegistryEngine(store);
    const first = agents.register(c, {
      name: 'Atlas',
      owner: 'Agreement Intelligence',
      promptIds: ['atlas'],
      allowedCapabilityIds: ['read-agreement'],
    });
    const second = agents.register(c, {
      name: 'Atlas',
      owner: 'Agreement Intelligence',
      promptIds: ['atlas'],
      allowedCapabilityIds: ['read-agreement'],
    });
    expect(first.version).toBe(1);
    expect(agents.activate(c, second.id).version).toBe(2);
    expect(agents.active(c, 'Atlas')?.id).toBe(second.id);
    expect(() =>
      prompts.createVersion(c, {
        promptId: 'atlas',
        template: 'missing',
        requiredVariables: ['agreement'],
        outputContract: 'Proposal',
      }),
    ).toThrow('PROMPT_VARIABLE_MISSING');
    const p1 = prompts.createVersion(c, {
      promptId: 'atlas',
      template: 'Review {{agreement}}',
      requiredVariables: ['agreement'],
      outputContract: 'Proposal',
    });
    prompts.publish(c, p1.id);
    const p2 = prompts.createVersion(c, {
      promptId: 'atlas',
      template: 'Analyze {{agreement}}',
      requiredVariables: ['agreement'],
      outputContract: 'Proposal',
    });
    prompts.publish(c, p2.id);
    expect(prompts.render(c, 'atlas', { agreement: 'A-1' }).rendered).toBe(
      'Analyze A-1',
    );
    prompts.rollback(c, 'atlas', 1);
    expect(prompts.render(c, 'atlas', { agreement: 'A-1' }).rendered).toBe(
      'Review A-1',
    );
  });

  it('forbids protected deterministic mutation and makes human approvals one-time and proposal-bound', () => {
    const store = new InMemoryTrustStore();
    const capabilities = new CapabilityRegistryEngine(store);
    const approvals = new HumanApprovalEngine(store);
    expect(() =>
      capabilities.register(c, {
        name: 'issue-certificate',
        owner: 'Completion Assurance',
        permission: 'certificate:issue',
        mode: 'EXECUTE_DETERMINISTIC',
        deterministicContract: 'CompletionCertification.issue',
        aiAllowed: true,
        humanApprovalRequired: true,
        protectedState: true,
      }),
    ).toThrow('AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES');
    const request = approvals.request(c, {
      executionId: 'run',
      requestedByAgentId: 'atlas-agent',
      action: 'CERTIFICATION',
      proposalHash: 'abc',
    });
    expect(() => approvals.consume(c, request.id, 'abc')).toThrow(
      'APPROVAL_REQUIRED',
    );
    approvals.decide(c, request.id, 'APPROVED');
    expect(() => approvals.consume(c, request.id, 'wrong')).toThrow(
      'APPROVAL_PROPOSAL_MISMATCH',
    );
    approvals.consume(c, request.id, 'abc');
    expect(() => approvals.consume(c, request.id, 'abc')).toThrow(
      'APPROVAL_ALREADY_CONSUMED',
    );
  });
});
