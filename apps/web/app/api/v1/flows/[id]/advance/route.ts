import { errorResponse, authorizedContextForRoute } from '../../../../../../lib/trust-app';
import { flowNotifications, flowSignalRelay, notificationEngine } from '../../../../../../lib/flow-app';

/**
 * Advances a flow from the domain events already committed for it, then notifies whoever the change
 * now requires something from.
 *
 * Gated on `executions:transition` rather than `executions:read`, because it does transition the
 * flow. That is also why the catch-up is not performed on `GET /api/v1/flows/[id]`: a principal
 * holding only read access would otherwise cause state changes by looking.
 *
 * ## Order, and why notification failure cannot fail the request
 *
 * Advance first, then dispatch notifications, then attempt delivery. The flow's correctness never
 * depends on an email: `dispatch` only records durable obligations, and `deliverPending` is wrapped
 * so that a transport outage — the shipping state of this repository, which has no email provider —
 * reports itself in the response instead of turning a successful advance into a 500. The
 * notification records are already durable by then, so nothing is lost and the next call retries.
 *
 * Idempotent throughout, so a scheduler may call it as often as it likes.
 */
export async function POST(r: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(r);
    const advanced = await flowSignalRelay.drain(context, { flowId: params.id });
    const notified = await flowNotifications.dispatch(context, { flowId: params.id });

    const delivery = await notificationEngine
      .deliverPending(context)
      .catch((error: unknown) => ({
        sent: 0,
        failed: 0,
        error: error instanceof Error ? error.message : 'NOTIFICATION_DELIVERY_FAILED',
      }));

    return Response.json({ ...advanced, notifications: { ...notified, delivery } });
  } catch (e) {
    return errorResponse(e);
  }
}
