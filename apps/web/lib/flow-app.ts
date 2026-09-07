import {
  AssuranceRouter,
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
} from '@assurapay/flow-orchestration';
import { trustStore } from './persistence';
import {
  AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1,
  AGENTIC_FLOW_HANDLERS,
} from './agentic-flow-bridge';

/**
 * Production Flow OS composition root.
 *
 * The same validated TrustPersistence selected by the web runtime backs flow state,
 * so durable deployments cannot silently fall back to an in-memory flow store.
 *
 * Both flows are registered intentionally:
 * - COMMERCIAL_COMMITMENT_FLOW preserves the existing authoritative event-driven journey.
 * - AGENTIC_COMMERCIAL_ASSURANCE_FLOW adds governed persona-agent work between those same protected events.
 */
export const flowRegistry = new FlowRegistry();
flowRegistry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
flowRegistry.register(AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1);

export const assuranceRouting = new AssuranceRouter();

export const flowOrchestration = new FlowOrchestrator(
  trustStore,
  flowRegistry,
  AGENTIC_FLOW_HANDLERS,
);
