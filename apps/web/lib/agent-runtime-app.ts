import {
  loadAgentRuntimePolicy,
  registerAgentRuntime,
  sandboxModelProvider,
  type AgentRuntimeRegistration,
  type ModelProvider,
} from '@assurapay/agent-runtime';
import { trustStore } from './trust-app';

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
