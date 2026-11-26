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
  createSmtpTransport,
  loadSmtpConfig,
  unconfiguredEmailTransport,
  type NotificationTransport,
} from '@assurapay/notifications';
import type { RequestContext } from '@assurapay/shared';
import { getPersistenceRuntime, trustStore } from './persistence';
import { DurableFlowRelayQueue } from './flow-relay-queue';
import { DEFAULT_INTERVAL_MS, FlowRelayWorker } from './flow-relay-worker';

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
 * The email transport this deployment sends through.
 *
 * SMTP when `ASSURAPAY_SMTP_HOST` and `ASSURAPAY_SMTP_FROM` are set; `unconfiguredEmailTransport`
 * otherwise. The second is the honest state rather than a broken one: every notification is still
 * raised and still durable, and `deliverPending` records a `FAILED` naming
 * `NOTIFICATION_TRANSPORT_NOT_CONFIGURED`, so an operator can see exactly how many obligations are
 * waiting on a relay nobody configured.
 *
 * **It does not catch up.** `deliverPending` selects `status === 'PENDING'` only, so a notification
 * that failed is never attempted again — configuring a relay makes *subsequent* notifications
 * deliverable and leaves the earlier ones failed for ever. `transport.ts` and an earlier version of
 * this comment both claimed the backlog became deliverable on the next pass; it does not, and
 * `notifications.test.ts` has always asserted the narrower truth ("does not resend an already
 * delivered notification") without anyone noticing the gap between it and the prose.
 *
 * Closing it means a bounded retry — a delivery-attempt count on the record, so a relay outage is
 * retried and a recipient the relay permanently rejected is not. That is a change to the engine's
 * record shape and is deliberately not smuggled in here.
 *
 * A *half*-configured relay throws instead, from `loadSmtpConfig`. That is deliberate and it is the
 * one case that stops the module loading: an operator who set two of the four variables believes
 * mail is working, and silently behaving like an unconfigured deployment would hide that from them
 * until someone noticed nothing had arrived.
 */
function emailTransport(): NotificationTransport {
  const smtp = loadSmtpConfig(process.env);
  return smtp ? createSmtpTransport(smtp) : unconfiguredEmailTransport;
}

/**
 * Engine 09, composed for this deployment.
 *
 * The engine was complete before this: versioned templates, masked recipients,
 * verified-address-only delivery, idempotency, suppression and per-subject delivery evidence. What
 * it lacked was anything to send through, which is what `emailTransport` now supplies.
 */
export const notificationEngine = new NotificationEngine(trustStore, emailTransport());

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

/**
 * Advancing one workspace: the exact sequence `POST /api/v1/flows/{id}/advance` performs.
 *
 * Shared with the worker rather than reimplemented, because two implementations of "advance
 * everything" would drift and the manual route would stop being a faithful way to reproduce what
 * the worker does.
 *
 * The order and its reasoning are that route's: advance, then raise notifications, then attempt
 * delivery — and a delivery failure must never fail the advance. `dispatch` records durable
 * obligations and `deliverPending` only tries to send them, so a transport outage (the shipping
 * state of this repository, which has no email provider) leaves every notification queued and
 * retried on the next pass. Letting it propagate here would turn a working relay into a workspace
 * that fails, backs off, and is eventually dead-lettered for want of an email server.
 */
/**
 * One workspace pass: drain the relay, raise notifications, send them.
 *
 * The three phases are isolated, and which failure propagates is the point.
 *
 * They used to be three sequential awaits, so a refusal from `drain` stopped the two behind it. That
 * turned one stalled journey into a workspace with no notifications at all — and the message most
 * worth sending is exactly the one about a journey that stopped. A suspended flow reproduced it
 * exactly: `drain` threw `FLOW_NOT_EXECUTABLE`, so nobody was told the journey had suspended.
 *
 * So the drain's failure is held rather than swallowed. Notifications are raised and delivered
 * whatever it did, and then it is rethrown, because the caller is a durable queue that has to record
 * the attempt, back off and eventually dead-letter. Swallowing it would trade a loud stall for a
 * silent one, which is the trade this repository keeps refusing.
 *
 * The phases are parameters so the ordering can be asserted without a database; `advanceWorkspace`
 * binds them to this deployment's composition.
 */
export async function runWorkspacePass(phases: {
  drain: () => Promise<unknown>;
  dispatch: () => Promise<unknown>;
  deliver: () => Promise<unknown>;
}): Promise<void> {
  let drainFailure: unknown;
  try {
    await phases.drain();
  } catch (error) {
    drainFailure = error;
  }

  // Raising is separate from sending, so a transport outage cannot stop an obligation being
  // recorded, and neither can a drain failure.
  await phases.dispatch().catch(() => undefined);
  await phases.deliver().catch(() => undefined);

  if (drainFailure !== undefined) throw drainFailure;
}

export async function advanceWorkspace(context: RequestContext): Promise<void> {
  await runWorkspacePass({
    drain: () => flowSignalRelay.drain(context),
    dispatch: () => flowNotifications.dispatch(context),
    deliver: () => notificationEngine.deliverPending(context),
  });
}

/**
 * The worker, built on first use and only where a database can hold its queue.
 *
 * `flow_relay_queue` needs `FOR UPDATE SKIP LOCKED` and a conditional update, so there is no
 * in-memory equivalent and none is faked: without PostgreSQL this returns `undefined` and the
 * platform behaves exactly as it did before — advanced by hand through
 * `POST /api/v1/flows/{id}/advance`. A worker backed by a process-local queue would be worse than
 * none, because two instances would each believe they had drained everything.
 *
 * Held on the module-global so a dev-server reload does not leave two workers leasing against one
 * database, the same reason the assertion replay store is held there.
 */
const globalFlow = globalThis as typeof globalThis & {
  assurapayFlowRelayWorker?: FlowRelayWorker;
  assurapayFlowRelayQueue?: DurableFlowRelayQueue;
  assurapayFlowRelayStarting?: boolean;
};

export async function getFlowRelayQueue(): Promise<DurableFlowRelayQueue | undefined> {
  const runtime = await getPersistenceRuntime();
  if (!runtime.sql) return undefined;
  return (globalFlow.assurapayFlowRelayQueue ??= new DurableFlowRelayQueue(runtime.sql));
}

export async function getFlowRelayWorker(): Promise<FlowRelayWorker | undefined> {
  const queue = await getFlowRelayQueue();
  if (!queue) return undefined;
  return (globalFlow.assurapayFlowRelayWorker ??= new FlowRelayWorker(queue, advanceWorkspace));
}

/**
 * Starts the worker, unless this deployment has asked for it to stay off.
 *
 * `ASSURAPAY_FLOW_RELAY_DISABLED` exists for one honest reason: a deployment running several web
 * instances may prefer to run the relay as its own process, and the lease makes that safe but
 * pointless to duplicate. It is not a way to switch off a failing relay quietly — a disabled relay
 * means flows do not advance, which is the condition this work exists to remove, so the state is
 * reported on startup either way.
 */
export async function startFlowRelayWorker(): Promise<FlowRelayWorker | undefined> {
  if (process.env.ASSURAPAY_FLOW_RELAY_DISABLED === 'true') {
    console.info(
      JSON.stringify({
        component: 'flow-relay',
        event: 'worker.disabled',
        detail: { reason: 'ASSURAPAY_FLOW_RELAY_DISABLED', consequence: 'flows advance only by request' },
      }),
    );
    return undefined;
  }
  const worker = await getFlowRelayWorker();
  if (!worker) {
    console.info(
      JSON.stringify({
        component: 'flow-relay',
        event: 'worker.unavailable',
        detail: { reason: 'no durable persistence', consequence: 'flows advance only by request' },
      }),
    );
    return undefined;
  }
  worker.start();
  console.info(
    JSON.stringify({
      component: 'flow-relay',
      event: 'worker.started',
      detail: { workerId: worker.workerId, intervalMs: DEFAULT_INTERVAL_MS },
    }),
  );
  return worker;
}

/** Stops the worker, for graceful shutdown. Safe to call when none was ever started. */
export function stopFlowRelayWorker(): void {
  globalFlow.assurapayFlowRelayWorker?.stop();
}

/**
 * Starts the worker on the first request this process serves, at most once.
 *
 * ## Why not `instrumentation.ts`, where this obviously belongs
 *
 * It belongs there and it cannot go there. `instrumentation.ts` is only loaded when
 * `experimental.instrumentationHook` is set, and Next compiles that file for **every** runtime it
 * builds, the edge runtime included. Importing this module from it pulls `node:crypto`, `node:fs`
 * and `node:path` — through `flow-orchestration` and `runtime` — into a bundle that cannot have
 * them, and the build fails. The `process.env.NEXT_RUNTIME` guard already in that file does not
 * help: it decides what *runs*, not what webpack resolves.
 *
 * That is also, separately, why `registerPersistenceShutdown` has never run in any deployment. The
 * repository's `next.config.js` sits at the root and `next build` runs in `apps/web`, so Next never
 * read it, so the hook was never set, so the SIGTERM handler that closes the connection pool was
 * never registered. Enabling the hook surfaces the same bundling failure. Both are reported rather
 * than papered over, because a fix is a build change and belongs in its own piece of work.
 *
 * So the worker starts from the request funnel instead. The cost is that it begins with the first
 * request rather than before it, which costs nothing here: the queue is durable and the enqueue is a
 * trigger, so every event committed before the worker started is still waiting to be drained. The
 * guard is one boolean, flipped synchronously, so a burst of simultaneous first requests starts one
 * worker rather than several.
 */
export function ensureFlowRelayWorker(): void {
  if (globalFlow.assurapayFlowRelayStarting) return;
  globalFlow.assurapayFlowRelayStarting = true;
  void startFlowRelayWorker()
    .then((worker) => {
      // The worker registers its own stop, because the place that would normally do it does not
      // run. Stopping the loop on SIGTERM keeps a pass from being cut off mid-drain; the leases it
      // holds expire on their own and the next process picks those workspaces up.
      if (!worker) return;
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => stopFlowRelayWorker());
      }
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          component: 'flow-relay',
          event: 'worker.start-failed',
          detail: {
            error: error instanceof Error ? error.message : 'unknown',
            consequence: 'flows advance only by request',
          },
        }),
      );
    });
}
