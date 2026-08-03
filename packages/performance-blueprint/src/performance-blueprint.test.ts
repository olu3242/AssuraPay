import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  BlueprintDefinitionOfDoneEngine,
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
function blueprint(s: InMemoryTrustStore) {
  s.append('agreementIntelligenceVersions', {
    id: 'intel',
    workspaceId: 'w',
    status: 'PUBLISHED',
  });
  return new PerformanceBlueprintEngine(s).create(c, {
    contractId: 'contract',
    agreementIntelligenceVersionId: 'intel',
    title: 'Delivery Blueprint',
    description: 'Operational truth',
    objectives: [
      {
        key: 'quality',
        description: 'Deliver quality data',
        sourceReference: 'clause:2',
      },
    ],
    configurationSnapshotId: 'config',
  });
}
describe('Engine 21 Performance Blueprint', () => {
  it('requires published intelligence, grounded objectives and complete immutable publication', () => {
    const s = new InMemoryTrustStore(),
      e = new PerformanceBlueprintEngine(s);
    expect(() =>
      e.create(c, {
        contractId: 'c',
        agreementIntelligenceVersionId: 'missing',
        title: 'x',
        description: 'x',
        objectives: [],
        configurationSnapshotId: 'cfg',
      }),
    ).toThrow('PUBLISHED');
    const b = blueprint(s);
    expect(() => e.publish(c, b.id)).toThrow('INCOMPLETE');
  });
});
describe('Engine 22 Scope Definition', () => {
  it('requires grounded owned scope, blocks unresolved constraints and preserves validation', () => {
    const s = new InMemoryTrustStore(),
      b = blueprint(s),
      e = new ScopeDefinitionEngine(s),
      scope = e.define(c, {
        blueprintId: b.id,
        included: [
          {
            key: 'data',
            description: 'Dataset',
            ownerId: 'vendor',
            sourceReference: 'clause:2',
          },
        ],
        excluded: [],
        assumptions: [],
        constraints: [
          {
            key: 'approval',
            description: 'Regulatory approval',
            severity: 'BLOCKING',
          },
        ],
      });
    expect(() => e.validate(c, scope.id)).toThrow('BLOCKING');
    expect(() =>
      e.define(c, {
        blueprintId: b.id,
        included: [],
        excluded: [],
        assumptions: [],
        constraints: [],
      }),
    ).toThrow('GROUNDING');
  });
});
describe('Engine 23 Deliverables', () => {
  it('enforces unique, measurable, owned and evidenced deliverables', () => {
    const s = new InMemoryTrustStore(),
      b = blueprint(s),
      e = new DeliverablesEngine(s),
      d = e.create(c, {
        blueprintId: b.id,
        key: 'dataset',
        title: 'Dataset',
        description: 'Clean records',
        ownerId: 'vendor',
        quantity: 100,
        unit: 'records',
        dueDate: '2026-09-01',
        acceptanceMethod: 'validation',
        evidenceRequirements: ['manifest'],
        sourceReferences: ['clause:3'],
      });
    expect(e.validate(c, d.id).status).toBe('VALIDATED');
    expect(() =>
      e.create(c, {
        blueprintId: b.id,
        key: 'dataset',
        title: 'Duplicate',
        description: 'Duplicate key',
        ownerId: 'vendor',
        quantity: 1,
        unit: 'records',
        dueDate: '2026-09-01',
        acceptanceMethod: 'validation',
        evidenceRequirements: ['manifest'],
        sourceReferences: ['clause:3'],
      }),
    ).toThrow('DELIVERABLE_KEY_EXISTS');
  });
});
describe('Engine 24 Milestone Planning', () => {
  it('rejects cycles and calculates deterministic critical path', () => {
    const s = new InMemoryTrustStore(),
      b = blueprint(s),
      e = new MilestonePlanningEngine(s),
      a = e.create(c, {
        blueprintId: b.id,
        key: 'prepare',
        title: 'Prepare',
        ownerId: 'vendor',
        durationDays: 3,
        valueMinor: 100,
        currency: 'NGN',
        deliverableIds: ['d1'],
      }),
      z = e.create(c, {
        blueprintId: b.id,
        key: 'deliver',
        title: 'Deliver',
        ownerId: 'vendor',
        durationDays: 5,
        valueMinor: 200,
        currency: 'NGN',
        deliverableIds: ['d2'],
      });
    e.depend(c, b.id, a.id, z.id);
    expect(() => e.depend(c, b.id, z.id, a.id)).toThrow('CYCLE');
    expect(e.criticalPath(c, b.id)).toEqual({ days: 8, path: [a.id, z.id] });
  });
});
describe('Engine 25 Definition of Done', () => {
  it('requires measurable grounded criteria and keeps published versions immutable', () => {
    const s = new InMemoryTrustStore(),
      b = blueprint(s),
      e = new BlueprintDefinitionOfDoneEngine(s),
      d = e.publish(
        c,
        e.create(c, b.id, 'deliverable', [
          {
            key: 'count',
            description: 'Count delivered',
            mandatory: true,
            measurement: { operator: 'GTE', target: 100 },
            evidenceRequirements: ['manifest'],
            validatorRole: 'QUALITY',
            sourceReference: 'clause:4',
          },
        ]).id,
      );
    expect(() => e.publish(c, d.id)).toThrow('IMMUTABLE');
  });
});
