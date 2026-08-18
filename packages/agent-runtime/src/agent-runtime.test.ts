import { createHash } from 'node:crypto';
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
  it('versions agents and prompts, validates prompt contracts, and rolls published prompts back', async () => {
    const store = new InMemoryTrustStore();
    const agents = new AgentRegistryEngine(store);
    const prompts = new PromptRegistryEngine(store);
    const first = await agents.register(c, {
      name: 'Atlas',
      owner: 'Agreement Intelligence',
      promptIds: ['atlas'],
      allowedCapabilityIds: ['read-agreement'],
    });
    const second = await agents.register(c, {
      name: 'Atlas',
      owner: 'Agreement Intelligence',
      promptIds: ['atlas'],
      allowedCapabilityIds: ['read-agreement'],
    });
    expect(first.version).toBe(1);
    expect((await agents.activate(c, second.id)).version).toBe(2);
    expect((await agents.active(c, 'Atlas'))?.id).toBe(second.id);
    await expect(prompts.createVersion(c, {
        promptId: 'atlas',
        template: 'missing',
        requiredVariables: ['agreement'],
        outputContract: 'Proposal',
      })).rejects.toThrow('PROMPT_VARIABLE_MISSING');
    const p1 = await prompts.createVersion(c, {
      promptId: 'atlas',
      template: 'Review {{agreement}}',
      requiredVariables: ['agreement'],
      outputContract: 'Proposal',
    });
    await prompts.publish(c, p1.id);
    const p2 = await prompts.createVersion(c, {
      promptId: 'atlas',
      template: 'Analyze {{agreement}}',
      requiredVariables: ['agreement'],
      outputContract: 'Proposal',
    });
    await prompts.publish(c, p2.id);
    expect((await prompts.render(c, 'atlas', { agreement: 'A-1' })).rendered).toBe(
      'Analyze A-1',
    );
    await prompts.rollback(c, 'atlas', 1);
    expect((await prompts.render(c, 'atlas', { agreement: 'A-1' })).rendered).toBe(
      'Review A-1',
    );
  });

  it('forbids protected deterministic mutation and makes human approvals one-time and proposal-bound', async () => {
    const store = new InMemoryTrustStore();
    const capabilities = new CapabilityRegistryEngine(store);
    const approvals = new HumanApprovalEngine(store);
    await expect(capabilities.register(c, {
        name: 'issue-certificate',
        owner: 'Completion Assurance',
        permission: 'certificate:issue',
        mode: 'EXECUTE_DETERMINISTIC',
        deterministicContract: 'CompletionCertification.issue',
        aiAllowed: true,
        humanApprovalRequired: true,
        protectedState: true,
      })).rejects.toThrow('AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES');
    // The digest of the proposal this approval authorises, and nothing else. Until Batch M this was `'abc'`:
    // the engine accepted any string, so the hash that binds an approval to one proposal could be a value
    // nobody could recompute from the proposal.
    const proposalHash = createHash('sha256')
      .update(JSON.stringify({ certificate: 'milestone-1' }))
      .digest('hex');
    const otherHash = createHash('sha256').update('another-proposal').digest('hex');
    await expect(
      approvals.request(c, {
        executionId: 'run',
        requestedByAgentId: 'atlas-agent',
        action: 'CERTIFICATION',
        proposalHash: 'abc',
      }),
    ).rejects.toThrow('PROPOSAL_HASH_MUST_BE_A_DIGEST');
    const request = await approvals.request(c, {
      executionId: 'run',
      requestedByAgentId: 'atlas-agent',
      action: 'CERTIFICATION',
      proposalHash,
    });
    await expect(approvals.consume(c, request.id, proposalHash)).rejects.toThrow(
      'APPROVAL_REQUIRED',
    );
    await approvals.decide(c, request.id, 'APPROVED');
    await expect(approvals.consume(c, request.id, otherHash)).rejects.toThrow(
      'APPROVAL_PROPOSAL_MISMATCH',
    );
    await approvals.consume(c, request.id, proposalHash);
    await expect(approvals.consume(c, request.id, proposalHash)).rejects.toThrow(
      'APPROVAL_ALREADY_CONSUMED',
    );
  });
});
