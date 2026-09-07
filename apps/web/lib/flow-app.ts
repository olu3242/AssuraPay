import {
  AssuranceRoutingEngine,
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrationEngine,
  FlowRegistry,
} from '@assurapay/flow-orchestration';
import { trustStore } from './persistence';

/**
 * Production Flow OS composition root.
 *
 * The same validated TrustPersistence selected by the web runtime backs flow state,
 * so durable deployments cannot silently fall back to an in-memory flow store.
 */
export const flowRegistry = new FlowRegistry();
flowRegistry.register(COMMERCIAL_COMMITMENT_FLOW_V1);

export const assuranceRouting = new AssuranceRoutingEngine();

export const flowOrchestration = new FlowOrchestrationEngine(
  trustStore,
  flowRegistry,
);
