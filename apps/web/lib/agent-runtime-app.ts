import {
  loadAgentRuntimePolicy,
  registerAgentRuntime,
  sandboxModelProvider,
  type AgentRuntimeRegistration,
  type ModelProvider,
} from '@assurapay/agent-runtime';
import { ContractAnalysisEngine } from '@assurapay/agreement-intelligence';
import { AgenticDispatchEngine } from '@assurapay/agent-runtime';
import { AtlasConvergenceService } from '@assurapay/agreement-atlas';
import { intelligence, trust, trustStore } from './trust-app';
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

let atlas: AtlasConvergenceService | undefined;

/**
 * Atlas, composed against the governed runtime.
 *
 * Composed here for the same reason the analysis engine is: Atlas runs through the single shared
 * `AiGatewayEngine`, and a second instance would double every tenant's rate-limit allowance.
 *
 * The engines it is handed are the whole of its authority, and the list is worth reading for what is
 * absent. There is no payment, entitlement, certification, settlement or release engine here, so
 * Atlas cannot reach protected state even if a model instructed it to — the limit is structural
 * rather than a rule it is asked to observe. The only engine that writes authoritative state is
 * `AgreementIntelligenceEngine`, which is ordinary deterministic domain code and knows nothing about
 * agents or models.
 */
export function getAtlas(): AtlasConvergenceService {
  if (!atlas) {
    const runtime = getAgentRuntime();
    atlas = new AtlasConvergenceService({
      store: trustStore,
      runtime: runtime.runtime,
      capabilities: runtime.capabilities,
      agents: runtime.agents,
      prompts: runtime.prompts,
      governance: runtime.governance,
      contexts: runtime.contexts,
      approvals: runtime.approvals,
      trust: trust.progressiveTrust,
      publication: intelligence.structured,
      model: loadAgentRuntimePolicy(process.env).allowedModels[0],
    });
  }
  return atlas;
}

let dispatch: AgenticDispatchEngine | undefined;

/**
 * Constitutional dispatch, composed against the same governed runtime everything else uses.
 *
 * Composed here rather than left as an exported class, because the governance gate is right to
 * refuse one: `runtime/unregistered-engine` fired on the first run of this batch, and an engine
 * instantiated in no composition root is unreachable at run time. That is precisely the defect this
 * work was rebuilt to avoid — `DomainEventFlowBridge` carried a comment describing the worker that
 * would call it and had zero callers for months. A class nobody composes is a class nobody runs.
 *
 * It takes the runtime's single shared `AgentRuntimeEngine`, so a dispatched task inherits the same
 * capability contract, prompt allowlist, governance policy, rate limit and telemetry as every other
 * agent run. There is deliberately no second runtime to dispatch into.
 */
export function getAgenticDispatch(): AgenticDispatchEngine {
  if (!dispatch) {
    const runtime = getAgentRuntime();
    dispatch = new AgenticDispatchEngine({ runtime: runtime.runtime, store: trustStore });
  }
  return dispatch;
}
