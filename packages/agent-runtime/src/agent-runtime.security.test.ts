import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { ModelProvider } from './index';
import {
  AgentGovernanceEngine,
  AiGatewayEngine,
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

describe('Engine 65 gateway timeout survives the async repository migration', () => {
  /**
   * The timeout is a bound on how long a governed call may occupy a request, so it
   * has to be enforced against a provider that never answers — not merely present
   * in the source.
   *
   * Pinned because the migration to an asynchronous repository made
   * `await provider.invoke(...)` the natural shape everywhere, and writing it
   * inside the race here resolves the provider call before the timeout promise can
   * ever win. The race still compiles, still reads correctly, and enforces nothing.
   */
  const gatewayContext = {
    ...context('ws'),
    correlationId: 'timeout',
  };

  function hangingProvider(): ModelProvider {
    return {
      id: 'hangs',
      invoke: () => new Promise(() => {}),
    };
  }

  const policy = {
    allowedModels: ['m'],
    maxRequestsPerMinute: 10,
    maxCostMinorPerInvocation: 1000,
    retries: 0,
  };

  it('rejects with AI_PROVIDER_TIMEOUT when the provider never answers', async () => {
    const gateway = new AiGatewayEngine([hangingProvider()], policy);

    await expect(
      gateway.invoke(gatewayContext, {
        model: 'm',
        prompt: 'p',
        outputContract: 'c',
        timeoutMs: 20,
      }),
    ).rejects.toThrow('AI_PROVIDER_TIMEOUT');
  });

  it('returns before the timeout when the provider answers, so the bound is not a ceiling on success', async () => {
    const gateway = new AiGatewayEngine(
      [
        {
          id: 'answers',
          async invoke() {
            return { output: { ok: true }, inputTokens: 1, outputTokens: 1, costMinor: 0 };
          },
        },
      ],
      policy,
    );

    const result = await gateway.invoke(gatewayContext, {
      model: 'm',
      prompt: 'p',
      outputContract: 'c',
      timeoutMs: 5_000,
    });
    expect(result.output).toEqual({ ok: true });
  });

  it('leaves no pending timer behind, so a resolved call cannot hold the process open', async () => {
    // `clearTimeout` in the race's `finally` is what makes this true. Without it a
    // fast call still keeps a 30-second timer alive, and a rejected one rejects an
    // already-settled promise.
    const before = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    const gateway = new AiGatewayEngine(
      [
        {
          id: 'answers',
          async invoke() {
            return { output: {}, inputTokens: 0, outputTokens: 0, costMinor: 0 };
          },
        },
      ],
      policy,
    );

    await gateway.invoke(gatewayContext, {
      model: 'm',
      prompt: 'p',
      outputContract: 'c',
      timeoutMs: 30_000,
    });

    expect(
      process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length,
    ).toBe(before);
  });
});
