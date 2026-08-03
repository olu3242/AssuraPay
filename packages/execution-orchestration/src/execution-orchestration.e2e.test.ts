import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  EvidenceManagementEngine,
  ExecutionOrchestrationEngine,
  ProgressMeasurementEngine,
  QualityAssuranceEngine,
  ValidationAcceptanceTestingEngine,
} from './index';

describe('e2e Batch 7 activated blueprint to financially earned, submitted work item', () => {
  it('carries assignment, evidence, acceptance testing and a clean quality gate into financially earned progress', () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'operator',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const orchestration = new ExecutionOrchestrationEngine(s);
    const workspace = orchestration.activate(
      c,
      orchestration.open(c, { blueprintId: 'blueprint', milestoneId: 'erection-milestone' }).id,
    );
    const workItem = orchestration.assignWorkItem(c, {
      executionWorkspaceId: workspace.id,
      deliverableId: 'frame-deliverable',
      title: 'Erect structural steel frame',
      assigneeId: 'contractor',
    });
    orchestration.transitionWorkItem(c, { id: workItem.id, to: 'IN_PROGRESS' });

    const evidence = new EvidenceManagementEngine(s);
    const requirement = evidence.defineRequirement(c, {
      deliverableId: 'frame-deliverable',
      kind: 'ENGINEER_SIGNOFF',
      description: 'Engineer sign-off',
      mandatory: true,
    });
    const pkg = evidence.submit(c, {
      workItemId: workItem.id,
      deliverableId: 'frame-deliverable',
      files: [{ requirementId: requirement.id, reference: 'secure://signoff', hash: 'h1', mimeType: 'application/pdf' }],
    });
    evidence.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: 'matches inspection record' });

    const validation = new ValidationAcceptanceTestingEngine(s);
    validation.record(c, {
      workItemId: workItem.id,
      acceptanceCriterionId: 'plumb-level',
      method: 'MANUAL',
      result: 'PASS',
      notes: 'within tolerance',
      evidencePackageId: pkg.id,
    });
    expect(validation.passed(c, { workItemId: workItem.id, acceptanceCriterionIds: ['plumb-level'] })).toBe(true);

    const quality = new QualityAssuranceEngine(s);
    quality.definePlan(c, { executionWorkspaceId: workspace.id, standards: ['NIS-1'], inspectionFrequency: 'WEEKLY' });
    expect(quality.evaluateGate(c, workItem.id)).toMatchObject({ passed: true, criticalDefectCount: 0 });

    const progress = new ProgressMeasurementEngine(s);
    progress.record(c, { workItemId: workItem.id, stage: 'DECLARED', percentComplete: 50 });
    progress.record(c, { workItemId: workItem.id, stage: 'EVIDENCED', percentComplete: 80 });
    progress.record(c, { workItemId: workItem.id, stage: 'VALIDATED', percentComplete: 90 });
    progress.record(c, { workItemId: workItem.id, stage: 'ACCEPTED', percentComplete: 100 });
    const earned = progress.record(c, {
      workItemId: workItem.id,
      stage: 'FINANCIALLY_EARNED',
      percentComplete: 100,
      earnedValueAmountMinor: 4_250_000_00,
    });
    expect(earned.earnedValueAmountMinor).toBe(4_250_000_00);

    orchestration.transitionWorkItem(c, { id: workItem.id, to: 'SUBMITTED' });
    expect(orchestration.submit(c, workspace.id)).toMatchObject({ status: 'SUBMITTED' });
  });
});
