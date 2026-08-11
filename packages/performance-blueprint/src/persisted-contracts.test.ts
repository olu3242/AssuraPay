import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  blueprintMilestoneSchema,
  deliverableSchema,
  dodPackageSchema,
  milestoneSequenceEdgeSchema,
  performanceBlueprintSchema,
  scopeItemSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  BlueprintMilestone,
  Deliverable,
  DodPackage,
  MilestoneSequenceEdge,
  PerformanceBlueprint,
  ScopeItem,
} from './index';

/**
 * Compile-time proof that this package's Batch E domain types and their canonical Zod schemas describe
 * the same shape, plus the rules those schemas enforce.
 *
 * Two cross-row invariants are deliberately absent, because a single-record schema cannot express
 * either:
 *
 *   - **the blueprint's total value allocation**, which `activate` bounds at 100% across every
 *     SCHEDULED milestone. It is a sum over a set with no completion signal, so it is not enforced in
 *     the database either — recorded as a gap in the activation document rather than approximated;
 *   - **acyclicity of the milestone sequence graph** beyond a self-edge. A cycle of length two or more
 *     is a property of the whole graph.
 *
 * The same division as segregation of duties in Batch B, journal balance in Batch C and hold
 * enforcement in Batch D: a cross-row invariant asserted only in a unit test would be asserted in the
 * one place it cannot hold.
 */

export const performanceBlueprintSchemaConforms: SchemaMatchesType<
  z.infer<typeof performanceBlueprintSchema>,
  PerformanceBlueprint
> = true;

export const scopeItemSchemaConforms: SchemaMatchesType<z.infer<typeof scopeItemSchema>, ScopeItem> =
  true;

export const deliverableSchemaConforms: SchemaMatchesType<
  z.infer<typeof deliverableSchema>,
  Deliverable
> = true;

export const blueprintMilestoneSchemaConforms: SchemaMatchesType<
  z.infer<typeof blueprintMilestoneSchema>,
  BlueprintMilestone
> = true;

export const milestoneSequenceEdgeSchemaConforms: SchemaMatchesType<
  z.infer<typeof milestoneSequenceEdgeSchema>,
  MilestoneSequenceEdge
> = true;

export const dodPackageSchemaConforms: SchemaMatchesType<z.infer<typeof dodPackageSchema>, DodPackage> =
  true;

const stamp = '2026-08-11T09:00:00.000Z';

describe('the blueprint schema keeps a revision citable', () => {
  const blueprint = {
    id: 'bp-1',
    workspaceId: 'ws-1',
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    agreementIntelligenceVersionId: 'aiv-1',
    version: 1,
    status: 'DRAFT' as const,
    createdBy: 'u-1',
    createdAt: stamp,
    contentHash: 'a3f1c9',
  };

  it('accepts every state the engine moves a blueprint through', () => {
    for (const status of ['DRAFT', 'ACTIVE', 'SUPERSEDED']) {
      expect(performanceBlueprintSchema.safeParse({ ...blueprint, status }).success, status).toBe(
        true,
      );
    }
  });

  it('refuses a revision below one, or a fractional one', () => {
    // `draft` computes the revision by counting existing rows, so the first is one. There is no
    // revision zero, and half a revision is not a revision.
    for (const version of [0, -1, 1.5]) {
      expect(
        performanceBlueprintSchema.safeParse({ ...blueprint, version }).success,
        String(version),
      ).toBe(false);
    }
  });

  it('refuses a blank content hash, which is what makes it citable', () => {
    expect(performanceBlueprintSchema.safeParse({ ...blueprint, contentHash: '' }).success).toBe(
      false,
    );
    expect(performanceBlueprintSchema.safeParse({ ...blueprint, contentHash: '  ' }).success).toBe(
      false,
    );
  });
});

describe('the scope and deliverable schemas keep a plan answerable', () => {
  const scopeItem = {
    id: 'si-1',
    workspaceId: 'ws-1',
    blueprintId: 'bp-1',
    kind: 'INCLUDED' as const,
    description: 'Foundation works to slab level',
    assumptions: ['Site access from week 1'],
    constraints: ['No weekend working'],
    ownerId: 'u-1',
    status: 'DRAFT' as const,
    createdAt: stamp,
  };

  it('accepts an exclusion as readily as an inclusion', () => {
    // A dispute over whether work was in scope is decided against this field, so an exclusion is as
    // load-bearing as an inclusion.
    expect(scopeItemSchema.safeParse(scopeItem).success).toBe(true);
    expect(scopeItemSchema.safeParse({ ...scopeItem, kind: 'EXCLUDED' }).success).toBe(true);
    expect(scopeItemSchema.safeParse({ ...scopeItem, kind: 'MAYBE' }).success).toBe(false);
  });

  it('refuses a blank assumption or constraint rather than storing an empty one', () => {
    expect(scopeItemSchema.safeParse({ ...scopeItem, assumptions: [''] }).success).toBe(false);
    expect(scopeItemSchema.safeParse({ ...scopeItem, constraints: ['   '] }).success).toBe(false);
  });

  const deliverable = {
    id: 'dl-1',
    workspaceId: 'ws-1',
    blueprintId: 'bp-1',
    scopeItemId: 'si-1',
    title: 'Reinforced slab',
    quantity: 2.5,
    unit: 'tonnes',
    qualityStandard: 'BS 8500-1',
    ownerId: 'u-1',
    dueDate: '2026-09-30',
    acceptanceCriteria: ['Cube test at 28 days'],
    evidenceRequirements: ['Laboratory certificate'],
    status: 'DRAFT' as const,
    createdAt: stamp,
  };

  it('accepts a fractional quantity, because a quantity is not an amount', () => {
    expect(deliverableSchema.safeParse(deliverable).success).toBe(true);
    for (const quantity of [0, -1]) {
      expect(deliverableSchema.safeParse({ ...deliverable, quantity }).success, String(quantity)).toBe(
        false,
      );
    }
  });

  it('refuses a deliverable nobody can accept or evidence', () => {
    expect(deliverableSchema.safeParse({ ...deliverable, acceptanceCriteria: [] }).success).toBe(
      false,
    );
    expect(deliverableSchema.safeParse({ ...deliverable, evidenceRequirements: [] }).success).toBe(
      false,
    );
  });

  it('requires a calendar date, and refuses a datetime for one', () => {
    // The Batch A lesson: `dueDate` is typed `string`, so an ISO datetime typechecks and the DATE
    // column would accept it and discard the time.
    expect(deliverableSchema.safeParse({ ...deliverable, dueDate: stamp }).success).toBe(false);
    expect(deliverableSchema.safeParse({ ...deliverable, dueDate: '2026-02-30' }).success).toBe(false);
  });
});

describe('the milestone schema holds its money and its dates', () => {
  const milestone = {
    id: 'ms-1',
    workspaceId: 'ws-1',
    blueprintId: 'bp-1',
    title: 'Slab complete',
    deliverableIds: ['dl-1'],
    startDate: '2026-09-01',
    dueDate: '2026-09-30',
    budgetAmountMinor: 5_000_000,
    currency: 'NGN',
    valueAllocationPercent: 25,
    status: 'SCHEDULED' as const,
    createdAt: stamp,
  };

  it('accepts a well-formed milestone', () => {
    expect(blueprintMilestoneSchema.safeParse(milestone).success).toBe(true);
  });

  it('applies the money rules outside the settlement batches', () => {
    // MONETARY_INVARIANTS governs representation wherever an amount exists, not only where it moves.
    for (const budgetAmountMinor of [0, -1, 1_000.5]) {
      expect(
        blueprintMilestoneSchema.safeParse({ ...milestone, budgetAmountMinor }).success,
        String(budgetAmountMinor),
      ).toBe(false);
    }
    expect(blueprintMilestoneSchema.safeParse({ ...milestone, currency: 'GBP' }).success).toBe(false);
  });

  it('refuses a milestone due before it starts', () => {
    expect(
      blueprintMilestoneSchema.safeParse({ ...milestone, dueDate: '2026-08-31' }).success,
    ).toBe(false);
    // Equal dates are a same-day milestone, which is legitimate.
    expect(
      blueprintMilestoneSchema.safeParse({ ...milestone, dueDate: milestone.startDate }).success,
    ).toBe(true);
  });

  it('bounds value allocation above zero and at one hundred', () => {
    expect(blueprintMilestoneSchema.safeParse({ ...milestone, valueAllocationPercent: 0 }).success).toBe(
      false,
    );
    expect(
      blueprintMilestoneSchema.safeParse({ ...milestone, valueAllocationPercent: 100 }).success,
    ).toBe(true);
    expect(
      blueprintMilestoneSchema.safeParse({ ...milestone, valueAllocationPercent: 101 }).success,
    ).toBe(false);
  });

  it('refuses a milestone with no deliverables behind it', () => {
    expect(blueprintMilestoneSchema.safeParse({ ...milestone, deliverableIds: [] }).success).toBe(
      false,
    );
  });
});

describe('the sequence edge and definition-of-done schemas', () => {
  it('refuses a milestone preceding itself', () => {
    const edge = {
      id: 'ed-1',
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      predecessorId: 'ms-1',
      successorId: 'ms-2',
      createdAt: stamp,
    };
    expect(milestoneSequenceEdgeSchema.safeParse(edge).success).toBe(true);
    // A one-node cycle. Longer cycles are a property of the whole graph, which no record can carry.
    expect(milestoneSequenceEdgeSchema.safeParse({ ...edge, successorId: 'ms-1' }).success).toBe(false);
  });

  const dodPackage = {
    id: 'dod-1',
    workspaceId: 'ws-1',
    milestoneId: 'ms-1',
    version: 1,
    deliverableGateIds: ['dl-1'],
    criteria: [
      { key: 'cube-test', description: 'Cube test at 28 days', mandatory: true, evaluationType: 'MANUAL' as const },
    ],
    evidenceRequirements: ['Laboratory certificate'],
    qualityGate: true,
    complianceGate: true,
    riskGate: false,
    paymentGate: true,
    status: 'DRAFT' as const,
    createdBy: 'u-1',
    createdAt: stamp,
    contentHash: 'b7e2d4',
  };

  it('accepts a well-formed package and every state it moves through', () => {
    for (const status of ['DRAFT', 'PUBLISHED', 'SUPERSEDED']) {
      expect(dodPackageSchema.safeParse({ ...dodPackage, status }).success, status).toBe(true);
    }
  });

  it('refuses a definition of done that defines nothing', () => {
    // A completion certificate is judged against these criteria. An empty set would let any evidence
    // satisfy the gate.
    expect(dodPackageSchema.safeParse({ ...dodPackage, criteria: [] }).success).toBe(false);
    expect(dodPackageSchema.safeParse({ ...dodPackage, evidenceRequirements: [] }).success).toBe(false);
    expect(dodPackageSchema.safeParse({ ...dodPackage, deliverableGateIds: [] }).success).toBe(false);
  });

  it('refuses a malformed criterion, and an unknown evaluation type', () => {
    expect(
      dodPackageSchema.safeParse({
        ...dodPackage,
        criteria: [{ key: 'k', description: '', mandatory: true, evaluationType: 'MANUAL' }],
      }).success,
    ).toBe(false);
    expect(
      dodPackageSchema.safeParse({
        ...dodPackage,
        criteria: [{ key: 'k', description: 'd', mandatory: true, evaluationType: 'PSYCHIC' }],
      }).success,
    ).toBe(false);
  });
});
