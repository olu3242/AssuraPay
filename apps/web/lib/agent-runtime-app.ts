import {
  loadAgentRuntimePolicy,
  registerAgentRuntime,
  sandboxModelProvider,
  type AgentRuntimeRegistration,
  type ModelProvider,
} from '@assurapay/agent-runtime';
import { ContractAnalysisEngine } from '@assurapay/agreement-intelligence';
import { trustStore } from './trust-app';
import { createGovernedAnalysisGateway } from './governed-analysis';

/**
 * Agent Runtime composition for the web application.
 *
 * The runtime is mounted once and shared, so telemetry and execution memory stay
 * coherent across requests rather than being fragmented per route.
 *
 * The runtime produces proposals and result artifacts. It mutates no payment,
 * certification or release state, and nothing here grants it that ability.
 */

let registration: AgentRuntimeRegistration | undefined;

/**
 * Model providers for this deployment.
 *
 * Only the sandbox provider is registered: no real model provider is configured
 * for this repository, and the sandbox provider performs no inference and says so
 * rather than returning plausible-looking output. Registering a real provider is a
 * configuration change, not a code change — add it here alongside the credential
 * handling its API requires.
 */
function providers(): ModelProvider[] {
  return [sandboxModelProvider];
}

/**
 * Built on first use so an unconfigured environment still boots, and so a policy
 * misconfiguration surfaces on the paths that use the runtime rather than at
 * import time.
 */
export function getAgentRuntime(): AgentRuntimeRegistration {
  registration ??= registerAgentRuntime(trustStore, {
    providers: providers(),
    policy: loadAgentRuntimePolicy(process.env),
  });
  return registration;
}

let analysis: ContractAnalysisEngine | undefined;

/**
 * Contract analysis, with its model access governed.
 *
 * This is the convergence the AI audit called for. The engine used to be composed in `trust-app.ts`
 * with `deterministicAnalysisGateway`, which meant the one reachable AI path in the product — `POST
 * /api/v1/contract-analysis` with `method: 'AI_ASSISTED'` — bypassed `AiGatewayEngine` entirely and
 * so inherited no model allowlist, rate limit, timeout, cost ceiling or telemetry.
 *
 * It is composed here because the gateway it must use is the runtime's single shared
 * `AiGatewayEngine`: that engine keeps its per-tenant rate-limit window in process memory, so a
 * second instance would silently double every tenant's allowance.
 *
 * The model is read from the same `AGENT_RUNTIME_ALLOWED_MODELS` policy the gateway enforces, so a
 * deployment cannot configure an analysis model the gateway would then refuse. With nothing
 * configured that is `sandbox`, which performs no inference and says so.
 */
export function getGovernedContractAnalysis(): ContractAnalysisEngine {
  if (!analysis) {
    const runtime = getAgentRuntime();
    const policy = loadAgentRuntimePolicy(process.env);
    analysis = new ContractAnalysisEngine(
      trustStore,
      createGovernedAnalysisGateway(runtime.ai, {
        // The first allowlisted model, so the analysis path can never name one the gateway would
        // reject. `assertPolicyBounded` has already refused an empty list.
        model: policy.allowedModels[0],
        promptVersion: ANALYSIS_PROMPT_VERSION,
      }),
    );
  }
  return analysis;
}

/**
 * The analysis prompt's version, recorded on every `AnalysisRun`.
 *
 * A constant rather than configuration: it identifies the prompt this code sends, so it belongs with
 * the code that sends it and must change when that prompt changes. An analysis whose prompt cannot
 * be named cannot be replayed, which would make its findings evidence of nothing.
 */
export const ANALYSIS_PROMPT_VERSION = 'contract-analysis/1';
