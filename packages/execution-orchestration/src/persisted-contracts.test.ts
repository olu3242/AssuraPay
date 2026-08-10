import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  defectSchema,
  evidencePackageSchema,
  evidenceRequirementSchema,
  executionWorkspaceSchema,
  progressRecordSchema,
  qualityGateResultSchema,
  qualityPlanSchema,
  validationTestSchema,
  workItemSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  Defect,
  EvidencePackage,
  EvidenceRequirement,
  ExecutionWorkspace,
  ProgressRecord,
  QualityGateResult,
  QualityPlan,
  ValidationTest,
  WorkItem,
} from './index';

/**
 * Compile-time proof that this package's exported domain types and their canonical Zod
 * schemas describe the same shape.
 *
 * Two hand-written definitions of one aggregate can drift, and drift here is not a
 * cosmetic problem: the schema decides what the store accepts and the type decides what the
 * engine may construct, so a divergence is a record the engine can build and the store
 * refuses, or a record the store accepts and no reader can use.
 *
 * `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` prefers a schema with an inferred type, and
 * requires this pattern instead where a type is already canonical — which is the case for
 * all nine aggregates below. They are exported, imported across packages, and contain no
 * `any`; replacing them with inferred types would change published contracts as a side
 * effect of adding validation. The assertions are what make one of the two derived in
 * effect: the annotation is `never` when the shapes disagree, nothing is assignable to
 * `never`, and `pnpm typecheck` fails at the declaration rather than at a call site.
 *
 * Assertions live here rather than in the contracts package because this package owns the
 * types; the contracts package must not import an engine.
 *
 * And they live in a *test* file rather than in the package's public surface for a reason worth
 * recording, because the alternative looks better and does not work. `apps/web/tsconfig.json`
 * compiles with `strict: false`, and without `strictNullChecks` zod's `addQuestionMarks` sees
 * `undefined extends T[k]` as true for every key — so every inferred field becomes optional and
 * an identity assertion against a type with required fields resolves to `never`. Exporting these
 * from `index.ts` therefore broke `pnpm build` while `pnpm typecheck` passed. A test file is not
 * imported by the application, so the proof is checked exactly where the information it depends
 * on exists: the root `tsconfig.json`, which is `strict`, and which `pnpm typecheck` and
 * `repo:certify` both run.
 */

export const executionWorkspaceSchemaConforms: SchemaMatchesType<
  z.infer<typeof executionWorkspaceSchema>,
  ExecutionWorkspace
> = true;

export const workItemSchemaConforms: SchemaMatchesType<
  z.infer<typeof workItemSchema>,
  WorkItem
> = true;

export const progressRecordSchemaConforms: SchemaMatchesType<
  z.infer<typeof progressRecordSchema>,
  ProgressRecord
> = true;

export const evidenceRequirementSchemaConforms: SchemaMatchesType<
  z.infer<typeof evidenceRequirementSchema>,
  EvidenceRequirement
> = true;

export const evidencePackageSchemaConforms: SchemaMatchesType<
  z.infer<typeof evidencePackageSchema>,
  EvidencePackage
> = true;

export const validationTestSchemaConforms: SchemaMatchesType<
  z.infer<typeof validationTestSchema>,
  ValidationTest
> = true;

export const qualityPlanSchemaConforms: SchemaMatchesType<
  z.infer<typeof qualityPlanSchema>,
  QualityPlan
> = true;

export const defectSchemaConforms: SchemaMatchesType<
  z.infer<typeof defectSchema>,
  Defect
> = true;

export const qualityGateResultSchemaConforms: SchemaMatchesType<
  z.infer<typeof qualityGateResultSchema>,
  QualityGateResult
> = true;

describe('the canonical schemas accept what the engines write', () => {
  it('accepts a well-formed aggregate of each shape', () => {
    const stamp = '2026-08-10T09:00:00.000Z';
    expect(
      executionWorkspaceSchema.safeParse({
        id: 'exec-1',
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        milestoneId: 'ms-1',
        status: 'DRAFT',
        createdAt: stamp,
      }).success,
    ).toBe(true);
    // Optional money absent, which is every stage but FINANCIALLY_EARNED.
    expect(
      progressRecordSchema.safeParse({
        id: 'p-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        stage: 'DECLARED',
        percentComplete: 10,
        reportedBy: 'u-1',
        createdAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown field rather than dropping it', () => {
    // Every schema is strict. The relational writer has a column per field and would silently
    // discard anything else, so a permissive schema turns an added field into data loss.
    const result = executionWorkspaceSchema.safeParse({
      id: 'exec-1',
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      milestoneId: 'ms-1',
      status: 'DRAFT',
      createdAt: '2026-08-10T09:00:00.000Z',
      smuggled: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a blank identifier and a blank required string', () => {
    const result = workItemSchema.safeParse({
      id: '',
      workspaceId: 'ws-1',
      executionWorkspaceId: 'exec-1',
      deliverableId: 'del-1',
      title: '   ',
      assigneeId: 'u-1',
      status: 'ASSIGNED',
      createdAt: '2026-08-10T09:00:00.000Z',
      updatedAt: '2026-08-10T09:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(
      result.success
        ? []
        : result.error.issues.map((issue) => issue.path.join('.')),
    ).toEqual(expect.arrayContaining(['id', 'title']));
  });

  it('refuses a negative earned value and a fractional one', () => {
    // Integer minor units, non-negative. Nothing enforced either before this schema existed.
    for (const earnedValueAmountMinor of [-1, 12.5]) {
      expect(
        progressRecordSchema.safeParse({
          id: 'p-1',
          workspaceId: 'ws-1',
          workItemId: 'wi-1',
          stage: 'FINANCIALLY_EARNED',
          percentComplete: 100,
          earnedValueAmountMinor,
          reportedBy: 'u-1',
          createdAt: '2026-08-10T09:00:00.000Z',
        }).success,
      ).toBe(false);
    }
  });

  it('refuses an evidence package with no files', () => {
    // Matching CHECK (jsonb_array_length(files) > 0) and the engine's EVIDENCE_FILE_REQUIRED.
    expect(
      evidencePackageSchema.safeParse({
        id: 'ep-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        deliverableId: 'del-1',
        files: [],
        chainOfCustody: [],
        status: 'SUBMITTED',
        createdAt: '2026-08-10T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('refuses a local timestamp with no zone', () => {
    // A value that reads as correct and means a different instant in every deployment.
    expect(
      qualityGateResultSchema.safeParse({
        id: 'qg-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        passed: true,
        openDefectCount: 0,
        criticalDefectCount: 0,
        evaluatedAt: '2026-08-10 09:00:00',
      }).success,
    ).toBe(false);
  });

  it('accepts a defect without a root cause and rejects a blank one', () => {
    const base = {
      id: 'd-1',
      workspaceId: 'ws-1',
      workItemId: 'wi-1',
      severity: 'MINOR' as const,
      description: 'Hairline crack',
      status: 'OPEN' as const,
      raisedBy: 'u-1',
      createdAt: '2026-08-10T09:00:00.000Z',
    };
    expect(defectSchema.safeParse(base).success).toBe(true);
    expect(defectSchema.safeParse({ ...base, rootCause: '  ' }).success).toBe(
      false,
    );
  });

  it('requires a quality plan to name at least one standard, and a validation test to allow empty notes', () => {
    const stamp = '2026-08-10T09:00:00.000Z';
    expect(
      qualityPlanSchema.safeParse({
        id: 'qp-1',
        workspaceId: 'ws-1',
        executionWorkspaceId: 'exec-1',
        standards: [],
        inspectionFrequency: 'WEEKLY',
        status: 'ACTIVE',
        createdAt: stamp,
      }).success,
    ).toBe(false);
    // `notes` is TEXT NOT NULL and the engine requires content only for a conditional pass, so
    // demanding it always would reject a recorded outright pass.
    expect(
      validationTestSchema.safeParse({
        id: 'vt-1',
        workspaceId: 'ws-1',
        workItemId: 'wi-1',
        acceptanceCriterionId: 'ac-1',
        method: 'MANUAL',
        result: 'PASS',
        notes: '',
        testedBy: 'u-1',
        testedAt: stamp,
      }).success,
    ).toBe(true);
    expect(evidenceRequirementSchema.safeParse({ id: 'r-1' }).success).toBe(
      false,
    );
  });
});
