import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  BlueprintDefinitionOfDoneEngine,
  DeliverablesEngine,
  MilestonePlanningEngine,
  PerformanceBlueprintEngine,
  ScopeDefinitionEngine,
} from './index';
describe('e2e Batch 5 published intelligence to executable blueprint', () => {
  it('publishes a complete source-grounded immutable plan', () => {
    const s = new InMemoryTrustStore(),
      c = {
        actorUserId: 'planner',
        sessionId: 's',
        identityAssuranceLevel: 'IAL2_VERIFIED' as const,
        activeWorkspaceId: 'w',
        tenantId: 't',
        memberships: ['w'],
        correlationId: 'c',
      };
    s.append('agreementIntelligenceVersions', {
      id: 'intel',
      workspaceId: 'w',
      status: 'PUBLISHED',
    });
    const blueprints = new PerformanceBlueprintEngine(s),
      b = blueprints.create(c, {
        contractId: 'contract',
        agreementIntelligenceVersionId: 'intel',
        title: 'Data Delivery',
        description: 'Executable plan',
        objectives: [
          {
            key: 'deliver',
            description: 'Deliver dataset',
            sourceReference: 'clause:2',
          },
        ],
        configurationSnapshotId: 'cfg',
      }),
      scopes = new ScopeDefinitionEngine(s),
      scope = scopes.define(c, {
        blueprintId: b.id,
        included: [
          {
            key: 'dataset',
            description: 'Verified dataset',
            ownerId: 'vendor',
            sourceReference: 'clause:2',
          },
        ],
        excluded: [],
        assumptions: [],
        constraints: [],
      });
    scopes.validate(c, scope.id);
    const deliverables = new DeliverablesEngine(s),
      d = deliverables.create(c, {
        blueprintId: b.id,
        key: 'dataset',
        title: 'Dataset',
        description: '100 records',
        ownerId: 'vendor',
        quantity: 100,
        unit: 'records',
        dueDate: '2026-09-01',
        acceptanceMethod: 'automated',
        evidenceRequirements: ['manifest'],
        sourceReferences: ['clause:3'],
      });
    deliverables.validate(c, d.id);
    new MilestonePlanningEngine(s).create(c, {
      blueprintId: b.id,
      key: 'delivery',
      title: 'Delivery',
      ownerId: 'vendor',
      durationDays: 5,
      valueMinor: 10000,
      currency: 'NGN',
      deliverableIds: [d.id],
    });
    const dod = new BlueprintDefinitionOfDoneEngine(s),
      definition = dod.create(c, b.id, d.id, [
        {
          key: 'count',
          description: '100 accepted',
          mandatory: true,
          measurement: { operator: 'GTE', target: 100 },
          evidenceRequirements: ['manifest'],
          validatorRole: 'QUALITY',
          sourceReference: 'clause:4',
        },
      ]);
    dod.publish(c, definition.id);
    expect(
      blueprints.publish({ ...c, actorUserId: 'publisher' }, b.id),
    ).toMatchObject({
      status: 'PUBLISHED',
      agreementIntelligenceVersionId: 'intel',
    });
  });
});
