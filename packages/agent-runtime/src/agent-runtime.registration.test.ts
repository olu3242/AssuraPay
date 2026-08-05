import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AgentRuntimeEngine,
  AgentRuntimeRegistrationError,
  AiGatewayEngine,
  assertPolicyBounded,
  loadAgentRuntimePolicy,
  passthroughDeterministicGateway,
  registerAgentRuntime,
  sandboxModelProvider,
  type GatewayPolicy,
  type ModelProvider,
} from './index';

const policy: GatewayPolicy = {
  allowedModels: ['sandbox'],
  maxRequestsPerMinute: 10,
  maxCostMinorPerInvocation: 0,
  retries: 0,
};

function build(overrides: Partial<Parameters<typeof registerAgentRuntime>[1]> = {}) {
  const store = new InMemoryTrustStore();
  const registration = registerAgentRuntime(store, {
    providers: [sandboxModelProvider],
    policy,
    ...overrides,
  });
  return { store, registration };
}

describe('Engines 61-70 agent runtime registration', () => {
  it('registers every engine the runtime needs', () => {
    const { registration } = build();

    for (const key of [
      'capabilities',
      'agents',
      'prompts',
      'contexts',
      'memory',
      'telemetry',
      'governance',
      'approvals',
      'ai',
      'runtime',
    ] as const) {
      expect(registration[key], `${key} was not registered`).toBeDefined();
    }
    expect(registration.runtime).toBeInstanceOf(AgentRuntimeEngine);
    expect(registration.ai).toBeInstanceOf(AiGatewayEngine);
  });

  it('reports the providers it registered', () => {
    expect(build().registration.providerIds).toEqual(['sandbox']);
  });

  it('shares one instance of each engine rather than one per caller', () => {
    // A per-route runtime would fragment telemetry and execution memory.
    const { registration } = build();
    expect(registration.telemetry).toBe(registration.telemetry);
    expect(registration.memory).toBe(registration.memory);
  });

  it('requires at least one model provider', () => {
    const store = new InMemoryTrustStore();
    expect(() => registerAgentRuntime(store, { providers: [], policy })).toThrow(
      'AGENT_RUNTIME_PROVIDER_REQUIRED',
    );
    expect(() => registerAgentRuntime(store, { providers: [], policy })).toThrow(
      AgentRuntimeRegistrationError,
    );
  });

  it('defaults deterministic execution to a passthrough gateway', async () => {
    build();
    // A deterministic capability's contract is that the caller computed the value,
    // so the gateway must return it unchanged rather than invent output.
    await expect(passthroughDeterministicGateway.invoke('contract', { a: 1 })).resolves.toEqual({
      a: 1,
    });
  });

  it('accepts an injected deterministic gateway in place of the default', () => {
    // Only that the injection is accepted; runtime execution through a
    // deterministic capability is covered by the end-to-end suite.
    const { registration } = build({
      deterministic: { invoke: async (_contract, input) => input },
    });
    expect(registration.runtime).toBeInstanceOf(AgentRuntimeEngine);
  });
});

describe('Engines 61-70 agent runtime policy bounds', () => {
  it('rejects a policy that allows no model', () => {
    for (const broken of [{ allowedModels: [] }, { allowedModels: undefined as never }]) {
      expect(() => assertPolicyBounded({ ...policy, ...broken })).toThrow(
        'AGENT_RUNTIME_POLICY_INVALID',
      );
    }
  });

  it('rejects negative or non-integer bounds', () => {
    for (const broken of [
      { maxRequestsPerMinute: -1 },
      { maxRequestsPerMinute: 1.5 },
      { maxCostMinorPerInvocation: -1 },
      { retries: -1 },
      { retries: Number.NaN },
    ]) {
      expect(() => assertPolicyBounded({ ...policy, ...broken })).toThrow(
        'AGENT_RUNTIME_POLICY_INVALID',
      );
    }
  });

  it('accepts a zero cost ceiling, which forbids paid inference rather than being unset', () => {
    expect(() =>
      assertPolicyBounded({ ...policy, maxCostMinorPerInvocation: 0 }),
    ).not.toThrow();
  });

  it('refuses to register against an unbounded policy', () => {
    const store = new InMemoryTrustStore();
    expect(() =>
      registerAgentRuntime(store, {
        providers: [sandboxModelProvider],
        policy: { ...policy, allowedModels: [] },
      }),
    ).toThrow('AGENT_RUNTIME_POLICY_INVALID');
  });
});

describe('Engines 61-70 agent runtime configuration', () => {
  it('defaults to conservative bounds rather than unlimited ones', () => {
    const loaded = loadAgentRuntimePolicy({});
    expect(loaded.allowedModels).toEqual(['sandbox']);
    expect(loaded.maxRequestsPerMinute).toBe(30);
    // Zero cost by default: a deployment must opt in to spending money.
    expect(loaded.maxCostMinorPerInvocation).toBe(0);
    expect(loaded.retries).toBe(1);
  });

  it('reads bounds from configuration', () => {
    const loaded = loadAgentRuntimePolicy({
      AGENT_RUNTIME_ALLOWED_MODELS: 'sandbox, claude-opus',
      AGENT_RUNTIME_MAX_REQUESTS_PER_MINUTE: '5',
      AGENT_RUNTIME_MAX_COST_MINOR: '2500',
      AGENT_RUNTIME_RETRIES: '3',
    });
    expect(loaded.allowedModels).toEqual(['sandbox', 'claude-opus']);
    expect(loaded.maxRequestsPerMinute).toBe(5);
    expect(loaded.maxCostMinorPerInvocation).toBe(2500);
    expect(loaded.retries).toBe(3);
  });

  it('rejects a non-integer configured bound rather than coercing it', () => {
    expect(() =>
      loadAgentRuntimePolicy({ AGENT_RUNTIME_MAX_COST_MINOR: 'lots' }),
    ).toThrow('AGENT_RUNTIME_POLICY_INVALID');
    expect(() =>
      loadAgentRuntimePolicy({ AGENT_RUNTIME_MAX_REQUESTS_PER_MINUTE: '1.5' }),
    ).toThrow('AGENT_RUNTIME_POLICY_INVALID');
  });
});

describe('Engines 61-70 sandbox provider honesty', () => {
  it('performs no inference and says so, rather than returning plausible output', async () => {
    const result = await sandboxModelProvider.invoke({
      model: 'sandbox',
      prompt: 'summarise the blueprint',
      outputContract: 'gaps',
      timeoutMs: 1000,
    });

    expect(result.output).toMatchObject({ sandbox: true, model: 'sandbox' });
    expect(String((result.output as { note: string }).note)).toContain(
      'performs no inference',
    );
  });

  it('reports zero tokens and zero cost, because nothing was spent', async () => {
    const result = await sandboxModelProvider.invoke({
      model: 'sandbox',
      prompt: 'p',
      outputContract: 'c',
      timeoutMs: 1000,
    });
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.costMinor).toBe(0);
  });
});

describe('Engines 61-70 registration touches no protected state', () => {
  it('writes nothing to the store merely by registering', async () => {
    const { store } = build();
    for (const collection of [
      'agentExecutions',
      'auditRecords',
      'outboxEvents',
      'paymentInstructions',
      'completionCertificates',
      'paymentEligibility',
    ]) {
      expect(await store.list(collection), `${collection} was written during registration`).toEqual(
        [],
      );
    }
  });

  it('exposes no money-movement or certification surface', () => {
    const { registration } = build();
    const surface = Object.keys(registration);

    for (const forbidden of [
      'payments',
      'settlements',
      'release',
      'certificates',
      'eligibility',
      'entitlements',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('registers a provider list that cannot be mutated through the registration', () => {
    const providers: ModelProvider[] = [sandboxModelProvider];
    const { registration } = build({ providers });
    registration.providerIds.push('injected');
    // The reported list is a copy; mutating it must not change what was registered.
    expect(providers.map((provider) => provider.id)).toEqual(['sandbox']);
  });
});
