import { expect, test, type Page } from '@playwright/test';

function uniqueEmail(label: string): string {
  return `rc1-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

async function bootstrapWorkspace(page: Page) {
  const email = uniqueEmail('performance');
  await page.goto('/start');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('display-name').fill('RC1 Performance Owner');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Registration succeeded');
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Sign-in succeeded');
  await page.getByTestId('organization-name').fill('RC1 Performance Organization');
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return workspaceId;
}

async function governedPost<T>(page: Page, path: string, data: unknown): Promise<T> {
  return await page.evaluate(
    async ({ path, data }) => {
      const sessionResponse = await fetch('/api/v1/auth/session', { cache: 'no-store' });
      if (!sessionResponse.ok) throw new Error(`session ${sessionResponse.status}`);
      const session = (await sessionResponse.json()) as { activeWorkspaceId?: string };
      const assertionResponse = await fetch('/api/v1/auth/assertion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(session.activeWorkspaceId ? { workspaceId: session.activeWorkspaceId } : {}),
      });
      if (!assertionResponse.ok) throw new Error(`assertion ${assertionResponse.status}`);
      const { assertion } = (await assertionResponse.json()) as { assertion: string };
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-assurapay-identity-assertion': assertion,
        },
        body: JSON.stringify(data),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(body)}`);
      return body as T;
    },
    { path, data },
  );
}

test.describe('browser-performance-engine-e2e: governed agreement to active blueprint', () => {
  test('runs the real blueprint engines and persists their state transitions', async ({ page }) => {
    await bootstrapWorkspace(page);

    // Phase C prerequisite: explicitly acquire canonical contract-author authority and create the contract by click.
    await page.goto('/contracts');
    await page.getByTestId('grant-contract-author').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('role assignment succeeded');
    const contractNumber = `RC1-PERF-${Date.now()}`;
    await page.getByTestId('contract-number').fill(contractNumber);
    await page.getByTestId('contract-title').fill('RC1 Working Engine Agreement');
    await page.getByTestId('contract-type').fill('COMMERCIAL');
    await page.getByTestId('create-contract').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('Contract creation succeeded');
    const contractRow = page.getByTestId('contract-row').filter({ hasText: contractNumber });
    await expect(contractRow).toBeVisible();
    const contractId = (await contractRow.locator('code').innerText()).trim();
    expect(contractId).not.toHaveLength(0);

    // These are not seeded rows or direct engine calls: the browser invokes the same governed HTTP routes
    // production clients use, under a fresh signed assertion for every mutation.
    const contractVersion = await governedPost<{ id: string }>(page, '/api/v1/contract-versions', {
      contractId,
      documentReference: `contract://${contractId}/executed-v1`,
      documentHash: `sha256-${contractId}`,
      executionCertificateId: `execution-certificate-${contractId}`,
      kind: 'EXECUTED',
    });

    const intelligence = await governedPost<{
      id: string;
      items: Array<{ id: string }>;
    }>(page, '/api/v1/agreement-intelligence', {
      contractId,
      contractVersionId: contractVersion.id,
      items: [
        {
          type: 'MILESTONE',
          value: { title: 'Primary delivery milestone' },
          sourceReferences: [
            { documentVersionId: contractVersion.id, section: 'Delivery' },
          ],
          confidence: 1,
        },
      ],
    });

    // Human review and publication use the actual Phase C browser controls.
    await page.getByTestId('intelligence-version-id').fill(intelligence.id);
    await page.getByTestId('intelligence-item-id').fill(intelligence.items[0].id);
    await page.getByTestId('accept-intelligence').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('Accept intelligence item succeeded');
    await page.getByTestId('publish-intelligence').click();
    await expect(page.getByTestId('agreement-outcome-ok')).toContainText('Publish agreement intelligence succeeded');

    // Phase D: the page does not fabricate any of the prerequisite ids above. It consumes exactly the
    // contract, executed version and published intelligence produced by the governed agreement chain.
    await page.goto('/performance');
    await expect(page.getByTestId('performance-engine-console')).toBeVisible();
    await page.getByTestId('enable-performance-planner').click();
    await expect(page.getByTestId('performance-result')).toContainText('Performance planner authority enabled');
    await page.getByTestId('performance-contract-id').fill(contractId);
    await page.getByTestId('performance-contract-version-id').fill(contractVersion.id);
    await page.getByTestId('performance-intelligence-id').fill(intelligence.id);
    await page.getByTestId('build-performance-engine').click();
    await expect(page.getByTestId('performance-result')).toContainText('Performance engine active: ACTIVE');

    const blueprintText = await page.getByTestId('performance-blueprint-id').innerText();
    const milestoneText = await page.getByTestId('performance-milestone-id').innerText();
    const blueprintId = blueprintText.replace('Blueprint:', '').trim();
    const milestoneId = milestoneText.replace('Milestone:', '').trim();
    expect(blueprintId).not.toHaveLength(0);
    expect(milestoneId).not.toHaveLength(0);

    // A second activation must fail because the first call durably transitioned DRAFT -> ACTIVE.
    // This is the engine-state proof: a cosmetic UI could report success twice; the state machine cannot.
    const repeatedActivation = await page.evaluate(async (blueprintId) => {
      const session = (await (await fetch('/api/v1/auth/session')).json()) as { activeWorkspaceId?: string };
      const assertionResponse = await fetch('/api/v1/auth/assertion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: session.activeWorkspaceId }),
      });
      const { assertion } = (await assertionResponse.json()) as { assertion: string };
      const response = await fetch(`/api/v1/performance-blueprints/${encodeURIComponent(blueprintId)}/activate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-assurapay-identity-assertion': assertion,
        },
        body: '{}',
      });
      return { ok: response.ok, status: response.status, body: await response.text() };
    }, blueprintId);
    expect(repeatedActivation.ok).toBe(false);
    expect(repeatedActivation.status).toBeGreaterThanOrEqual(400);
    expect(repeatedActivation.body).toContain('BLUEPRINT_NOT_DRAFT');
  });
});
