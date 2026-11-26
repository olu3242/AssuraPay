/**
 * The email transport boundary.
 *
 * Deliberately the same shape as `ModelProvider` in the agent runtime, and for the same reason: the
 * platform has no email provider configured, and the honest way to ship that is a transport that
 * refuses and says why — never one that accepts a message and drops it. A silent no-op transport
 * would make every notification record read `SENT` while nothing arrived, which is worse than
 * having no engine at all, because it manufactures evidence.
 *
 * Registering a real transport is a deployment change, not a code change: implement this interface
 * beside the credential handling the provider needs, and compose it in `apps/web/lib`.
 */

export type NotificationTransport = {
  id: string;
  send(input: {
    to: string;
    subject: string;
    body: string;
  }): Promise<{ providerMessageId?: string }>;
};

/**
 * The transport a deployment with no email provider gets.
 *
 * It throws, which `NotificationEngine.deliverPending` records as a `FAILED` notification carrying
 * this reason. The obligation stays durable and visible: an operator can see exactly how many
 * notifications were raised while no transport was configured.
 *
 * This comment used to end "and configuring one makes them deliverable on the next pass rather than
 * lost". That was false. `deliverPending` selects `status === 'PENDING'`, so a record it marked
 * `FAILED` is never attempted again: configuring a relay makes *later* notifications deliverable and
 * leaves the earlier ones failed for ever. Corrected rather than fixed, because fixing it means a
 * bounded retry with a delivery-attempt count on the record — so that a relay outage is retried and a
 * recipient the relay permanently rejected is not — which is a change to this engine's record shape
 * and deserves its own change.
 */
export const unconfiguredEmailTransport: NotificationTransport = {
  id: 'unconfigured',
  async send() {
    throw new Error('NOTIFICATION_TRANSPORT_NOT_CONFIGURED');
  },
};

/**
 * An in-memory transport that records what it was asked to send.
 *
 * For tests and for a local deployment that wants to see the messages without sending any. It is
 * exported rather than kept in a test file because a deployment may legitimately want it, and
 * because a test-only fork of the transport is exactly the kind of thing §19 of the convergence
 * brief forbids — the engine must behave identically whichever transport it is handed.
 */
export function createRecordingTransport(options: { id?: string; failOn?: (to: string) => boolean } = {}): NotificationTransport & {
  sent: Array<{ to: string; subject: string; body: string }>;
} {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  return {
    id: options.id ?? 'recording',
    sent,
    async send(input) {
      if (options.failOn?.(input.to)) throw new Error('TRANSPORT_REJECTED_RECIPIENT');
      sent.push(input);
      return { providerMessageId: `rec-${sent.length}` };
    },
  };
}
