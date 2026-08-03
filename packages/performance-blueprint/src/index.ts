import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
const now = () => new Date().toISOString(),
  hash = (v: unknown) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex');
function ws(c: RequestContext) {
  requireActiveWorkspace(c);
  return c.activeWorkspaceId;
}
function get<T extends { id: string; workspaceId: string }>(
  s: TrustPersistence,
  k: string,
  c: RequestContext,
  id: string,
) {
  const x = s.list<T>(k).find((v) => v.id === id && v.workspaceId === ws(c));
  if (!x) throw new Error('NOT_FOUND');
  return x;
}
function evt(
  s: TrustPersistence,
  c: RequestContext,
  type: string,
  aggregate: string,
  id: string,
  payload: Record<string, unknown> = {},
) {
  s.audit({
    tenantId: c.tenantId,
    workspaceId: ws(c),
    actorId: c.actorUserId,
    eventType: type,
    aggregateType: aggregate,
    aggregateId: id,
    correlationId: c.correlationId,
    metadata: payload,
  });
  s.emit({
    tenantId: c.tenantId,
    workspaceId: ws(c),
    aggregateType: aggregate,
    aggregateId: id,
    eventType: type,
    eventVersion: 1,
    payload,
    correlationId: c.correlationId,
  });
}
export type Blueprint = {
  id: string;
  workspaceId: string;
  contractId: string;
  agreementIntelligenceVersionId: string;
  number: number;
  title: string;
  description: string;
  status: 'DRAFT' | 'UNDER_REVIEW' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
  effectiveFrom?: string;
  objectives: Array<{
    key: string;
    description: string;
    sourceReference: string;
  }>;
  configurationSnapshotId: string;
  createdBy: string;
  createdAt: string;
  version: number;
  contentHash: string;
};
export class PerformanceBlueprintEngine {
  constructor(private s: TrustPersistence) {}
  create(
    c: RequestContext,
    i: {
      contractId: string;
      agreementIntelligenceVersionId: string;
      title: string;
      description: string;
      objectives: Blueprint['objectives'];
      configurationSnapshotId: string;
    },
  ) {
    const intelligence = this.s
      .list<{ id: string; workspaceId: string; status: string }>(
        'agreementIntelligenceVersions',
      )
      .find(
        (x) =>
          x.id === i.agreementIntelligenceVersionId &&
          x.workspaceId === ws(c) &&
          x.status === 'PUBLISHED',
      );
    if (!intelligence)
      throw new Error('PUBLISHED_AGREEMENT_INTELLIGENCE_REQUIRED');
    if (!i.objectives.length || i.objectives.some((x) => !x.sourceReference))
      throw new Error('SOURCE_GROUNDED_OBJECTIVE_REQUIRED');
    const all = this.s
        .list<Blueprint>('performanceBlueprints')
        .filter(
          (x) => x.workspaceId === ws(c) && x.contractId === i.contractId,
        ),
      b: Blueprint = {
        id: randomUUID(),
        workspaceId: ws(c),
        ...i,
        number: all.length + 1,
        status: 'DRAFT',
        createdBy: c.actorUserId,
        createdAt: now(),
        version: 1,
        contentHash: hash(i),
      };
    this.s.append('performanceBlueprints', b);
    evt(
      this.s,
      c,
      'PerformanceBlueprintCreated',
      'PerformanceBlueprint',
      b.id,
      { agreementIntelligenceVersionId: i.agreementIntelligenceVersionId },
    );
    return b;
  }
  publish(c: RequestContext, id: string) {
    const b = get<Blueprint>(this.s, 'performanceBlueprints', c, id);
    if (b.status !== 'DRAFT' && b.status !== 'UNDER_REVIEW')
      throw new Error('BLUEPRINT_IMMUTABLE');
    const scope = this.s
        .list<ScopeDefinition>('scopeDefinitions')
        .find((x) => x.blueprintId === id),
      deliverables = this.s
        .list<Deliverable>('blueprintDeliverables')
        .filter((x) => x.blueprintId === id),
      milestones = this.s
        .list<PlannedMilestone>('plannedMilestones')
        .filter((x) => x.blueprintId === id),
      dods = this.s
        .list<BlueprintDod>('blueprintDods')
        .filter((x) => x.blueprintId === id && x.status === 'PUBLISHED');
    if (
      !scope ||
      !deliverables.length ||
      !milestones.length ||
      deliverables.some((x) => !dods.some((d) => d.deliverableId === x.id))
    )
      throw new Error('BLUEPRINT_INCOMPLETE');
    for (const old of this.s
      .list<Blueprint>('performanceBlueprints')
      .filter(
        (x) =>
          x.workspaceId === b.workspaceId &&
          x.contractId === b.contractId &&
          x.status === 'PUBLISHED',
      ))
      this.s.replace('performanceBlueprints', { ...old, status: 'SUPERSEDED' });
    const y = {
      ...b,
      status: 'PUBLISHED' as const,
      effectiveFrom: now(),
      contentHash: hash({ b, scope, deliverables, milestones, dods }),
    };
    this.s.replace('performanceBlueprints', y);
    evt(
      this.s,
      c,
      'PerformanceBlueprintPublished',
      'PerformanceBlueprint',
      id,
      { contentHash: y.contentHash },
    );
    return y;
  }
}
export type ScopeDefinition = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  included: Array<{
    key: string;
    description: string;
    ownerId: string;
    sourceReference: string;
  }>;
  excluded: Array<{
    key: string;
    description: string;
    sourceReference: string;
  }>;
  assumptions: Array<{
    key: string;
    description: string;
    validationOwnerId: string;
  }>;
  constraints: Array<{
    key: string;
    description: string;
    severity: 'ADVISORY' | 'BLOCKING';
  }>;
  status: 'DRAFT' | 'VALIDATED';
  createdAt: string;
  version: number;
};
export class ScopeDefinitionEngine {
  constructor(private s: TrustPersistence) {}
  define(
    c: RequestContext,
    i: Omit<
      ScopeDefinition,
      'id' | 'workspaceId' | 'status' | 'createdAt' | 'version'
    >,
  ) {
    if (
      !i.included.length ||
      i.included.some((x) => !x.ownerId || !x.sourceReference) ||
      i.excluded.some((x) => !x.sourceReference)
    )
      throw new Error('INVALID_SCOPE_GROUNDING');
    const prior = this.s
      .list<ScopeDefinition>('scopeDefinitions')
      .find((x) => x.workspaceId === ws(c) && x.blueprintId === i.blueprintId);
    if (prior?.status === 'VALIDATED')
      throw new Error('VALIDATED_SCOPE_IMMUTABLE');
    const x: ScopeDefinition = {
      id: prior?.id ?? randomUUID(),
      workspaceId: ws(c),
      ...i,
      status: 'DRAFT',
      createdAt: prior?.createdAt ?? now(),
      version: (prior?.version ?? 0) + 1,
    };
    prior
      ? this.s.replace('scopeDefinitions', x)
      : this.s.append('scopeDefinitions', x);
    return x;
  }
  validate(c: RequestContext, id: string) {
    const x = get<ScopeDefinition>(this.s, 'scopeDefinitions', c, id);
    if (x.constraints.some((v) => v.severity === 'BLOCKING'))
      throw new Error('BLOCKING_SCOPE_CONSTRAINT');
    const y = { ...x, status: 'VALIDATED' as const };
    this.s.replace('scopeDefinitions', y);
    evt(this.s, c, 'ScopeDefinitionValidated', 'ScopeDefinition', id);
    return y;
  }
}
export type Deliverable = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  key: string;
  title: string;
  description: string;
  ownerId: string;
  quantity: number;
  unit: string;
  dueDate: string;
  acceptanceMethod: string;
  evidenceRequirements: string[];
  sourceReferences: string[];
  status: 'DRAFT' | 'VALIDATED';
  createdAt: string;
  version: number;
};
export class DeliverablesEngine {
  constructor(private s: TrustPersistence) {}
  create(
    c: RequestContext,
    i: Omit<
      Deliverable,
      'id' | 'workspaceId' | 'status' | 'createdAt' | 'version'
    >,
  ) {
    if (
      !i.ownerId ||
      i.quantity <= 0 ||
      !i.evidenceRequirements.length ||
      !i.sourceReferences.length
    )
      throw new Error('INVALID_DELIVERABLE');
    if (
      this.s
        .list<Deliverable>('blueprintDeliverables')
        .some(
          (x) =>
            x.workspaceId === ws(c) &&
            x.blueprintId === i.blueprintId &&
            x.key === i.key,
        )
    )
      throw new Error('DELIVERABLE_KEY_EXISTS');
    const x: Deliverable = {
      id: randomUUID(),
      workspaceId: ws(c),
      ...i,
      status: 'DRAFT',
      createdAt: now(),
      version: 1,
    };
    this.s.append('blueprintDeliverables', x);
    return x;
  }
  validate(c: RequestContext, id: string) {
    const x = get<Deliverable>(this.s, 'blueprintDeliverables', c, id),
      y = { ...x, status: 'VALIDATED' as const };
    this.s.replace('blueprintDeliverables', y);
    return y;
  }
}
export type PlannedMilestone = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  key: string;
  title: string;
  ownerId: string;
  durationDays: number;
  valueMinor: number;
  currency: string;
  deliverableIds: string[];
  status: 'DRAFT' | 'VALIDATED';
  createdAt: string;
};
export type PlannedDependency = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  predecessorId: string;
  successorId: string;
  createdAt: string;
};
export class MilestonePlanningEngine {
  constructor(private s: TrustPersistence) {}
  create(
    c: RequestContext,
    i: Omit<PlannedMilestone, 'id' | 'workspaceId' | 'status' | 'createdAt'>,
  ) {
    if (
      i.durationDays < 0 ||
      !Number.isInteger(i.durationDays) ||
      !Number.isSafeInteger(i.valueMinor) ||
      i.valueMinor < 0 ||
      !i.deliverableIds.length
    )
      throw new Error('INVALID_MILESTONE_PLAN');
    const x: PlannedMilestone = {
      id: randomUUID(),
      workspaceId: ws(c),
      ...i,
      status: 'DRAFT',
      createdAt: now(),
    };
    this.s.append('plannedMilestones', x);
    return x;
  }
  depend(
    c: RequestContext,
    blueprintId: string,
    predecessorId: string,
    successorId: string,
  ) {
    if (predecessorId === successorId) throw new Error('MILESTONE_CYCLE');
    const edges = this.s
        .list<PlannedDependency>('plannedDependencies')
        .filter(
          (x) => x.workspaceId === ws(c) && x.blueprintId === blueprintId,
        ),
      candidate: PlannedDependency = {
        id: randomUUID(),
        workspaceId: ws(c),
        blueprintId,
        predecessorId,
        successorId,
        createdAt: now(),
      };
    if (this.path([...edges, candidate], successorId, predecessorId))
      throw new Error('MILESTONE_CYCLE');
    this.s.append('plannedDependencies', candidate);
    return candidate;
  }
  criticalPath(c: RequestContext, blueprintId: string) {
    const n = this.s
        .list<PlannedMilestone>('plannedMilestones')
        .filter(
          (x) => x.workspaceId === ws(c) && x.blueprintId === blueprintId,
        ),
      e = this.s
        .list<PlannedDependency>('plannedDependencies')
        .filter(
          (x) => x.workspaceId === ws(c) && x.blueprintId === blueprintId,
        ),
      memo = new Map<string, { days: number; path: string[] }>(),
      visit = (id: string): { days: number; path: string[] } => {
        if (memo.has(id)) return memo.get(id)!;
        const node = n.find((x) => x.id === id);
        if (!node) return { days: 0, path: [] };
        const next = e
            .filter((x) => x.predecessorId === id)
            .map((x) => visit(x.successorId))
            .sort((a, b) => b.days - a.days)[0] ?? { days: 0, path: [] },
          v = { days: node.durationDays + next.days, path: [id, ...next.path] };
        memo.set(id, v);
        return v;
      };
    return (
      n.map((x) => visit(x.id)).sort((a, b) => b.days - a.days)[0] ?? {
        days: 0,
        path: [],
      }
    );
  }
  private path(
    e: PlannedDependency[],
    a: string,
    b: string,
    seen = new Set<string>(),
  ): boolean {
    if (a === b) return true;
    if (seen.has(a)) return false;
    seen.add(a);
    return e
      .filter((x) => x.predecessorId === a)
      .some((x) => this.path(e, x.successorId, b, seen));
  }
}
export type BlueprintCriterion = {
  key: string;
  description: string;
  mandatory: boolean;
  measurement: {
    operator: 'EQ' | 'GTE' | 'LTE';
    target: string | number | boolean;
  };
  evidenceRequirements: string[];
  validatorRole: string;
  sourceReference: string;
};
export type BlueprintDod = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  deliverableId: string;
  version: number;
  criteria: BlueprintCriterion[];
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  createdAt: string;
  contentHash: string;
};
export class BlueprintDefinitionOfDoneEngine {
  constructor(private s: TrustPersistence) {}
  create(
    c: RequestContext,
    blueprintId: string,
    deliverableId: string,
    criteria: BlueprintCriterion[],
  ) {
    if (
      !criteria.length ||
      criteria.some(
        (x) =>
          !x.evidenceRequirements.length ||
          !x.validatorRole ||
          !x.sourceReference,
      ) ||
      new Set(criteria.map((x) => x.key)).size !== criteria.length
    )
      throw new Error('INVALID_DEFINITION_OF_DONE');
    const all = this.s
        .list<BlueprintDod>('blueprintDods')
        .filter(
          (x) => x.workspaceId === ws(c) && x.deliverableId === deliverableId,
        ),
      d: BlueprintDod = {
        id: randomUUID(),
        workspaceId: ws(c),
        blueprintId,
        deliverableId,
        version: all.length + 1,
        criteria,
        status: 'DRAFT',
        createdAt: now(),
        contentHash: hash(criteria),
      };
    this.s.append('blueprintDods', d);
    return d;
  }
  publish(c: RequestContext, id: string) {
    const d = get<BlueprintDod>(this.s, 'blueprintDods', c, id);
    if (d.status !== 'DRAFT') throw new Error('PUBLISHED_DOD_IMMUTABLE');
    for (const old of this.s
      .list<BlueprintDod>('blueprintDods')
      .filter(
        (x) =>
          x.workspaceId === d.workspaceId &&
          x.deliverableId === d.deliverableId &&
          x.status === 'PUBLISHED',
      ))
      this.s.replace('blueprintDods', { ...old, status: 'SUPERSEDED' });
    const y = { ...d, status: 'PUBLISHED' as const };
    this.s.replace('blueprintDods', y);
    evt(
      this.s,
      c,
      'BlueprintDefinitionOfDonePublished',
      'BlueprintDefinitionOfDone',
      id,
      { contentHash: d.contentHash },
    );
    return y;
  }
}
