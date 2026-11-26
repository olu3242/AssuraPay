import { describe, expect, it } from 'vitest';
import { runWorkspacePass } from './flow-app';

/**
 * One workspace pass, as assertions.
 *
 * Found by suspending a real journey through the running application and watching no email arrive.
 * The pass was three sequential awaits, so the first phase's refusal stopped the two behind it: a
 * suspended flow made `drain` throw `FLOW_NOT_EXECUTABLE`, and the notification saying the journey
 * had suspended was never raised. The relay fix in `relay.ts` stops that particular throw; this
 * stops *any* drain failure from silencing the workspace, which is the general form of the defect.
 *
 * Two properties, and they pull against each other — which is why both are asserted:
 *
 * 1. A drain failure must not stop notifications.
 * 2. A drain failure must still reach the caller, because the caller is a durable queue whose whole
 *    job is to retry and eventually dead-letter. A pass that swallowed it would report success for
 *    a workspace that is not advancing.
 */

function recorder() {
  const order: string[] = [];
  return {
    order,
    phase: (name: string, behaviour: 'ok' | 'throw' = 'ok') =>
      async () => {
        order.push(name);
        if (behaviour === 'throw') throw new Error(`${name.toUpperCase()}_FAILED`);
        return name;
      },
  };
}

describe('a failing drain does not silence the workspace', () => {
  it('still raises and still delivers notifications', async () => {
    // The assertion this file exists for.
    const { order, phase } = recorder();
    await expect(
      runWorkspacePass({
        drain: phase('drain', 'throw'),
        dispatch: phase('dispatch'),
        deliver: phase('deliver'),
      }),
    ).rejects.toThrow('DRAIN_FAILED');

    expect(order).toEqual(['drain', 'dispatch', 'deliver']);
  });

  it('rethrows the drain failure, so the queue can retry and dead-letter', async () => {
    // The counterweight. Reporting success for a workspace that is not advancing would turn a loud
    // stall into a silent one, which is the trade this pass exists to refuse.
    const { phase } = recorder();
    const failure = new Error('FLOW_NOT_EXECUTABLE');
    await expect(
      runWorkspacePass({
        drain: async () => {
          throw failure;
        },
        dispatch: phase('dispatch'),
        deliver: phase('deliver'),
      }),
    ).rejects.toBe(failure);
  });
});

describe('a failing notification phase does not stop the others', () => {
  it('delivers even when raising fails', async () => {
    // Raising reads flow state; delivery reads the notification queue. One failing is no reason to
    // leave an already-raised obligation unsent.
    const { order, phase } = recorder();
    await expect(
      runWorkspacePass({
        drain: phase('drain'),
        dispatch: phase('dispatch', 'throw'),
        deliver: phase('deliver'),
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['drain', 'dispatch', 'deliver']);
  });

  it('does not fail the pass when the transport is down', async () => {
    // A deployment with no email relay records FAILED notifications on every pass. That is the
    // honest, expected state — not a reason to make the workspace look broken and dead-letter it.
    const { order, phase } = recorder();
    await expect(
      runWorkspacePass({
        drain: phase('drain'),
        dispatch: phase('dispatch'),
        deliver: phase('deliver', 'throw'),
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['drain', 'dispatch', 'deliver']);
  });
});

describe('a healthy pass runs all three in order', () => {
  it('drains, then raises, then sends', async () => {
    // Order matters: draining can complete a journey, which is what makes the completion
    // notification raisable in the same pass rather than the next one.
    const { order, phase } = recorder();
    await runWorkspacePass({
      drain: phase('drain'),
      dispatch: phase('dispatch'),
      deliver: phase('deliver'),
    });
    expect(order).toEqual(['drain', 'dispatch', 'deliver']);
  });
});
