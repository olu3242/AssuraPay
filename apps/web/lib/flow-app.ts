import {
  FlowOrchestrationEngine,
  FlowRegistry,
} from '@assurapay/flow-orchestration';
import { COMMERCIAL_COMMITMENT_FLOW_V1 } from '@assurapay/flow-orchestration/src/canonical-chain';
import { trustStore } from './persistence';

/**
 * Production Flow OS composition root.
 *
 * The same validated TrustPersistence selected by the web runtime backs flow state,
 * so durable deployments cannot silently fall back to an in-memory flow store.
 */
export const flowRegistry = new FlowRegistry();
flowRegistry.register(COMMERCIAL_COMMITMENT_FLOW_V1);

export const flowOrchestration = new FlowOrchestrationEngine(
  trustStore,
  flowRegistry,
);
