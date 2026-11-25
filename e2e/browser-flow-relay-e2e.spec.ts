import { expect, test, type Page } from '@playwright/test';

/**
 * browser-flow-relay-e2e — the chain advances without anyone asking it to.
 *
 * This is the one assertion AG01 is actually about, and the only place it can be made. Every other
 * suite proves a piece: the queue's leases against real PostgreSQL, the loop's failure isolation in
 * memory, the worker's lack of authority from its context. None of them proves the thing that was
 * wrong — that `FlowSignalRelay.drain` had one caller and it was a person.
 *
 * So this runs the production build with its real instrumentation, commits a domain event the
 * ordinary way through the API, and then **never calls `/advance`**. If the relay works, the
 * workspace is claimed, drained and recorded by a worker nobody asked. If it does not, the status
 * route keeps reporting the workspace as due for ever, which is precisely the silent stall this work
 * exists to remove — and the test fails on a timeout rather than passing on a technicality.
 */

function uniqueEmail(label: string): string {
  return `relay-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function foundWorkspace(page: Page, label: string): Promise<{ workspaceId: string }> {
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Relay ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await page.getByTestId('organization-name').fill(`Relay ${label} Organization`);
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return { workspaceId };
}

async function assertion(page: Page, workspaceId: string): Promise<Record<string, string>> {
  const response = await page.request.post('/api/v1/auth/assertion', { data: { workspaceId } });
  expect(response.ok()).toBe(true);
  const { assertion: token } = (await response.json()) as { assertion: string };
  return { 'x-assurapay-identity-assertion': token };
}

type RelayStatus = {
  worker: string;
  workspace?: string;
  due?: boolean;
  attempts?: number;
  lastDrainedAt?: string;
  deadLettered?: boolean;
};

async function status(page: Page, workspaceId: string): Promise<RelayStatus> {
  const response = await page.request.get('/api/v1/flow-relay/status', {
    headers: await assertion(page, workspaceId),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as RelayStatus;
}

test.describe('browser-flow-relay-e2e: the relay runs itself', () => {
  test('drains the events founding itself commits', async ({ page }) => {
    // Written expecting NO_ORCHESTRATED_EVENTS and corrected: founding a tenant *is* orchestrated
    // activity — it creates a workspace, grants a membership and commits those events — so no
    // workspace is ever event-free. The stronger assertion is the one that premise was hiding:
    // founding alone is enough to put a workspace in the queue, and the worker drains it unasked.
    const { workspaceId } = await foundWorkspace(page, 'fresh');
    const initial = await status(page, workspaceId);
    expect(initial.worker).toBe('RUNNING');
    expect(initial.workspace).not.toBe('NO_ORCHESTRATED_EVENTS');

    await expect
      .poll(
        async () => (await status(page, workspaceId)).workspace,
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 3_000, 5_000],
          message: 'founding committed events that the relay never drained',
        },
      )
      .toBe('UP_TO_DATE');
  });

  test('claims, drains and records a workspace with no human asking it to', async ({ page }) => {
    const { workspaceId } = await foundWorkspace(page, 'advance');
    const headers = await assertion(page, workspaceId);

    // Grant the role that can author a contract, which is what commits the domain event. The
    // founding administrator deliberately cannot.
    const granted = await page.request.post('/api/v1/roles/assignments', {
      headers,
      data: { userId: (await page.getByTestId('session-user').innerText()).trim(), role: 'CONTRACT_AUTHOR' },
    });
    expect(granted.status(), await granted.text()).toBe(201);

    // The ordinary way an engine commits an authoritative event: a real API call. Nothing here
    // touches the queue, the outbox or the relay — the enqueue is a database trigger precisely so no
    // caller has to know it exists.
    const created = await page.request.post('/api/v1/contracts', {
      headers: await assertion(page, workspaceId),
      data: {
        contractNumber: `RELAY-${Date.now()}`,
        title: 'Relay-driven procurement',
        contractType: 'PROCUREMENT',
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    // From here on, no `/advance` call. The worker's interval is five seconds, so a generous window
    // still fails well inside the test timeout if nothing is running.
    await expect
      .poll(
        async () => {
          const current = await status(page, workspaceId);
          return current.lastDrainedAt ? 'drained' : (current.workspace ?? current.worker);
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 3_000, 5_000],
          message:
            'the relay worker never drained this workspace — a committed domain event left the ' +
            'flow where it was, which is the stall this work exists to remove',
        },
      )
      .toBe('drained');

    const settled = await status(page, workspaceId);
    // Drained, not merely attempted: no failures recorded and nothing outstanding.
    expect(settled.workspace).toBe('UP_TO_DATE');
    expect(settled.due).toBe(false);
    expect(settled.attempts).toBe(0);
    expect(settled.deadLettered).toBe(false);
    expect(settled.lastDrainedAt).toBeTruthy();
  });

  test('keeps draining as new events arrive, rather than once per workspace', async ({ page }) => {
    const { workspaceId } = await foundWorkspace(page, 'repeat');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await page.request.post('/api/v1/roles/assignments', {
      headers: await assertion(page, workspaceId),
      data: { userId, role: 'CONTRACT_AUTHOR' },
    });

    async function commitContract(suffix: string): Promise<void> {
      const response = await page.request.post('/api/v1/contracts', {
        headers: await assertion(page, workspaceId),
        data: {
          contractNumber: `RELAY-${suffix}-${Date.now()}`,
          title: `Relay contract ${suffix}`,
          contractType: 'PROCUREMENT',
        },
      });
      expect(response.status(), await response.text()).toBe(201);
    }

    async function waitForDrain(after?: string): Promise<string> {
      let seen = after;
      await expect
        .poll(
          async () => {
            const current = await status(page, workspaceId);
            if (current.lastDrainedAt && current.lastDrainedAt !== after) {
              seen = current.lastDrainedAt;
              return true;
            }
            return false;
          },
          { timeout: 60_000, intervals: [1_000, 2_000, 3_000, 5_000] },
        )
        .toBe(true);
      return seen!;
    }

    await commitContract('first');
    const first = await waitForDrain();

    // The second event is the real assertion. A worker that cleared the workspace and never looked
    // again would leave this one undrained for ever, and `enqueued_seq` is what makes the row due a
    // second time.
    await commitContract('second');
    const second = await waitForDrain(first);
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });
});

test.describe('browser-flow-relay-e2e: the status route is governed', () => {
  test('refuses the relay status with no session', async ({ request }) => {
    const response = await request.get('/api/v1/flow-relay/status');
    expect(response.ok()).toBe(false);
  });

  test('tells a tenant about its own workspace and never about another', async ({ page }) => {
    // The disclosure boundary. The queue table is unscoped so a worker can find work before it knows
    // whose it is; the route must not pass that view on. A response naming any workspace but the
    // caller's own would be a cross-tenant leak.
    const { workspaceId } = await foundWorkspace(page, 'scoped');
    const response = await page.request.get('/api/v1/flow-relay/status', {
      headers: await assertion(page, workspaceId),
    });
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    // No list, and no identifier of anything the caller does not own.
    expect(body).not.toContain('deadLettered"[]');
    expect(body).not.toMatch(/"tenantId"/);
    expect(body).not.toMatch(/"workspaceId"/);
  });
});
