import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  DefinitionOfDonePackageEngine,
  DeliverablesEngine,
  MilestonePlanningEngine,
  PerformanceBlueprintEngine,
  ScopeDefinitionEngine,
} from './index';

describe('e2e Batch 5 published intelligence to activated performance blueprint', () => {
  it('carries scope, deliverables, milestones and a published Definition of Done gate into an activated blueprint', async () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'planner',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const blueprints = new PerformanceBlueprintEngine(s);
    const blueprint = await blueprints.draft(c, {
      contractId: 'contract',
      contractVersionId: 'executed-version',
      agreementIntelligenceVersionId: 'published-intelligence',
    });

    const scope = new ScopeDefinitionEngine(s);
    const included = await scope.define(c, {
      blueprintId: blueprint.id,
      kind: 'INCLUDED',
      description: 'Fabricate and erect the structural steel frame',
      assumptions: ['site access granted by 2026-08-01'],
      constraints: ['dry-season construction window'],
      ownerId: 'contractor',
    });
    await scope.confirm(c, included.id);

    const deliverables = new DeliverablesEngine(s);
    const frame = await deliverables.define(c, {
      blueprintId: blueprint.id,
      scopeItemId: included.id,
      title: 'Structural steel frame',
      quantity: 1,
      unit: 'lot',
      qualityStandard: 'NIS-1',
      ownerId: 'contractor',
      dueDate: '2026-09-01',
      acceptanceCriteria: ['frame plumb and level within tolerance'],
      evidenceRequirements: ['inspection photos', 'engineer sign-off'],
    });
    await deliverables.confirm(c, frame.id);

    const milestones = new MilestonePlanningEngine(s);
    const erection = await milestones.schedule(c, {
      blueprintId: blueprint.id,
      title: 'Frame erected',
      deliverableIds: [frame.id],
      startDate: '2026-08-01',
      dueDate: '2026-09-01',
      budgetAmountMinor: 4_250_000_00,
      currency: 'NGN',
      valueAllocationPercent: 100,
    });

    await expect(await blueprints.activate(c, blueprint.id)).rejects.toThrow('DOD_PACKAGE_REQUIRED');

    const dod = new DefinitionOfDonePackageEngine(s);
    const draft = await dod.draft(c, {
      milestoneId: erection.id,
      deliverableGateIds: [frame.id],
      criteria: [
        { key: 'plumb-level', description: 'Frame plumb and level', mandatory: true, evaluationType: 'MANUAL' },
      ],
      evidenceRequirements: ['inspection photos', 'engineer sign-off'],
      qualityGate: true,
      complianceGate: true,
      riskGate: false,
      paymentGate: true,
    });
    await dod.publish(c, draft.id);

    const activated = await blueprints.activate(c, blueprint.id);
    expect(activated).toMatchObject({ status: 'ACTIVE', contractId: 'contract' });
    expect((await milestones.criticalPath(c, blueprint.id)).days).toBeGreaterThan(0);
  });
});
