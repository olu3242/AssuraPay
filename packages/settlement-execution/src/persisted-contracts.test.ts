import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  approvalThresholdSchema,
  authorizationDecisionSchema,
  financialApprovalDecisionSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type { ApprovalThreshold, AuthorizationDecision, FinancialApprovalDecision } from './index';

/**
 * Compile-time proof that this package's Batch B domain types and their canonical Zod schemas
 * describe the same shape, plus the approval-authority rules those schemas enforce.
 *
 * Segregation of duties is deliberately *not* tested here, because it cannot be: it compares an
 * approval against the authorization it approves, so no single-record schema can express it. It is
 * enforced by `FinancialApprovalAuthorityEngine` and, since `202608100002`, by the
 * `financial_approval_decisions_segregation` trigger — and it is proved against a live database in
 * `packages/database-testing/src/wave5-batch-b-repository.postgres.test.ts`. A cross-row invariant
 * asserted only in a unit test would be asserted in the one place it cannot hold.
 */

export const approvalThresholdSchemaConforms: SchemaMatchesType<
  z.infer<typeof approvalThresholdSchema>,
  ApprovalThreshold
> = true;

export const authorizationDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof authorizationDecisionSchema>,
  AuthorizationDecision
> = true;

export const financialApprovalDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof financialApprovalDecisionSchema>,
  FinancialApprovalDecision
> = true;

const stamp = '2026-08-10T09:00:00.000Z';

describe('the approval-threshold schema keeps a band meaningful', () => {
  const threshold = {
    id: 'at-1',
    workspaceId: 'ws-1',
    minAmountMinor: 0,
    maxAmountMinor: 1_000_000,
    currency: 'NGN',
    requiredApprovals: 2,
    createdAt: stamp,
  };

  it('accepts a well-formed band', () => {
    expect(approvalThresholdSchema.safeParse(threshold).success).toBe(true);
  });

  it('refuses a ceiling that does not exceed its floor', () => {
    // A band that matches nothing silently approves at no level, which reads as "configured".
    for (const maxAmountMinor of [0, 1_000_000 - 1_000_000, 999]) {
      expect(
        approvalThresholdSchema.safeParse({ ...threshold, minAmountMinor: 1_000, maxAmountMinor })
          .success,
        String(maxAmountMinor),
      ).toBe(false);
    }
  });

  it('refuses a negative floor and requires at least one approval', () => {
    expect(approvalThresholdSchema.safeParse({ ...threshold, minAmountMinor: -1 }).success).toBe(
      false,
    );
    expect(approvalThresholdSchema.safeParse({ ...threshold, requiredApprovals: 0 }).success).toBe(
      false,
    );
    expect(
      approvalThresholdSchema.safeParse({ ...threshold, requiredApprovals: 1.5 }).success,
    ).toBe(false);
  });
});

describe('the authorization and approval schemas hold their money and authority rules', () => {
  const authorization = {
    id: 'auth-1',
    workspaceId: 'ws-1',
    releaseRequestId: 'rr-1',
    requestedBy: 'u-requester',
    amountMinor: 925_000,
    currency: 'NGN',
    requiredApprovals: 2,
    status: 'PENDING' as const,
    createdAt: stamp,
  };

  it('accepts a pending authorization with no authorized timestamp', () => {
    expect(authorizationDecisionSchema.safeParse(authorization).success).toBe(true);
  });

  it('accepts an authorized one carrying its timestamp', () => {
    expect(
      authorizationDecisionSchema.safeParse({
        ...authorization,
        status: 'AUTHORIZED',
        authorizedAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses a zero-amount authorization and an unsupported currency', () => {
    expect(authorizationDecisionSchema.safeParse({ ...authorization, amountMinor: 0 }).success).toBe(
      false,
    );
    expect(authorizationDecisionSchema.safeParse({ ...authorization, currency: 'ZAR' }).success).toBe(
      false,
    );
  });

  it('requires a rationale on an approval decision', () => {
    const decision = {
      id: 'fad-1',
      workspaceId: 'ws-1',
      authorizationId: 'auth-1',
      approverId: 'u-approver',
      decision: 'APPROVE' as const,
      rationale: 'Entitlement and invoice reconcile',
      decidedAt: stamp,
    };
    expect(financialApprovalDecisionSchema.safeParse(decision).success).toBe(true);
    // Releasing money with a blank rationale is an unexplained release.
    expect(financialApprovalDecisionSchema.safeParse({ ...decision, rationale: '   ' }).success).toBe(
      false,
    );
    expect(financialApprovalDecisionSchema.safeParse({ ...decision, decision: 'DEFER' }).success).toBe(
      false,
    );
  });
});
