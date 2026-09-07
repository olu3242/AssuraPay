import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { PersonaAgentRegistryEngine } from './agentic-os';
import {
  DEFAULT_PERSONA_AGENT_POLICIES,
  bootstrapCorePersonaAgents,
} from './persona-bootstrap';

const context: RequestContext = {
  actorUserId: 'user-bootstrap',
  sessionId: 'session-bootstrap',
  identityAssuranceLevel: 'IAL2_VERIFIED',
  activeWorkspaceId: 'workspace-bootstrap',
  tenantId: 'tenant-bootstrap',
  organizationId: 'org-bootstrap',
  memberships: ['ORG_ADMIN'],
  correlationId: 'corr-bootstrap',
};

describe('Agentic OS persona bootstrap', () => {
  it('is idempotent for the same core persona binding', async () => {
    const registry = new PersonaAgentRegistryEngine(new InMemoryTrustStore());
    const bindings = {
      BUYER: {
        registeredAgentId: 'agent-buyer',
        promptId: 'prompt-buyer',
        capabilityId: 'cap-buyer',
      },
    } as const;

    const first = await bootstrapCorePersonaAgents(context, registry, bindings);
    const second = await bootstrapCorePersonaAgents(context, registry, bindings);

    expect(first).toHaveLength(1);
    expect(first[0].changed).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0].changed).toBe(false);
    expect(second[0].profile.id).toBe(first[0].profile.id);
    expect(second[0].profile.tenantId).toBe(context.tenantId);
  });

  it('does not grant protected policy-bound execution by default', () => {
    for (const policy of Object.values(DEFAULT_PERSONA_AGENT_POLICIES)) {
      expect(policy.allowedActionClasses).not.toContain('EXECUTE_POLICY_BOUND');
    }
    expect(DEFAULT_PERSONA_AGENT_POLICIES.PAYMENT_PARTNER.autonomyLevel).toBeLessThan(4);
    expect(DEFAULT_PERSONA_AGENT_POLICIES.EXECUTIVE_APPROVER.autonomyLevel).toBeLessThan(4);
  });
});
