import {
  AssuranceRouter,
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
  FlowSignalRelay,
} from '@assurapay/flow-orchestration';
import {
  FlowNotificationDispatcher,
  NotificationEngine,
  unconfiguredEmailTransport,
} from '@assurapay/notifications';
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

/**
 * Engine 09, composed for this deployment.
 *
 * The transport is `unconfiguredEmailTransport`, because no email provider is configured for this
 * repository. That is a deliberate, visible state rather than a silent one: every notification is
 * raised and stays durable, and `deliverPending` records an honest `FAILED` naming
 * `NOTIFICATION_TRANSPORT_NOT_CONFIGURED`. Configuring a real transport makes the queue deliverable
 * on the next pass rather than having lost anything.
 *
 * Registering one is a deployment change: implement `NotificationTransport` beside whatever
 * credential handling the provider needs and swap it in here.
 */
export const notificationEngine = new NotificationEngine(
  trustStore,
  unconfiguredEmailTransport,
);

/**
 * The dispatcher that raises notifications from changes in the flow process.
 *
 * The step-title resolver reads the same registry the orchestrator enforces, so an email names a
 * step the way the product does rather than by its internal id.
 */
export const flowNotifications = new FlowNotificationDispatcher(
  trustStore,
  notificationEngine,
  ({ flowDefinitionId, stepDefinitionId }) => {
    for (const version of [1]) {
      try {
        const definition = flowRegistry.get(flowDefinitionId, version);
        const step = definition.steps.find((candidate) => candidate.id === stepDefinitionId);
        if (step?.title) return step.title;
      } catch {
        // An unregistered definition is not a reason to fail a notification; the dispatcher falls
        // back to a readable form of the step id.
      }
    }
    return undefined;
  },
);
