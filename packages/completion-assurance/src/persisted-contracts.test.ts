import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  acceptanceDecisionSchema,
  changeApprovalSchema,
  changeRequestSchema,
  completionCertificateSchema,
  correctiveActionPlanSchema,
  inspectionSchema,
  issueRecordSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  AcceptanceDecision,
  ChangeApproval,
  ChangeRequest,
  CompletionCertificate,
  CorrectiveActionPlan,
  Inspection,
  IssueRecord,
} from './index';

/**
 * Compile-time proof that this package's exported domain types and their canonical Zod
 * schemas describe the same shape. See the companion module in
 * `packages/execution-orchestration/src/persisted-contracts.ts` for why the assertion is
 * shaped this way and why it lives in the engine package rather than the contracts package.
 *
 * Two of these are worth naming, because the schema is genuinely stricter than the type and
 * that is deliberate:
 *
 *   - `Inspection.scheduledFor` and `CorrectiveActionPlan.dueDate` are declared `string`,
 *     so an ISO datetime typechecks. Both persist to `DATE` columns, which would accept one
 *     and silently discard the time. The schema requires `YYYY-MM-DD`, matching every
 *     canonical call site, so the value is refused rather than truncated. The assertions
 *     still hold: a narrowed *value* domain does not change the *type*, which is `string`
 *     either way.
 *   - `CompletionCertificate.canonicalHash` is pinned to a 64-character hex digest. A
 *     certificate whose hash is not reproducible commits to nothing.
 *
 * The proof lives in a test file because `apps/web/tsconfig.json` compiles with `strict: false`,
 * and without `strictNullChecks` zod infers every field as optional — see the companion module in
 * `packages/execution-orchestration/src/persisted-contracts.test.ts`.
 */

export const inspectionSchemaConforms: SchemaMatchesType<
  z.infer<typeof inspectionSchema>,
  Inspection
> = true;

export const issueRecordSchemaConforms: SchemaMatchesType<
  z.infer<typeof issueRecordSchema>,
  IssueRecord
> = true;

export const correctiveActionPlanSchemaConforms: SchemaMatchesType<
  z.infer<typeof correctiveActionPlanSchema>,
  CorrectiveActionPlan
> = true;

export const changeRequestSchemaConforms: SchemaMatchesType<
  z.infer<typeof changeRequestSchema>,
  ChangeRequest
> = true;

export const changeApprovalSchemaConforms: SchemaMatchesType<
  z.infer<typeof changeApprovalSchema>,
  ChangeApproval
> = true;

export const acceptanceDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof acceptanceDecisionSchema>,
  AcceptanceDecision
> = true;

export const completionCertificateSchemaConforms: SchemaMatchesType<
  z.infer<typeof completionCertificateSchema>,
  CompletionCertificate
> = true;

describe('the canonical schemas hold the calendar-date and digest rules', () => {
  const stamp = '2026-08-10T09:00:00.000Z';

  const inspection = {
    id: 'insp-1',
    workspaceId: 'ws-1',
    workItemId: 'wi-1',
    scheduledFor: '2026-08-10',
    checklist: [{ item: 'weld-quality', required: true }],
    findings: [],
    status: 'SCHEDULED' as const,
    passed: false,
    createdAt: stamp,
  };

  it('accepts a plain calendar date where the column is DATE', () => {
    expect(inspectionSchema.safeParse(inspection).success).toBe(true);
  });

  it('refuses an ISO datetime the DATE column would silently truncate', () => {
    const result = inspectionSchema.safeParse({
      ...inspection,
      scheduledFor: '2026-08-10T13:45:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a date that looks well-formed and does not exist', () => {
    expect(
      inspectionSchema.safeParse({ ...inspection, scheduledFor: '2026-02-30' })
        .success,
    ).toBe(false);
  });

  it('applies the same rule to a corrective action plan due date', () => {
    const capa = {
      id: 'capa-1',
      workspaceId: 'ws-1',
      issueId: 'iss-1',
      actionPlan: 'Expedite via alternate supplier',
      ownerId: 'u-1',
      dueDate: '2026-08-20',
      status: 'OPEN' as const,
      createdAt: stamp,
    };
    expect(correctiveActionPlanSchema.safeParse(capa).success).toBe(true);
    expect(
      correctiveActionPlanSchema.safeParse({ ...capa, dueDate: stamp }).success,
    ).toBe(false);
  });

  it('requires a full SHA-256 digest on a completion certificate', () => {
    const certificate = {
      id: 'cert-1',
      workspaceId: 'ws-1',
      workItemId: 'wi-1',
      milestoneId: 'ms-1',
      certificateNumber: 'CERT-000001',
      acceptanceDecisionId: 'ad-1',
      canonicalHash: 'a'.repeat(64),
      status: 'CERTIFIED' as const,
      issuedBy: 'u-1',
      issuedAt: stamp,
    };
    expect(completionCertificateSchema.safeParse(certificate).success).toBe(
      true,
    );
    // A truncated or re-encoded digest verifies against nothing, which is worse than none.
    for (const canonicalHash of [
      'a'.repeat(63),
      'A'.repeat(64),
      'z'.repeat(64),
      '',
    ]) {
      expect(
        completionCertificateSchema.safeParse({ ...certificate, canonicalHash })
          .success,
        canonicalHash.slice(0, 8),
      ).toBe(false);
    }
  });

  it('permits a signed cost impact on a change request and refuses a fractional one', () => {
    // A projected delta is not a posted monetary fact, so it may be negative — but it is still
    // integer minor units.
    const request = {
      id: 'cr-1',
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      milestoneId: 'ms-1',
      changeType: 'COST' as const,
      description: 'Substitute specification',
      impact: { costAmountMinor: -50_000 },
      requestedBy: 'u-1',
      status: 'DRAFT' as const,
      createdAt: stamp,
    };
    expect(changeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      changeRequestSchema.safeParse({
        ...request,
        impact: { costAmountMinor: 12.5 },
      }).success,
    ).toBe(false);
  });

  it('refuses an issue record with an out-of-vocabulary severity, and an approval with no rationale', () => {
    expect(
      issueRecordSchema.safeParse({
        id: 'iss-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        kind: 'ISSUE',
        severity: 'CATASTROPHIC',
        description: 'x',
        status: 'OPEN',
        raisedBy: 'u-1',
        createdAt: stamp,
      }).success,
    ).toBe(false);
    expect(
      changeApprovalSchema.safeParse({
        id: 'ca-1',
        workspaceId: 'ws-1',
        changeRequestId: 'cr-1',
        approverId: 'u-1',
        decision: 'APPROVE',
        rationale: '  ',
        decidedAt: stamp,
      }).success,
    ).toBe(false);
  });

  it('accepts an acceptance decision with no conditions and no predecessor', () => {
    expect(
      acceptanceDecisionSchema.safeParse({
        id: 'ad-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        decision: 'FULL',
        rationale: 'Meets every criterion',
        conditions: [],
        status: 'ACTIVE',
        decidedBy: 'u-1',
        decidedAt: stamp,
      }).success,
    ).toBe(true);
  });
});
