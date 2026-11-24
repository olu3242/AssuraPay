import {
  AssuranceRouter,
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
  FlowSignalRelay,
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

export const assuranceRouting = new AssuranceRouter();

export const flowOrchestration = new FlowOrchestrator(
  trustStore,
  flowRegistry,
);

/**
 * The driver that makes the canonical journey advance from domain events.
 *
 * Without it Flow OS was inert in two places at once: nothing moved a READY step into
 * WAITING_EVENT (`dispatch` had no callers), and nothing turned a committed domain event into a
 * signal (`DomainEventFlowBridge` had no callers either). Engines were issuing certificates and
 * submitting payment instructions while the flow tracking that journey sat on its first step.
 *
 * It takes the same registry the orchestrator was built with, so the definitions it reads to decide
 * which event a step awaits are the ones the orchestrator enforces.
 */
export const flowSignalRelay = new FlowSignalRelay(
  trustStore,
  flowOrchestration,
  flowRegistry,
);
