import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ws(context: RequestContext) {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
}
async function get<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = (await store
    .list<T>(collection))
    .find((x) => x.id === id && x.workspaceId === ws(context));
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
async function emit(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  await store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  await store.emit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    aggregateType,
    aggregateId,
    eventType,
    eventVersion: 1,
    payload,
    correlationId: context.correlationId,
  });
}

// Engine 21 — Performance Blueprint

export type PerformanceBlueprint = {
  id: string;
  workspaceId: string;
  contractId: string;
  contractVersionId: string;
  agreementIntelligenceVersionId: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  createdBy: string;
  createdAt: string;
  contentHash: string;
};

export class PerformanceBlueprintEngine {
  constructor(private readonly store: TrustPersistence) {}

  async draft(
    context: RequestContext,
    input: {
      contractId: string;
      contractVersionId: string;
      agreementIntelligenceVersionId: string;
    },
  ) {
    const workspaceId = ws(context);
    const existing = (await this.store
      .list<PerformanceBlueprint>('performanceBlueprints'))
      .filter((x) => x.workspaceId === workspaceId && x.contractId === input.contractId);
    const blueprint: PerformanceBlueprint = {
      id: randomUUID(),
      workspaceId,
      ...input,
      version: existing.length + 1,
      status: 'DRAFT',
      createdBy: context.actorUserId,
      createdAt: now(),
      contentHash: digest(input),
    };
    await this.store.append('performanceBlueprints', blueprint);
    await emit(this.store, context, 'PerformanceBlueprintDrafted', 'PerformanceBlueprint', blueprint.id, {
      contractId: blueprint.contractId,
      version: blueprint.version,
    });
    return blueprint;
  }

  async activate(context: RequestContext, id: string) {
    const blueprint = await get<PerformanceBlueprint>(this.store, 'performanceBlueprints', context, id);
    if (blueprint.status !== 'DRAFT') throw new Error('BLUEPRINT_NOT_DRAFT');
    const workspaceId = ws(context);
    const scope = (await this.store
      .list<ScopeItem>('scopeItems'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === id);
    if (!scope.some((x) => x.status === 'CONFIRMED')) throw new Error('CONFIRMED_SCOPE_REQUIRED');
    const milestones = (await this.store
      .list<BlueprintMilestone>('blueprintMilestones'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === id && x.status === 'SCHEDULED');
    if (!milestones.length) throw new Error('MILESTONE_REQUIRED');
    const dodPackages = (await this.store.list<DodPackage>('dodPackages')).filter((x) => x.workspaceId === workspaceId);
    for (const milestone of milestones)
      if (!dodPackages.some((x) => x.milestoneId === milestone.id && x.status === 'PUBLISHED'))
        throw new Error('DOD_PACKAGE_REQUIRED');
    const allocatedPercent = milestones.reduce((sum, x) => sum + x.valueAllocationPercent, 0);
    if (allocatedPercent > 100) throw new Error('VALUE_ALLOCATION_EXCEEDS_TOTAL');
    for (const previous of (await this.store
      .list<PerformanceBlueprint>('performanceBlueprints'))
      .filter((x) => x.workspaceId === workspaceId && x.contractId === blueprint.contractId && x.status === 'ACTIVE'))
      await this.store.replace('performanceBlueprints', { ...previous, status: 'SUPERSEDED' });
    const activated: PerformanceBlueprint = { ...blueprint, status: 'ACTIVE' };
    await this.store.replace('performanceBlueprints', activated);
    await emit(this.store, context, 'PerformanceBlueprintActivated', 'PerformanceBlueprint', id, {
      milestoneCount: milestones.length,
      valueAllocationPercent: allocatedPercent,
    });
    return activated;
  }
}

// Engine 22 — Scope Definition

export type ScopeItem = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  kind: 'INCLUDED' | 'EXCLUDED';
  description: string;
  assumptions: string[];
  constraints: string[];
  ownerId: string;
  status: 'DRAFT' | 'CONFIRMED';
  createdAt: string;
};

export class ScopeDefinitionEngine {
  constructor(private readonly store: TrustPersistence) {}

  async define(
    context: RequestContext,
    input: {
      blueprintId: string;
      kind: ScopeItem['kind'];
      description: string;
      assumptions: string[];
      constraints: string[];
      ownerId: string;
    },
  ) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    const blueprint = await get<PerformanceBlueprint>(this.store, 'performanceBlueprints', context, input.blueprintId);
    if (blueprint.status !== 'DRAFT') throw new Error('BLUEPRINT_NOT_DRAFT');
    const item: ScopeItem = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    await this.store.append('scopeItems', item);
    await emit(this.store, context, 'ScopeItemDefined', 'ScopeItem', item.id, {
      blueprintId: item.blueprintId,
      kind: item.kind,
    });
    return item;
  }

  async confirm(context: RequestContext, id: string) {
    const item = await get<ScopeItem>(this.store, 'scopeItems', context, id);
    if (item.status !== 'DRAFT') throw new Error('SCOPE_ITEM_IMMUTABLE');
    if (item.kind === 'INCLUDED' && !item.ownerId) throw new Error('OWNER_REQUIRED');
    const confirmed: ScopeItem = { ...item, status: 'CONFIRMED' };
    await this.store.replace('scopeItems', confirmed);
    await emit(this.store, context, 'ScopeItemConfirmed', 'ScopeItem', id, { kind: item.kind });
    return confirmed;
  }
}

// Engine 23 — Deliverables

export type Deliverable = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  scopeItemId: string;
  title: string;
  quantity: number;
  unit: string;
  qualityStandard: string;
  ownerId: string;
  dueDate: string;
  acceptanceCriteria: string[];
  evidenceRequirements: string[];
  status: 'DRAFT' | 'CONFIRMED';
  createdAt: string;
};

export class DeliverablesEngine {
  constructor(private readonly store: TrustPersistence) {}

  async define(
    context: RequestContext,
    input: {
      blueprintId: string;
      scopeItemId: string;
      title: string;
      quantity: number;
      unit: string;
      qualityStandard: string;
      ownerId: string;
      dueDate: string;
      acceptanceCriteria: string[];
      evidenceRequirements: string[];
    },
  ) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('INVALID_QUANTITY');
    if (!input.acceptanceCriteria.length) throw new Error('ACCEPTANCE_CRITERIA_REQUIRED');
    if (!input.evidenceRequirements.length) throw new Error('EVIDENCE_REQUIREMENT_REQUIRED');
    const scope = await get<ScopeItem>(this.store, 'scopeItems', context, input.scopeItemId);
    if (scope.blueprintId !== input.blueprintId) throw new Error('SCOPE_ITEM_MISMATCH');
    if (scope.kind !== 'INCLUDED') throw new Error('EXCLUDED_SCOPE_NOT_DELIVERABLE');
    const deliverable: Deliverable = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    await this.store.append('deliverables', deliverable);
    await emit(this.store, context, 'DeliverableDefined', 'Deliverable', deliverable.id, {
      blueprintId: deliverable.blueprintId,
      scopeItemId: deliverable.scopeItemId,
    });
    return deliverable;
  }

  async confirm(context: RequestContext, id: string) {
    const deliverable = await get<Deliverable>(this.store, 'deliverables', context, id);
    if (deliverable.status !== 'DRAFT') throw new Error('DELIVERABLE_IMMUTABLE');
    const confirmed: Deliverable = { ...deliverable, status: 'CONFIRMED' };
    await this.store.replace('deliverables', confirmed);
    await emit(this.store, context, 'DeliverableConfirmed', 'Deliverable', id, { scopeItemId: deliverable.scopeItemId });
    return confirmed;
  }
}

// Engine 24 — Milestone Planning

export type BlueprintMilestone = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  title: string;
  deliverableIds: string[];
  startDate: string;
  dueDate: string;
  budgetAmountMinor: number;
  currency: string;
  valueAllocationPercent: number;
  status: 'SCHEDULED' | 'CANCELLED';
  createdAt: string;
};

export type MilestoneSequenceEdge = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  predecessorId: string;
  successorId: string;
  createdAt: string;
};

export class MilestonePlanningEngine {
  constructor(private readonly store: TrustPersistence) {}

  async schedule(
    context: RequestContext,
    input: {
      blueprintId: string;
      title: string;
      deliverableIds: string[];
      startDate: string;
      dueDate: string;
      budgetAmountMinor: number;
      currency: string;
      valueAllocationPercent: number;
    },
  ) {
    if (!input.deliverableIds.length) throw new Error('DELIVERABLE_REQUIRED');
    if (!Number.isInteger(input.budgetAmountMinor) || input.budgetAmountMinor <= 0)
      throw new Error('INVALID_BUDGET');
    if (input.valueAllocationPercent <= 0 || input.valueAllocationPercent > 100)
      throw new Error('INVALID_VALUE_ALLOCATION');
    const workspaceId = ws(context);
    const deliverables = (await this.store
      .list<Deliverable>('deliverables'))
      .filter((x) => x.workspaceId === workspaceId && input.deliverableIds.includes(x.id));
    if (
      deliverables.length !== input.deliverableIds.length ||
      deliverables.some((x) => x.status !== 'CONFIRMED' || x.blueprintId !== input.blueprintId)
    )
      throw new Error('CONFIRMED_DELIVERABLE_REQUIRED');
    const scheduled = (await this.store
      .list<BlueprintMilestone>('blueprintMilestones'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === input.blueprintId && x.status === 'SCHEDULED');
    const allocatedPercent =
      scheduled.reduce((sum, x) => sum + x.valueAllocationPercent, 0) + input.valueAllocationPercent;
    if (allocatedPercent > 100) throw new Error('VALUE_ALLOCATION_EXCEEDS_TOTAL');
    const milestone: BlueprintMilestone = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'SCHEDULED',
      createdAt: now(),
    };
    await this.store.append('blueprintMilestones', milestone);
    await emit(this.store, context, 'MilestoneScheduled', 'BlueprintMilestone', milestone.id, {
      blueprintId: milestone.blueprintId,
      valueAllocationPercent: milestone.valueAllocationPercent,
    });
    return milestone;
  }

  async addDependency(
    context: RequestContext,
    input: { blueprintId: string; predecessorId: string; successorId: string },
  ) {
    if (input.predecessorId === input.successorId) throw new Error('MILESTONE_CYCLE');
    const workspaceId = ws(context);
    const nodes = (await this.store
      .list<BlueprintMilestone>('blueprintMilestones'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === input.blueprintId);
    if (!nodes.some((x) => x.id === input.predecessorId) || !nodes.some((x) => x.id === input.successorId))
      throw new Error('MILESTONE_NOT_FOUND');
    const edges = [
      ...(await this.store
        .list<MilestoneSequenceEdge>('milestoneSequenceEdges'))
        .filter((x) => x.workspaceId === workspaceId && x.blueprintId === input.blueprintId),
    ];
    if (this.hasPath(edges, input.successorId, input.predecessorId)) throw new Error('MILESTONE_CYCLE');
    const edge: MilestoneSequenceEdge = { id: randomUUID(), workspaceId, ...input, createdAt: now() };
    await this.store.append('milestoneSequenceEdges', edge);
    await emit(this.store, context, 'MilestoneDependencyAdded', 'MilestoneSequenceEdge', edge.id, {
      blueprintId: edge.blueprintId,
      predecessorId: edge.predecessorId,
      successorId: edge.successorId,
    });
    return edge;
  }

  async criticalPath(context: RequestContext, blueprintId: string) {
    const workspaceId = ws(context);
    const nodes = (await this.store
      .list<BlueprintMilestone>('blueprintMilestones'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === blueprintId);
    const edges = (await this.store
      .list<MilestoneSequenceEdge>('milestoneSequenceEdges'))
      .filter((x) => x.workspaceId === workspaceId && x.blueprintId === blueprintId);
    const durationDays = (milestone: BlueprintMilestone) =>
      Math.max(1, Math.round((Date.parse(milestone.dueDate) - Date.parse(milestone.startDate)) / 86_400_000));
    const memo = new Map<string, { days: number; path: string[] }>();
    const visit = (id: string): { days: number; path: string[] } => {
      const cached = memo.get(id);
      if (cached) return cached;
      const node = nodes.find((x) => x.id === id);
      if (!node) return { days: 0, path: [] };
      const next = edges
        .filter((x) => x.predecessorId === id)
        .map((x) => visit(x.successorId))
        .sort((a, b) => b.days - a.days)[0] ?? { days: 0, path: [] };
      const value = { days: durationDays(node) + next.days, path: [id, ...next.path] };
      memo.set(id, value);
      return value;
    };
    return (
      nodes.map((x) => visit(x.id)).sort((a, b) => b.days - a.days)[0] ?? { days: 0, path: [] }
    );
  }

  private hasPath(
    edges: MilestoneSequenceEdge[],
    from: string,
    to: string,
    seen = new Set<string>(),
  ): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return edges.filter((x) => x.predecessorId === from).some((x) => this.hasPath(edges, x.successorId, to, seen));
  }
}

// Engine 25 — Definition of Done

export type DodGateCriterion = {
  key: string;
  description: string;
  mandatory: boolean;
  evaluationType: 'AUTOMATED' | 'MANUAL';
};

export type DodPackage = {
  id: string;
  workspaceId: string;
  milestoneId: string;
  version: number;
  deliverableGateIds: string[];
  criteria: DodGateCriterion[];
  evidenceRequirements: string[];
  qualityGate: boolean;
  complianceGate: boolean;
  riskGate: boolean;
  paymentGate: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  createdBy: string;
  createdAt: string;
  contentHash: string;
};

export class DefinitionOfDonePackageEngine {
  constructor(private readonly store: TrustPersistence) {}

  async draft(
    context: RequestContext,
    input: {
      milestoneId: string;
      deliverableGateIds: string[];
      criteria: DodGateCriterion[];
      evidenceRequirements: string[];
      qualityGate: boolean;
      complianceGate: boolean;
      riskGate: boolean;
      paymentGate: boolean;
    },
  ) {
    if (!input.deliverableGateIds.length) throw new Error('DELIVERABLE_GATE_REQUIRED');
    if (!input.criteria.some((x) => x.mandatory)) throw new Error('MANDATORY_CRITERION_REQUIRED');
    if (!input.evidenceRequirements.length) throw new Error('EVIDENCE_REQUIREMENT_REQUIRED');
    const workspaceId = ws(context);
    const milestone = await get<BlueprintMilestone>(this.store, 'blueprintMilestones', context, input.milestoneId);
    const deliverables = (await this.store
      .list<Deliverable>('deliverables'))
      .filter((x) => x.workspaceId === workspaceId && input.deliverableGateIds.includes(x.id));
    if (
      deliverables.length !== input.deliverableGateIds.length ||
      deliverables.some((x) => !milestone.deliverableIds.includes(x.id))
    )
      throw new Error('DELIVERABLE_GATE_NOT_IN_MILESTONE');
    const existing = (await this.store
      .list<DodPackage>('dodPackages'))
      .filter((x) => x.workspaceId === workspaceId && x.milestoneId === input.milestoneId);
    const draft: DodPackage = {
      id: randomUUID(),
      workspaceId,
      ...input,
      version: existing.length + 1,
      status: 'DRAFT',
      createdBy: context.actorUserId,
      createdAt: now(),
      contentHash: digest(input),
    };
    await this.store.append('dodPackages', draft);
    await emit(this.store, context, 'DefinitionOfDoneDrafted', 'DodPackage', draft.id, {
      milestoneId: draft.milestoneId,
      version: draft.version,
    });
    return draft;
  }

  async publish(context: RequestContext, id: string) {
    const draft = await get<DodPackage>(this.store, 'dodPackages', context, id);
    if (draft.status !== 'DRAFT') throw new Error('DOD_PACKAGE_IMMUTABLE');
    const workspaceId = ws(context);
    for (const previous of (await this.store
      .list<DodPackage>('dodPackages'))
      .filter((x) => x.workspaceId === workspaceId && x.milestoneId === draft.milestoneId && x.status === 'PUBLISHED'))
      await this.store.replace('dodPackages', { ...previous, status: 'SUPERSEDED' });
    const published: DodPackage = { ...draft, status: 'PUBLISHED' };
    await this.store.replace('dodPackages', published);
    await emit(this.store, context, 'DefinitionOfDonePublished', 'DodPackage', id, {
      milestoneId: draft.milestoneId,
      contentHash: draft.contentHash,
    });
    return published;
  }
}
