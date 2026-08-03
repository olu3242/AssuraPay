import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  EvidenceManagementEngine,
  ExecutionOrchestrationEngine,
  ProgressMeasurementEngine,
  QualityAssuranceEngine,
  ValidationAcceptanceTestingEngine,
} from './index';

const c = {
  actorUserId: 'operator',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 31 Execution Orchestration', () => {
  it('gates work item assignment and submission on workspace and work item lifecycle state', () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutionOrchestrationEngine(s);
    const workspace = e.open(c, { blueprintId: 'bp', milestoneId: 'm' });
    expect(() => e.open(c, { blueprintId: 'bp', milestoneId: 'm' })).toThrow('ALREADY_OPEN');
    expect(() =>
      e.assignWorkItem(c, {
        executionWorkspaceId: workspace.id,
        deliverableId: 'd',
        title: 'Erect frame',
        assigneeId: 'contractor',
      }),
    ).toThrow('EXECUTION_WORKSPACE_NOT_ACTIVE');
    e.activate(c, workspace.id);
    const item = e.assignWorkItem(c, {
      executionWorkspaceId: workspace.id,
      deliverableId: 'd',
      title: 'Erect frame',
      assigneeId: 'contractor',
    });
    expect(() => e.submit(c, workspace.id)).toThrow('WORK_ITEMS_NOT_TERMINAL');
    expect(() => e.transitionWorkItem(c, { id: item.id, to: 'SUBMITTED' })).toThrow('INVALID_WORK_ITEM_TRANSITION');
    e.transitionWorkItem(c, { id: item.id, to: 'IN_PROGRESS' });
    e.transitionWorkItem(c, { id: item.id, to: 'SUBMITTED' });
    expect(e.submit(c, workspace.id).status).toBe('SUBMITTED');
  });

  it('requires a reason to suspend and validates resume/submit transitions', () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutionOrchestrationEngine(s);
    const workspace = e.activate(c, e.open(c, { blueprintId: 'bp', milestoneId: 'm' }).id);
    expect(() => e.suspend(c, { id: workspace.id, reason: '' })).toThrow('SUSPENSION_REASON_REQUIRED');
    const suspended = e.suspend(c, { id: workspace.id, reason: 'weather delay' });
    expect(suspended.status).toBe('SUSPENDED');
    expect(() => e.submit(c, workspace.id)).toThrow('EXECUTION_WORKSPACE_NOT_ACTIVE');
    expect(e.resume(c, workspace.id).status).toBe('ACTIVE');
    expect(e.submit(c, workspace.id).status).toBe('SUBMITTED');
  });
});

describe('Engine 32 Progress Measurement', () => {
  it('rejects stage and percent regression and gates financially-earned progress on acceptance and full completion', () => {
    const s = new InMemoryTrustStore();
    const e = new ProgressMeasurementEngine(s);
    e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 20 });
    expect(() => e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 10 })).toThrow(
      'PROGRESS_PERCENT_REGRESSION',
    );
    e.record(c, { workItemId: 'wi', stage: 'EVIDENCED', percentComplete: 60 });
    expect(() => e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 70 })).toThrow(
      'PROGRESS_STAGE_REGRESSION',
    );
    expect(() =>
      e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100, earnedValueAmountMinor: 100 }),
    ).toThrow('ACCEPTED_PROGRESS_REQUIRED');
    e.record(c, { workItemId: 'wi', stage: 'VALIDATED', percentComplete: 80 });
    e.record(c, { workItemId: 'wi', stage: 'ACCEPTED', percentComplete: 100 });
    expect(() =>
      e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100 }),
    ).toThrow('EARNED_VALUE_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    expect(() =>
      e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100, earnedValueAmountMinor: 100.5 }),
    ).toThrow('EARNED_VALUE_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    const earned = e.record(c, {
      workItemId: 'wi',
      stage: 'FINANCIALLY_EARNED',
      percentComplete: 100,
      earnedValueAmountMinor: 425_000_00,
    });
    expect(earned.stage).toBe('FINANCIALLY_EARNED');
  });
});

describe('Engine 33 Evidence Management', () => {
  it('blocks submission until every mandatory requirement is covered and requires notes to verify', () => {
    const s = new InMemoryTrustStore();
    const e = new EvidenceManagementEngine(s);
    const photo = e.defineRequirement(c, { deliverableId: 'd', kind: 'PHOTO', description: 'Site photo', mandatory: true });
    const signoff = e.defineRequirement(c, {
      deliverableId: 'd',
      kind: 'SIGNOFF',
      description: 'Engineer sign-off',
      mandatory: true,
    });
    expect(() =>
      e.submit(c, {
        workItemId: 'wi',
        deliverableId: 'd',
        files: [{ requirementId: photo.id, reference: 'secure://photo', hash: 'h1', mimeType: 'image/jpeg' }],
      }),
    ).toThrow('MANDATORY_EVIDENCE_MISSING');
    const pkg = e.submit(c, {
      workItemId: 'wi',
      deliverableId: 'd',
      files: [
        { requirementId: photo.id, reference: 'secure://photo', hash: 'h1', mimeType: 'image/jpeg' },
        { requirementId: signoff.id, reference: 'secure://signoff', hash: 'h2', mimeType: 'application/pdf' },
      ],
    });
    expect(() => e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: '' })).toThrow('VERIFICATION_NOTES_REQUIRED');
    const verified = e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: 'matches site conditions' });
    expect(verified.status).toBe('VERIFIED');
    expect(() => e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: 'again' })).toThrow(
      'EVIDENCE_PACKAGE_NOT_SUBMITTED',
    );
  });
});

describe('Engine 34 Validation & Acceptance Testing', () => {
  it('requires notes for conditional pass, requires prior failure for a retest, and aggregates pass status', () => {
    const s = new InMemoryTrustStore();
    const e = new ValidationAcceptanceTestingEngine(s);
    expect(() =>
      e.record(c, {
        workItemId: 'wi',
        acceptanceCriterionId: 'ac',
        method: 'MANUAL',
        result: 'CONDITIONAL_PASS',
        notes: '',
      }),
    ).toThrow('CONDITIONAL_PASS_NOTES_REQUIRED');
    const failed = e.record(c, {
      workItemId: 'wi',
      acceptanceCriterionId: 'ac',
      method: 'MANUAL',
      result: 'FAIL',
      notes: 'plumb deviation exceeded',
    });
    expect(e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac'] })).toBe(false);
    expect(() =>
      e.record(c, {
        workItemId: 'wi',
        acceptanceCriterionId: 'ac2',
        method: 'MANUAL',
        result: 'PASS',
        notes: '',
        retestOf: 'missing',
      }),
    ).toThrow('NOT_FOUND');
    e.record(c, {
      workItemId: 'wi',
      acceptanceCriterionId: 'ac',
      method: 'MANUAL',
      result: 'PASS',
      notes: 'retested and within tolerance',
      retestOf: failed.id,
    });
    expect(e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac'] })).toBe(true);
  });
});

describe('Engine 35 Quality Assurance', () => {
  it('requires a root cause to resolve a defect and blocks the quality gate on open critical defects', () => {
    const s = new InMemoryTrustStore();
    const e = new QualityAssuranceEngine(s);
    e.definePlan(c, { executionWorkspaceId: 'ew', standards: ['NIS-1'], inspectionFrequency: 'WEEKLY' });
    const defect = e.raiseDefect(c, { workItemId: 'wi', severity: 'CRITICAL', description: 'Weld porosity found' });
    expect(e.evaluateGate(c, 'wi')).toMatchObject({ passed: false, criticalDefectCount: 1 });
    expect(() => e.resolve(c, defect.id)).toThrow('DEFECT_NOT_IN_REWORK');
    e.assignRootCause(c, { id: defect.id, rootCause: 'Contaminated filler rod' });
    const resolved = e.resolve(c, defect.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(e.evaluateGate(c, 'wi')).toMatchObject({ passed: true, criticalDefectCount: 0 });
    expect(e.close(c, defect.id).status).toBe('CLOSED');
  });
});
