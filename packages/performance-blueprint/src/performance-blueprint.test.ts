import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  DefinitionOfDonePackageEngine,
  DeliverablesEngine,
  MilestonePlanningEngine,
  PerformanceBlueprintEngine,
  ScopeDefinitionEngine,
} from './index';

const c = {
  actorUserId: 'planner',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 21 Performance Blueprint', () => {
  it('drafts versioned blueprints per contract and blocks activation until the plan is proven complete', () => {
    const s = new InMemoryTrustStore();
    const e = new PerformanceBlueprintEngine(s);
    const first = e.draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    expect(first.version).toBe(1);
    const second = e.draft(c, {
      contractId: 'contract',
      contractVersionId: 'v2',
      agreementIntelligenceVersionId: 'i2',
    });
    expect(second.version).toBe(2);
    expect(() => e.activate(c, second.id)).toThrow('CONFIRMED_SCOPE_REQUIRED');
  });
});

describe('Engine 22 Scope Definition', () => {
  it('requires a draft blueprint and an owner for included scope, and becomes immutable once confirmed', () => {
    const s = new InMemoryTrustStore();
    const blueprint = new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const e = new ScopeDefinitionEngine(s);
    expect(() =>
      e.define(c, {
        blueprintId: blueprint.id,
        kind: 'INCLUDED',
        description: '',
        assumptions: [],
        constraints: [],
        ownerId: 'owner',
      }),
    ).toThrow('DESCRIPTION_REQUIRED');
    const item = e.define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Deliver structural steel',
      assumptions: ['site access granted'],
      constraints: ['dry season only'],
      ownerId: 'owner',
    });
    expect(e.confirm(c, item.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(() => e.confirm(c, item.id)).toThrow('IMMUTABLE');
  });
});

describe('Engine 23 Deliverables', () => {
  it('requires acceptance criteria and evidence requirements and only attaches to included scope', () => {
    const s = new InMemoryTrustStore();
    const blueprint = new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const excluded = new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'EXCLUDED',
      description: 'Site security',
      assumptions: [],
      constraints: [],
      ownerId: '',
    });
    const e = new DeliverablesEngine(s);
    expect(() =>
      e.define(c, {
        blueprintId: blueprint.id,
        scopeItemId: excluded.id,
        title: 'Fence',
        quantity: 1,
        unit: 'lot',
        qualityStandard: 'NIS-1',
        ownerId: 'owner',
        dueDate: '2026-09-01',
        acceptanceCriteria: ['inspected'],
        evidenceRequirements: ['photo'],
      }),
    ).toThrow('EXCLUDED_SCOPE_NOT_DELIVERABLE');
    const included = new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    expect(() =>
      e.define(c, {
        blueprintId: blueprint.id,
        scopeItemId: included.id,
        title: 'Frame',
        quantity: 0,
        unit: 'lot',
        qualityStandard: 'NIS-1',
        ownerId: 'owner',
        dueDate: '2026-09-01',
        acceptanceCriteria: ['inspected'],
        evidenceRequirements: ['photo'],
      }),
    ).toThrow('INVALID_QUANTITY');
    const deliverable = e.define(c, {
      blueprintId: blueprint.id,
      scopeItemId: included.id,
      title: 'Frame',
      quantity: 1,
      unit: 'lot',
      qualityStandard: 'NIS-1',
      ownerId: 'owner',
      dueDate: '2026-09-01',
      acceptanceCriteria: ['inspected'],
      evidenceRequirements: ['photo'],
    });
    expect(e.confirm(c, deliverable.id)).toMatchObject({ status: 'CONFIRMED' });
    expect(() => e.confirm(c, deliverable.id)).toThrow('IMMUTABLE');
  });
});

describe('Engine 24 Milestone Planning', () => {
  it('only schedules against confirmed deliverables, caps value allocation and rejects dependency cycles', () => {
    const s = new InMemoryTrustStore();
    const blueprint = new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const scope = new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    const deliverables = new DeliverablesEngine(s);
    const draftDeliverable = deliverables.define(c, {
      blueprintId: blueprint.id,
      scopeItemId: scope.id,
      title: 'Frame',
      quantity: 1,
      unit: 'lot',
      qualityStandard: 'NIS-1',
      ownerId: 'owner',
      dueDate: '2026-09-01',
      acceptanceCriteria: ['inspected'],
      evidenceRequirements: ['photo'],
    });
    const e = new MilestonePlanningEngine(s);
    expect(() =>
      e.schedule(c, {
        blueprintId: blueprint.id,
        title: 'Frame erected',
        deliverableIds: [draftDeliverable.id],
        startDate: '2026-08-01',
        dueDate: '2026-09-01',
        budgetAmountMinor: 100_000_00,
        currency: 'NGN',
        valueAllocationPercent: 60,
      }),
    ).toThrow('CONFIRMED_DELIVERABLE_REQUIRED');
    deliverables.confirm(c, draftDeliverable.id);
    const first = e.schedule(c, {
      blueprintId: blueprint.id,
      title: 'Frame erected',
      deliverableIds: [draftDeliverable.id],
      startDate: '2026-08-01',
      dueDate: '2026-09-01',
      budgetAmountMinor: 100_000_00,
      currency: 'NGN',
      valueAllocationPercent: 60,
    });
    expect(() =>
      e.schedule(c, {
        blueprintId: blueprint.id,
        title: 'Handover',
        deliverableIds: [draftDeliverable.id],
        startDate: '2026-09-01',
        dueDate: '2026-09-15',
        budgetAmountMinor: 50_000_00,
        currency: 'NGN',
        valueAllocationPercent: 50,
      }),
    ).toThrow('VALUE_ALLOCATION_EXCEEDS_TOTAL');
    const second = e.schedule(c, {
      blueprintId: blueprint.id,
      title: 'Handover',
      deliverableIds: [draftDeliverable.id],
      startDate: '2026-09-01',
      dueDate: '2026-09-15',
      budgetAmountMinor: 50_000_00,
      currency: 'NGN',
      valueAllocationPercent: 40,
    });
    e.addDependency(c, { blueprintId: blueprint.id, predecessorId: first.id, successorId: second.id });
    expect(() =>
      e.addDependency(c, { blueprintId: blueprint.id, predecessorId: second.id, successorId: first.id }),
    ).toThrow('MILESTONE_CYCLE');
    expect(e.criticalPath(c, blueprint.id).path).toEqual([first.id, second.id]);
  });
});

describe('Engine 25 Definition of Done', () => {
  it('requires a mandatory criterion and deliverable gates scoped to the milestone, and supersedes on publish', () => {
    const s = new InMemoryTrustStore();
    const blueprint = new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const scope = new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    const deliverables = new DeliverablesEngine(s);
    const deliverable = deliverables.define(c, {
      blueprintId: blueprint.id,
      scopeItemId: scope.id,
      title: 'Frame',
      quantity: 1,
      unit: 'lot',
      qualityStandard: 'NIS-1',
      ownerId: 'owner',
      dueDate: '2026-09-01',
      acceptanceCriteria: ['inspected'],
      evidenceRequirements: ['photo'],
    });
    deliverables.confirm(c, deliverable.id);
    const milestone = new MilestonePlanningEngine(s).schedule(c, {
      blueprintId: blueprint.id,
      title: 'Frame erected',
      deliverableIds: [deliverable.id],
      startDate: '2026-08-01',
      dueDate: '2026-09-01',
      budgetAmountMinor: 100_000_00,
      currency: 'NGN',
      valueAllocationPercent: 60,
    });
    const e = new DefinitionOfDonePackageEngine(s);
    expect(() =>
      e.draft(c, {
        milestoneId: milestone.id,
        deliverableGateIds: [deliverable.id],
        criteria: [{ key: 'inspected', description: 'Frame inspected', mandatory: false, evaluationType: 'MANUAL' }],
        evidenceRequirements: ['photo'],
        qualityGate: true,
        complianceGate: true,
        riskGate: false,
        paymentGate: true,
      }),
    ).toThrow('MANDATORY_CRITERION_REQUIRED');
    const draft = e.draft(c, {
      milestoneId: milestone.id,
      deliverableGateIds: [deliverable.id],
      criteria: [{ key: 'inspected', description: 'Frame inspected', mandatory: true, evaluationType: 'MANUAL' }],
      evidenceRequirements: ['photo'],
      qualityGate: true,
      complianceGate: true,
      riskGate: false,
      paymentGate: true,
    });
    const published = e.publish(c, draft.id);
    expect(published.status).toBe('PUBLISHED');
    const amended = e.draft(c, {
      milestoneId: milestone.id,
      deliverableGateIds: [deliverable.id],
      criteria: [{ key: 'inspected', description: 'Frame inspected, re-torqued', mandatory: true, evaluationType: 'MANUAL' }],
      evidenceRequirements: ['photo', 'torque log'],
      qualityGate: true,
      complianceGate: true,
      riskGate: false,
      paymentGate: true,
    });
    expect(e.publish(c, amended.id).version).toBe(2);
    expect(s.list<{ id: string; status: string }>('dodPackages').find((x) => x.id === draft.id)?.status).toBe(
      'SUPERSEDED',
    );
  });
});
