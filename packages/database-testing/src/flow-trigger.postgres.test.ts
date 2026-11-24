import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTrustStore, applyMigrations, withTrustScope } from '@assurapay/database';
import {
  COMMERCIAL_COMMITMENT_FLOW_V1,
  FlowOrchestrator,
  FlowRegistry,
  FlowSignalRelay,
  type StepInstance,
} from '@assurapay/flow-orchestration';
import { AgreementIntelligenceEngine } from '@assurapay/agreement-intelligence';
import type { RequestContext } from '@assurapay/shared';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: a real engine's own event advances the canonical flow, against PostgreSQL.
 *
 * This is the assertion the Flow OS audit was missing. `packages/flow-orchestration` had a complete
 * orchestrator, a canonical fourteen-step journey, durable state and a passing unit suite — and
 * nothing connected it to the domain. `dispatch` had no callers, so steps never left `READY`;
 * `DomainEventFlowBridge` had no callers, so committed domain events never became signals. The
 * journey tracking an agreement sat on step one while the engines issued certificates and submitted
 * payment instructions.
 *
 * The important word below is **own**. Step two completes because `AgreementIntelligenceEngine`
 * published a version and emitted `AgreementIntelligencePublished` itself, as it does in production.
 * The test never writes that event. Had the flow still awaited `DefinitionOfDonePackagePublished` or
 * any of the other paraphrases it used to name, this is where that would surface.
 *
 * Step one's event is written through `store.emit` — the same call the engine makes — because
 * driving `DigitalExecutionEngine` needs a signature ceremony that is its own suite's subject. That
 * boundary is stated rather than blurred: one step is proved through its real engine, the rest of
 * the vocabulary is held by `flow-trigger-coverage.test.ts`, which refuses an awaited event no
 * engine emits.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b', userId: 'user-b' };

function context(tenant: typeof TENANT_A): RequestContext {
  return {
    actorUserId: tenant.userId,
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: tenant.workspaceId,
    tenantId: tenant.tenantId,
    memberships: [tenant.workspaceId],
    correlationId: `corr-${tenant.workspaceId}`,
  };
}

function scopeOf(tenant: typeof TENANT_A) {
  return { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId, actorId: tenant.userId };
}

/** The whole migration set, in its own database, with both tenants seeded. */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

  for (const table of ['trust_tenants', 'trust_workspaces'])
    await database.sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant.tenantId})`;
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${tenant.workspaceId}, ${tenant.tenantId}, 'ACTIVE', ${database.sql.json({ id: tenant.workspaceId })}, ${'0'.repeat(64)})
      `;
    }
  } finally {
    for (const table of ['trust_tenants', 'trust_workspaces'])
      await database.sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
  return database;
}

function sharedDatabase(): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () => (pending ??= seededDatabase());
}

function flowStack(database: TestDatabase) {
  const store = new PostgresTrustStore(database.sql);
  const registry = new FlowRegistry();
  registry.register(COMMERCIAL_COMMITMENT_FLOW_V1);
  const flows = new FlowOrchestrator(store, registry);
  return {
    store,
    flows,
    relay: new FlowSignalRelay(store, flows, registry),
    intelligence: new AgreementIntelligenceEngine(store),
  };
}

/** The contract version published intelligence must hang from, per its foreign key. */
async function seedContractVersion(
  database: TestDatabase,
  tenant: typeof TENANT_A,
  contractId: string,
): Promise<void> {
  await withTrustScope(scopeOf(tenant), async () => {
    await new PostgresTrustStore(database.sql).append('contractVersionsV2', {
      id: `${contractId}-v1`,
      workspaceId: tenant.workspaceId,
      contractId,
      number: 1,
      kind: 'EXECUTED',
      documentReference: `vault://${contractId}/executed.pdf`,
      documentHash: createHash('sha256').update(`${tenant.workspaceId}:${contractId}`).digest('hex'),
      executionCertificateId: `ec-${contractId}`,
      status: 'ACTIVE',
      createdAt: '2026-08-18T09:00:00.000Z',
    });
  });
}

const REFERENCE = [{ documentVersionId: 'v1', section: 'Scope' }];

async function stepStates(
  flows: FlowOrchestrator,
  ctx: RequestContext,
  flowId: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await flows.steps(ctx, flowId)).map((step: StepInstance) => [step.stepDefinitionId, step.state]),
  );
}

describe('integration: the canonical flow advances from the domain, durably', () => {
  const database = sharedDatabase();

  it('completes step two because the engine emitted its own event', async () => {
    const contractId = 'flow-contract-1';
    const live = await database();
    await seedContractVersion(live, TENANT_A, contractId);
    const { flows, relay, intelligence, store } = flowStack(live);
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    const flow = await withTrustScope(scope, () =>
      flows.start(ctx, {
        flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
        flowVersion: 1,
        organizationId: 'org-1',
        transactionId: 'txn-1',
        agreementId: contractId,
        idempotencyKey: 'flow-durable-1',
      }),
    );

    // Step one, written the way `DigitalExecutionEngine` writes it.
    await withTrustScope(scope, () =>
      store.emit({
        tenantId: ctx.tenantId,
        workspaceId: ctx.activeWorkspaceId,
        aggregateType: 'ExecutionCertificate',
        aggregateId: `ec-${contractId}`,
        eventType: 'ExecutionCertificateIssued',
        eventVersion: 1,
        payload: { contractId },
        correlationId: ctx.correlationId,
      }),
    );

    // Step two, driven through the real engine. Nothing here writes an event.
    const version = await withTrustScope(scope, () =>
      intelligence.propose(ctx, {
        contractId,
        contractVersionId: `${contractId}-v1`,
        items: [
          {
            type: 'PARTY',
            value: { role: 'BUYER', legalName: 'Acme Ltd' },
            sourceReferences: REFERENCE,
            confidence: 0.9,
          },
        ],
      }),
    );
    await withTrustScope(scope, () =>
      intelligence.review(ctx, version.id, version.items[0].id, 'ACCEPTED'),
    );
    await withTrustScope(scope, () => intelligence.publish(ctx, version.id));

    const result = await withTrustScope(scope, () => relay.drain(ctx, { flowId: flow.id }));

    expect(result.dispatched).toBeGreaterThan(0);
    expect(result.signalled).toBeGreaterThanOrEqual(2);

    const states = await withTrustScope(scope, () => stepStates(flows, ctx, flow.id));
    expect(states['agreement-executed']).toBe('COMPLETED');
    expect(states['agreement-intelligence']).toBe('COMPLETED');
    // The next step is now waiting on its own domain event rather than on nothing.
    expect(states['blueprint']).toBe('WAITING_EVENT');

    // The event that completed step two is the engine's, carrying the engine's aggregate type.
    const signalled = result.events.find(
      (entry) => entry.eventType === 'AgreementIntelligencePublished',
    );
    expect(signalled?.outcome).toBe('SIGNALLED');
  });

  it('is idempotent across a second drain, against real transactions', async () => {
    const contractId = 'flow-contract-2';
    const live = await database();
    await seedContractVersion(live, TENANT_A, contractId);
    const { flows, relay, store } = flowStack(live);
    const ctx = context(TENANT_A);
    const scope = scopeOf(TENANT_A);

    const flow = await withTrustScope(scope, () =>
      flows.start(ctx, {
        flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
        flowVersion: 1,
        organizationId: 'org-1',
        transactionId: 'txn-2',
        agreementId: contractId,
        idempotencyKey: 'flow-durable-2',
      }),
    );
    await withTrustScope(scope, () =>
      store.emit({
        tenantId: ctx.tenantId,
        workspaceId: ctx.activeWorkspaceId,
        aggregateType: 'ExecutionCertificate',
        aggregateId: `ec-${contractId}`,
        eventType: 'ExecutionCertificateIssued',
        eventVersion: 1,
        payload: { transactionId: 'txn-2' },
        correlationId: 'corr-from-a-worker',
        // Matched on transactionId rather than correlation, which is the path a webhook takes.
      }),
    );

    const first = await withTrustScope(scope, () => relay.drain(ctx, { flowId: flow.id }));
    expect(first.signalled).toBeGreaterThanOrEqual(1);

    const second = await withTrustScope(scope, () => relay.drain(ctx, { flowId: flow.id }));
    expect(second.signalled).toBe(0);

    const states = await withTrustScope(scope, () => stepStates(flows, ctx, flow.id));
    expect(states['agreement-executed']).toBe('COMPLETED');
  });
});

describe('integration: the relay does not cross the tenancy boundary', () => {
  const database = sharedDatabase();

  it('will not advance one tenant’s flow from another tenant’s scope', async () => {
    const contractId = 'flow-contract-3';
    const live = await database();
    await seedContractVersion(live, TENANT_A, contractId);
    const { flows, relay, store } = flowStack(live);
    const ctxA = context(TENANT_A);

    const flow = await withTrustScope(scopeOf(TENANT_A), () =>
      flows.start(ctxA, {
        flowDefinitionId: 'COMMERCIAL_COMMITMENT_FLOW',
        flowVersion: 1,
        organizationId: 'org-1',
        transactionId: 'txn-3',
        agreementId: contractId,
        idempotencyKey: 'flow-durable-3',
      }),
    );
    await withTrustScope(scopeOf(TENANT_A), () =>
      store.emit({
        tenantId: ctxA.tenantId,
        workspaceId: ctxA.activeWorkspaceId,
        aggregateType: 'ExecutionCertificate',
        aggregateId: `ec-${contractId}`,
        eventType: 'ExecutionCertificateIssued',
        eventVersion: 1,
        payload: { contractId },
        correlationId: ctxA.correlationId,
      }),
    );

    // Tenant B drains. Row-level security must hide both the flow and the event.
    const asB = await withTrustScope(scopeOf(TENANT_B), () => relay.drain(context(TENANT_B)));
    expect(asB.considered).toBe(0);
    expect(asB.signalled).toBe(0);

    const states = await withTrustScope(scopeOf(TENANT_A), () => stepStates(flows, ctxA, flow.id));
    expect(states['agreement-executed']).not.toBe('COMPLETED');
  });
});
