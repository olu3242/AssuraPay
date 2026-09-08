import {
  AssuranceRouter,
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
} from '@assurapay/flow-orchestration';
import { FlowRecovery } from '@assurapay/flow-orchestration/recovery';
import { trustStore } from './persistence';

/**
 * Production Flow OS composition root.
 *
 * The same validated TrustPersistence selected by the web runtime backs flow state,
 * so durable deployments cannot silently fall back to an in-memory flow store.
 */
export const flowRegistry = new FlowRegistry();
flowRegistry.register(COMMERCIAL_COMMITMENT_FLOW_V1);

export const assuranceRouting = new AssuranceRouter();

export const flowOrchestration = new FlowOrchestrator(
  trustStore,
  flowRegistry,
);

export const flowRecovery = new FlowRecovery(trustStore);
