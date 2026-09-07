import {
  FlowOrchestrationEngine,
  FlowRegistry,
} from '../../../packages/flow-orchestration/src';
import { COMMERCIAL_COMMITMENT_FLOW_V1 } from '../../../packages/flow-orchestration/src/canonical-chain';
import { trustStore } from './persistence';

/**
 * Production Flow OS composition root.
 *
 * The same validated TrustPersistence selected by the web runtime backs flow state,
 * so durable deployments cannot silently fall back to an in-memory flow store.
 *
 * This source-relative import is deliberate in this slice: it keeps the frozen
 * workspace lockfile unchanged while the package remains feature-branch-local.
 * Once the package lands on main, the normal workspace dependency can be added in
 * the same commit that regenerates pnpm-lock.yaml.
 */
export const flowRegistry = new FlowRegistry();
flowRegistry.register(COMMERCIAL_COMMITMENT_FLOW_V1);

export const flowOrchestration = new FlowOrchestrationEngine(
  trustStore,
  flowRegistry,
);
