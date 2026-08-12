import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { ConditionalReleaseOrchestrationEngine, type PaymentEligibility } from './index';

/**
 * The caller `DisputeResolutionEngine.isHeld` never had.
 *
 * CLAUDE.md hard constraint 2 — release requires no active hold — was enforced nowhere before
 * `202608110002`, and `isHeld` was a correct function with no callers. The database now refuses a
 * release-bearing write while a hold is active, for every writer. These tests cover the other half:
 * that a held request records *why* it is blocked, in the engine's own blocker vocabulary, rather
 * than the caller discovering the hold through a persistence failure.
 *
 * Enforcement is proved against a live database in
 * `packages/database-testing/src/wave5-batch-d-repository.postgres.test.ts`. This is explanation, and
 * a trigger cannot do it.
 */

const context = {
  actorUserId: 'treasury-officer',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

const stamp = '2026-08-11T09:00:00.000Z';

async function seeded() {
  const store = new InMemoryTrustStore();
  await store.append('paymentEligibilities', {
    id: 'pe-1', workspaceId: 'w', milestoneId: 'ms-1', completionCertificateId: 'cc-1',
    paymentTriggerRuleId: 'ptr-1', eligible: true, blockers: [], evaluatedBy: 'reviewer', evaluatedAt: stamp,
  });
  await store.append('financialEntitlements', {
    id: 'fe-1',
    workspaceId: 'w',
    milestoneId: 'ms-1',
    paymentEligibilityId: 'pe-1',
    currency: 'NGN',
    grossEarnedAmountMinor: 1_000_000,
    variationsAmountMinor: 0,
    retentionAmountMinor: 50_000,
    taxAmountMinor: 25_000,
    penaltyAmountMinor: 0,
    netPayableAmountMinor: 925_000,
    status: 'CONFIRMED',
    calculatedAt: stamp,
  });
  await store.append('invoices', {
    id: 'inv-1',
    workspaceId: 'w',
    milestoneId: 'ms-1',
    financialEntitlementId: 'fe-1',
    invoiceNumber: 'INV-000001',
    amountMinor: 925_000,
    currency: 'NGN',
    status: 'APPROVED',
    submittedBy: 'u-1',
    createdAt: stamp,
  });
  await store.append('fundReservations', {
    id: 'fr-1',
    workspaceId: 'w',
    fundingCommitmentId: 'fc-1',
    invoiceId: 'inv-1',
    reservedAmountMinor: 925_000,
    status: 'RESERVED',
    createdAt: stamp,
  });
  const engine = new ConditionalReleaseOrchestrationEngine(store);
  const request = await engine.draft(context, {
    milestoneId: 'ms-1',
    financialEntitlementId: 'fe-1',
    invoiceId: 'inv-1',
    fundReservationId: 'fr-1',
    releaseType: 'FULL',
    requestedAmountMinor: 925_000,
  });
  return { store, engine, request };
}

function hold(releaseRequestId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'dh-1',
    workspaceId: 'w',
    disputeId: 'dsp-1',
    releaseRequestId,
    active: true,
    placedAt: stamp,
    ...overrides,
  };
}

describe('release evaluation names an active dispute hold as a blocker', () => {
  it('reaches CONDITIONS_MET when nothing holds it', async () => {
    const { engine, request } = await seeded();
    const evaluated = await engine.evaluate(context, { id: request.id });
    expect(evaluated.status).toBe('CONDITIONS_MET');
    expect(evaluated.blockers).toEqual([]);
  });

  it('blocks with DISPUTE_HOLD_ACTIVE when a hold is active', async () => {
    const { store, engine, request } = await seeded();
    await store.append('disputeHolds', hold(request.id));
    const evaluated = await engine.evaluate(context, { id: request.id });
    expect(evaluated.status).toBe('BLOCKED');
    expect(evaluated.blockers).toEqual(['DISPUTE_HOLD_ACTIVE']);
  });

  it('reports the hold alongside every other blocker rather than instead of them', async () => {
    // A held request with an unapproved invoice has two problems, and resolving the dispute does not
    // fix the other one. A check that short-circuited would send the caller round the loop twice.
    const { store, engine, request } = await seeded();
    await store.append('disputeHolds', hold(request.id));
    await store.replace('paymentEligibilities', {
      ...(await store.list<PaymentEligibility>('paymentEligibilities'))[0], eligible: false,
    });
    const evaluated = await engine.evaluate(context, { id: request.id });
    expect(evaluated.blockers).toEqual(['PAYMENT_NOT_ELIGIBLE', 'DISPUTE_HOLD_ACTIVE']);
  });

  it('ignores a released hold, so resolving the dispute unblocks the release', async () => {
    const { store, engine, request } = await seeded();
    await store.append('disputeHolds', hold(request.id, { active: false, releasedAt: stamp }));
    const evaluated = await engine.evaluate(context, { id: request.id });
    expect(evaluated.status).toBe('CONDITIONS_MET');
  });

  it('ignores a hold on a different release request, and one in another workspace', async () => {
    const { store, engine, request } = await seeded();
    await store.append('disputeHolds', hold('rr-someone-else', { id: 'dh-other' }));
    await store.append('disputeHolds', hold(request.id, { id: 'dh-elsewhere', workspaceId: 'w-other' }));
    const evaluated = await engine.evaluate(context, { id: request.id });
    expect(evaluated.status).toBe('CONDITIONS_MET');
  });
});
