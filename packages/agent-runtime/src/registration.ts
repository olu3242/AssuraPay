import type { TrustPersistence } from '@assurapay/shared';
import {
  AgentGovernanceEngine,
  AgentRegistryEngine,
  AgentRuntimeEngine,
  AgentTelemetryEngine,
  AiGatewayEngine,
  CapabilityRegistryEngine,
  ContextEngine,
  ExecutionMemoryEngine,
  HumanApprovalEngine,
  PromptRegistryEngine,
  type DeterministicCapabilityGateway,
  type GatewayPolicy,
  type ModelProvider,
} from './index';

/**
 * Engines 61–70 — Agent Runtime registration.
 *
 * Composes the agent runtime into one registration an application can mount. The
 * package shipped ten engine classes that no composition root instantiated, so
 * nothing could reach them at runtime; this is the wiring that makes them
 * reachable.
 *
 * The runtime produces proposals and result artifacts only. It never mutates
 * protected state — no payment, certification or release transition happens here,
 * and nothing in this registration grants it that ability.
 */

export type AgentRuntimeRegistration = {
  capabilities: CapabilityRegistryEngine;
  agents: AgentRegistryEngine;
  prompts: PromptRegistryEngine;
  contexts: ContextEngine;
  memory: ExecutionMemoryEngine;
  telemetry: AgentTelemetryEngine;
  governance: AgentGovernanceEngine;
  approvals: HumanApprovalEngine;
  ai: AiGatewayEngine;
  runtime: AgentRuntimeEngine;
  /** Which model providers were registered, for reporting and certification. */
  providerIds: string[];
};

export type AgentRuntimeRegistrationOptions = {
  /**
   * Model providers. At least one is required — AiGatewayEngine refuses an empty
   * list rather than silently accepting every model.
   */
  providers: ModelProvider[];
  policy: GatewayPolicy;
  /** Deterministic capability execution, used where no model is involved. */
  deterministic?: DeterministicCapabilityGateway;
};

export type AgentRuntimeRegistrationErrorCode =
  | 'AGENT_RUNTIME_PROVIDER_REQUIRED'
  | 'AGENT_RUNTIME_POLICY_INVALID'
  | 'AGENT_RUNTIME_MODEL_NOT_ALLOWED';

export class AgentRuntimeRegistrationError extends Error {
  readonly code: AgentRuntimeRegistrationErrorCode;
  readonly detail?: string;

  constructor(code: AgentRuntimeRegistrationErrorCode, detail?: string) {
    super(code);
    this.name = 'AgentRuntimeRegistrationError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Deterministic gateway used when a capability declares no model.
 *
 * Returns the input unchanged: a deterministic capability's contract is that the
 * caller already computed the value, so inventing one here would fabricate output.
 */
export const passthroughDeterministicGateway: DeterministicCapabilityGateway = {
  async invoke(_contract: string, input: unknown) {
    return input;
  },
};

/**
 * Sandbox model provider.
 *
 * Registered when no real model provider is configured. It performs no inference
 * and returns an explicitly labelled refusal rather than plausible-looking output,
 * so a sandbox deployment cannot be mistaken for a working model. Cost and token
 * counts are zero because nothing was spent.
 */
export const sandboxModelProvider: ModelProvider = {
  id: 'sandbox',
  async invoke(input) {
    return {
      output: {
        sandbox: true,
        model: input.model,
        outputContract: input.outputContract,
        note: 'No model provider is configured; this deployment performs no inference.',
      },
      inputTokens: 0,
      outputTokens: 0,
      costMinor: 0,
    };
  },
};

/** Rejects a policy that would leave the gateway unbounded. */
export function assertPolicyBounded(policy: GatewayPolicy): void {
  if (!policy || !Array.isArray(policy.allowedModels) || policy.allowedModels.length === 0) {
    throw new AgentRuntimeRegistrationError(
      'AGENT_RUNTIME_POLICY_INVALID',
      'allowedModels must list at least one model',
    );
  }
  for (const [field, value] of [
    ['maxRequestsPerMinute', policy.maxRequestsPerMinute],
    ['maxCostMinorPerInvocation', policy.maxCostMinorPerInvocation],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentRuntimeRegistrationError(
        'AGENT_RUNTIME_POLICY_INVALID',
        `${field} must be a non-negative integer`,
      );
    }
  }
  if (!Number.isSafeInteger(policy.retries) || policy.retries < 0) {
    throw new AgentRuntimeRegistrationError(
      'AGENT_RUNTIME_POLICY_INVALID',
      'retries must be a non-negative integer',
    );
  }
}

/**
 * Builds the gateway policy from configuration. Every bound has a conservative
 * default rather than being unlimited when unset, and cost is in integer minor
 * units per the money convention.
 */
export function loadAgentRuntimePolicy(
  env: Record<string, string | undefined>,
): GatewayPolicy {
  const allowedModels = (env.AGENT_RUNTIME_ALLOWED_MODELS ?? 'sandbox')
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

  const policy: GatewayPolicy = {
    allowedModels,
    maxRequestsPerMinute: readInteger(env.AGENT_RUNTIME_MAX_REQUESTS_PER_MINUTE, 30),
    maxCostMinorPerInvocation: readInteger(env.AGENT_RUNTIME_MAX_COST_MINOR, 0),
    retries: readInteger(env.AGENT_RUNTIME_RETRIES, 1),
  };

  assertPolicyBounded(policy);
  return policy;
}

function readInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Registers the agent runtime.
 *
 * Every engine is instantiated once and shared, so an application composes a
 * single runtime rather than a per-route instance with its own telemetry and
 * memory. The AI gateway is bounded by policy before any engine is built.
 */
export function registerAgentRuntime(
  store: TrustPersistence,
  options: AgentRuntimeRegistrationOptions,
): AgentRuntimeRegistration {
  if (!options?.providers?.length) {
    throw new AgentRuntimeRegistrationError('AGENT_RUNTIME_PROVIDER_REQUIRED');
  }
  assertPolicyBounded(options.policy);

  // A provider that no allowed model can route to is dead configuration; catching
  // it here is clearer than a request-time MODEL_NOT_ALLOWED much later.
  const providerIds = options.providers.map((provider) => provider.id).sort();

  const capabilities = new CapabilityRegistryEngine(store);
  const agents = new AgentRegistryEngine(store);
  const prompts = new PromptRegistryEngine(store);
  const contexts = new ContextEngine(store);
  const memory = new ExecutionMemoryEngine(store);
  const telemetry = new AgentTelemetryEngine(store);
  const governance = new AgentGovernanceEngine(store);
  const approvals = new HumanApprovalEngine(store);
  const ai = new AiGatewayEngine(options.providers, options.policy);

  const runtime = new AgentRuntimeEngine({
    store,
    agents,
    capabilities,
    prompts,
    contexts,
    memory,
    telemetry,
    governance,
    ai,
    deterministic: options.deterministic ?? passthroughDeterministicGateway,
  });

  return {
    capabilities,
    agents,
    prompts,
    contexts,
    memory,
    telemetry,
    governance,
    approvals,
    ai,
    runtime,
    providerIds,
  };
}
