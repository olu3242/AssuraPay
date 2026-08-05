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
  it('drafts versioned blueprints per contract and blocks activation until the plan is proven complete', async () => {
    const s = new InMemoryTrustStore();
    const e = new PerformanceBlueprintEngine(s);
    const first = await e.draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    expect(first.version).toBe(1);
    const second = await e.draft(c, {
      contractId: 'contract',
      contractVersionId: 'v2',
      agreementIntelligenceVersionId: 'i2',
    });
    expect(second.version).toBe(2);
    await expect(e.activate(c, second.id)).rejects.toThrow('CONFIRMED_SCOPE_REQUIRED');
  });
});

describe('Engine 22 Scope Definition', () => {
  it('requires a draft blueprint and an owner for included scope, and becomes immutable once confirmed', async () => {
    const s = new InMemoryTrustStore();
    const blueprint = await new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const e = new ScopeDefinitionEngine(s);
    await expect(e.define(c, {
        blueprintId: blueprint.id,
        kind: 'INCLUDED',
        description: '',
        assumptions: [],
        constraints: [],
        ownerId: 'owner',
      })).rejects.toThrow('DESCRIPTION_REQUIRED');
    const item = await e.define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Deliver structural steel',
      assumptions: ['site access granted'],
      constraints: ['dry season only'],
      ownerId: 'owner',
    });
    expect(await e.confirm(c, item.id)).toMatchObject({ status: 'CONFIRMED' });
    await expect(e.confirm(c, item.id)).rejects.toThrow('IMMUTABLE');
  });
});

describe('Engine 23 Deliverables', () => {
  it('requires acceptance criteria and evidence requirements and only attaches to included scope', async () => {
    const s = new InMemoryTrustStore();
    const blueprint = await new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const excluded = await new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'EXCLUDED',
      description: 'Site security',
      assumptions: [],
      constraints: [],
      ownerId: '',
    });
    const e = new DeliverablesEngine(s);
    await expect(e.define(c, {
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
      })).rejects.toThrow('EXCLUDED_SCOPE_NOT_DELIVERABLE');
    const included = await new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    await expect(e.define(c, {
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
      })).rejects.toThrow('INVALID_QUANTITY');
    const deliverable = await e.define(c, {
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
    expect(await e.confirm(c, deliverable.id)).toMatchObject({ status: 'CONFIRMED' });
    await expect(e.confirm(c, deliverable.id)).rejects.toThrow('IMMUTABLE');
  });
});

describe('Engine 24 Milestone Planning', () => {
  it('only schedules against confirmed deliverables, caps value allocation and rejects dependency cycles', async () => {
    const s = new InMemoryTrustStore();
    const blueprint = await new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const scope = await new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    const deliverables = new DeliverablesEngine(s);
    const draftDeliverable = await deliverables.define(c, {
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
    await expect(e.schedule(c, {
        blueprintId: blueprint.id,
        title: 'Frame erected',
        deliverableIds: [draftDeliverable.id],
        startDate: '2026-08-01',
        dueDate: '2026-09-01',
        budgetAmountMinor: 100_000_00,
        currency: 'NGN',
        valueAllocationPercent: 60,
      })).rejects.toThrow('CONFIRMED_DELIVERABLE_REQUIRED');
    await deliverables.confirm(c, draftDeliverable.id);
    const first = await e.schedule(c, {
      blueprintId: blueprint.id,
      title: 'Frame erected',
      deliverableIds: [draftDeliverable.id],
      startDate: '2026-08-01',
      dueDate: '2026-09-01',
      budgetAmountMinor: 100_000_00,
      currency: 'NGN',
      valueAllocationPercent: 60,
    });
    await expect(e.schedule(c, {
        blueprintId: blueprint.id,
        title: 'Handover',
        deliverableIds: [draftDeliverable.id],
        startDate: '2026-09-01',
        dueDate: '2026-09-15',
        budgetAmountMinor: 50_000_00,
        currency: 'NGN',
        valueAllocationPercent: 50,
      })).rejects.toThrow('VALUE_ALLOCATION_EXCEEDS_TOTAL');
    const second = await e.schedule(c, {
      blueprintId: blueprint.id,
      title: 'Handover',
      deliverableIds: [draftDeliverable.id],
      startDate: '2026-09-01',
      dueDate: '2026-09-15',
      budgetAmountMinor: 50_000_00,
      currency: 'NGN',
      valueAllocationPercent: 40,
    });
    await e.addDependency(c, { blueprintId: blueprint.id, predecessorId: first.id, successorId: second.id });
    await expect(e.addDependency(c, { blueprintId: blueprint.id, predecessorId: second.id, successorId: first.id })).rejects.toThrow('MILESTONE_CYCLE');
    expect((await e.criticalPath(c, blueprint.id)).path).toEqual([first.id, second.id]);
  });
});

describe('Engine 25 Definition of Done', () => {
  it('requires a mandatory criterion and deliverable gates scoped to the milestone, and supersedes on publish', async () => {
    const s = new InMemoryTrustStore();
    const blueprint = await new PerformanceBlueprintEngine(s).draft(c, {
      contractId: 'contract',
      contractVersionId: 'v1',
      agreementIntelligenceVersionId: 'i1',
    });
    const scope = await new ScopeDefinitionEngine(s).define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Steel frame',
      assumptions: [],
      constraints: [],
      ownerId: 'owner',
    });
    const deliverables = new DeliverablesEngine(s);
    const deliverable = await deliverables.define(c, {
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
    await deliverables.confirm(c, deliverable.id);
    const milestone = await new MilestonePlanningEngine(s).schedule(c, {
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
    await expect(e.draft(c, {
        milestoneId: milestone.id,
        deliverableGateIds: [deliverable.id],
        criteria: [{ key: 'inspected', description: 'Frame inspected', mandatory: false, evaluationType: 'MANUAL' }],
        evidenceRequirements: ['photo'],
        qualityGate: true,
        complianceGate: true,
        riskGate: false,
        paymentGate: true,
      })).rejects.toThrow('MANDATORY_CRITERION_REQUIRED');
    const draft = await e.draft(c, {
      milestoneId: milestone.id,
      deliverableGateIds: [deliverable.id],
      criteria: [{ key: 'inspected', description: 'Frame inspected', mandatory: true, evaluationType: 'MANUAL' }],
      evidenceRequirements: ['photo'],
      qualityGate: true,
      complianceGate: true,
      riskGate: false,
      paymentGate: true,
    });
    const published = await e.publish(c, draft.id);
    expect(published.status).toBe('PUBLISHED');
    const amended = await e.draft(c, {
      milestoneId: milestone.id,
      deliverableGateIds: [deliverable.id],
      criteria: [{ key: 'inspected', description: 'Frame inspected, re-torqued', mandatory: true, evaluationType: 'MANUAL' }],
      evidenceRequirements: ['photo', 'torque log'],
      qualityGate: true,
      complianceGate: true,
      riskGate: false,
      paymentGate: true,
    });
    expect((await e.publish(c, amended.id)).version).toBe(2);
    expect((await s.list<{ id: string; status: string }>('dodPackages')).find((x) => x.id === draft.id)?.status).toBe(
      'SUPERSEDED',
    );
  });
});
