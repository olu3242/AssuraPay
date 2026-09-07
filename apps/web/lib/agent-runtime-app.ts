import {
  loadAgentRuntimePolicy,
  registerAgenticOs,
  sandboxModelProvider,
  type AgenticOsRegistration,
  type ModelProvider,
} from '@assurapay/agent-runtime';
import { trustStore } from './trust-app';

/**
 * Agentic OS composition for the web application.
 *
 * The existing governed Agent Runtime remains canonical. Persona assignment and
 * autonomy are mounted around it, so every dispatched persona task still passes
 * through prompt, capability, context, governance, telemetry, approval, model
 * gateway and deterministic-engine boundaries.
 */
let registration: AgenticOsRegistration | undefined;

function providers(): ModelProvider[] {
  return [sandboxModelProvider];
}

/**
 * Built on first use so an unconfigured environment still boots. The sandbox
 * provider performs no inference; a real provider remains an explicit deployment
 * configuration change rather than an implicit fallback.
 */
export function getAgentRuntime(): AgenticOsRegistration {
  registration ??= registerAgenticOs(trustStore, {
    providers: providers(),
    policy: loadAgentRuntimePolicy(process.env),
  });
  return registration;
}
