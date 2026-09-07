import type { TrustPersistence } from '@assurapay/shared';
import {
  registerAgentRuntime,
  type AgentRuntimeRegistration,
  type AgentRuntimeRegistrationOptions,
} from './registration';
import { AgenticDispatchEngine, PersonaAgentRegistryEngine } from './agentic-os';

export type AgenticOsRegistration = AgentRuntimeRegistration & {
  personaAgents: PersonaAgentRegistryEngine;
  dispatch: AgenticDispatchEngine;
};

/**
 * Canonical Agentic OS composition root.
 *
 * This deliberately extends registerAgentRuntime instead of reconstructing its
 * engines. Persona autonomy therefore cannot bypass prompt, capability, context,
 * governance, telemetry, approval, model-gateway, or deterministic boundaries.
 */
export function registerAgenticOs(
  store: TrustPersistence,
  options: AgentRuntimeRegistrationOptions,
): AgenticOsRegistration {
  const runtime = registerAgentRuntime(store, options);
  const personaAgents = new PersonaAgentRegistryEngine(store);
  const dispatch = new AgenticDispatchEngine(personaAgents, runtime.runtime);

  return {
    ...runtime,
    personaAgents,
    dispatch,
  };
}
