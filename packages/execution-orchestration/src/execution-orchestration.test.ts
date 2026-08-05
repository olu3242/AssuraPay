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
  it('gates work item assignment and submission on workspace and work item lifecycle state', async () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutionOrchestrationEngine(s);
    const workspace = await e.open(c, { blueprintId: 'bp', milestoneId: 'm' });
    await expect(e.open(c, { blueprintId: 'bp', milestoneId: 'm' })).rejects.toThrow('ALREADY_OPEN');
    await expect(e.assignWorkItem(c, {
        executionWorkspaceId: workspace.id,
        deliverableId: 'd',
        title: 'Erect frame',
        assigneeId: 'contractor',
      })).rejects.toThrow('EXECUTION_WORKSPACE_NOT_ACTIVE');
    await e.activate(c, workspace.id);
    const item = await e.assignWorkItem(c, {
      executionWorkspaceId: workspace.id,
      deliverableId: 'd',
      title: 'Erect frame',
      assigneeId: 'contractor',
    });
    await expect(e.submit(c, workspace.id)).rejects.toThrow('WORK_ITEMS_NOT_TERMINAL');
    await expect(e.transitionWorkItem(c, { id: item.id, to: 'SUBMITTED' })).rejects.toThrow('INVALID_WORK_ITEM_TRANSITION');
    await e.transitionWorkItem(c, { id: item.id, to: 'IN_PROGRESS' });
    await e.transitionWorkItem(c, { id: item.id, to: 'SUBMITTED' });
    expect((await e.submit(c, workspace.id)).status).toBe('SUBMITTED');
  });

  it('requires a reason to suspend and validates resume/submit transitions', async () => {
    const s = new InMemoryTrustStore();
    const e = new ExecutionOrchestrationEngine(s);
    const workspace = await e.activate(c, (await e.open(c, { blueprintId: 'bp', milestoneId: 'm' })).id);
    await expect(e.suspend(c, { id: workspace.id, reason: '' })).rejects.toThrow('SUSPENSION_REASON_REQUIRED');
    const suspended = await e.suspend(c, { id: workspace.id, reason: 'weather delay' });
    expect(suspended.status).toBe('SUSPENDED');
    await expect(e.submit(c, workspace.id)).rejects.toThrow('EXECUTION_WORKSPACE_NOT_ACTIVE');
    expect((await e.resume(c, workspace.id)).status).toBe('ACTIVE');
    expect((await e.submit(c, workspace.id)).status).toBe('SUBMITTED');
  });
});

describe('Engine 32 Progress Measurement', () => {
  it('rejects stage and percent regression and gates financially-earned progress on acceptance and full completion', async () => {
    const s = new InMemoryTrustStore();
    const e = new ProgressMeasurementEngine(s);
    await e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 20 });
    await expect(e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 10 })).rejects.toThrow(
      'PROGRESS_PERCENT_REGRESSION',
    );
    await e.record(c, { workItemId: 'wi', stage: 'EVIDENCED', percentComplete: 60 });
    await expect(e.record(c, { workItemId: 'wi', stage: 'DECLARED', percentComplete: 70 })).rejects.toThrow(
      'PROGRESS_STAGE_REGRESSION',
    );
    await expect(e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100, earnedValueAmountMinor: 100 })).rejects.toThrow('ACCEPTED_PROGRESS_REQUIRED');
    await e.record(c, { workItemId: 'wi', stage: 'VALIDATED', percentComplete: 80 });
    await e.record(c, { workItemId: 'wi', stage: 'ACCEPTED', percentComplete: 100 });
    await expect(e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100 })).rejects.toThrow('EARNED_VALUE_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    await expect(e.record(c, { workItemId: 'wi', stage: 'FINANCIALLY_EARNED', percentComplete: 100, earnedValueAmountMinor: 100.5 })).rejects.toThrow('EARNED_VALUE_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    const earned = await e.record(c, {
      workItemId: 'wi',
      stage: 'FINANCIALLY_EARNED',
      percentComplete: 100,
      earnedValueAmountMinor: 425_000_00,
    });
    expect(earned.stage).toBe('FINANCIALLY_EARNED');
  });
});

describe('Engine 33 Evidence Management', () => {
  it('blocks submission until every mandatory requirement is covered and requires notes to verify', async () => {
    const s = new InMemoryTrustStore();
    const e = new EvidenceManagementEngine(s);
    const photo = await e.defineRequirement(c, { deliverableId: 'd', kind: 'PHOTO', description: 'Site photo', mandatory: true });
    const signoff = await e.defineRequirement(c, {
      deliverableId: 'd',
      kind: 'SIGNOFF',
      description: 'Engineer sign-off',
      mandatory: true,
    });
    await expect(e.submit(c, {
        workItemId: 'wi',
        deliverableId: 'd',
        files: [{ requirementId: photo.id, reference: 'secure://photo', hash: 'h1', mimeType: 'image/jpeg' }],
      })).rejects.toThrow('MANDATORY_EVIDENCE_MISSING');
    const pkg = await e.submit(c, {
      workItemId: 'wi',
      deliverableId: 'd',
      files: [
        { requirementId: photo.id, reference: 'secure://photo', hash: 'h1', mimeType: 'image/jpeg' },
        { requirementId: signoff.id, reference: 'secure://signoff', hash: 'h2', mimeType: 'application/pdf' },
      ],
    });
    await expect(e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: '' })).rejects.toThrow('VERIFICATION_NOTES_REQUIRED');
    const verified = await e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: 'matches site conditions' });
    expect(verified.status).toBe('VERIFIED');
    await expect(e.verify(c, { id: pkg.id, decision: 'VERIFIED', notes: 'again' })).rejects.toThrow(
      'EVIDENCE_PACKAGE_NOT_SUBMITTED',
    );
  });
});

describe('Engine 34 Validation & Acceptance Testing', () => {
  it('requires notes for conditional pass, requires prior failure for a retest, and aggregates pass status', async () => {
    const s = new InMemoryTrustStore();
    const e = new ValidationAcceptanceTestingEngine(s);
    await expect(e.record(c, {
        workItemId: 'wi',
        acceptanceCriterionId: 'ac',
        method: 'MANUAL',
        result: 'CONDITIONAL_PASS',
        notes: '',
      })).rejects.toThrow('CONDITIONAL_PASS_NOTES_REQUIRED');
    const failed = await e.record(c, {
      workItemId: 'wi',
      acceptanceCriterionId: 'ac',
      method: 'MANUAL',
      result: 'FAIL',
      notes: 'plumb deviation exceeded',
    });
    expect(await e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac'] })).toBe(false);
    await expect(e.record(c, {
        workItemId: 'wi',
        acceptanceCriterionId: 'ac2',
        method: 'MANUAL',
        result: 'PASS',
        notes: '',
        retestOf: 'missing',
      })).rejects.toThrow('NOT_FOUND');
    await e.record(c, {
      workItemId: 'wi',
      acceptanceCriterionId: 'ac',
      method: 'MANUAL',
      result: 'PASS',
      notes: 'retested and within tolerance',
      retestOf: failed.id,
    });
    expect(await e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac'] })).toBe(true);
  });

  /**
   * `passed` is a gate on the completion chain, so a wrong `true` here propagates
   * into a certificate. These pin the aggregate against the shape that broke it:
   * `every` with an async predicate returns true for any non-empty list, because
   * each call yields a truthy promise rather than a verdict.
   */
  it('fails the aggregate when any one criterion of several is unmet', async () => {
    // The single-criterion case can pass by accident. A mixed list cannot.
    const e = new ValidationAcceptanceTestingEngine(new InMemoryTrustStore());
    for (const [acceptanceCriterionId, result] of [
      ['ac-pass', 'PASS'],
      ['ac-fail', 'FAIL'],
    ] as const)
      await e.record(c, {
        workItemId: 'wi',
        acceptanceCriterionId,
        method: 'MANUAL',
        result,
        notes: 'recorded',
      });

    expect(await e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac-pass'] })).toBe(true);
    expect(await e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac-pass', 'ac-fail'] })).toBe(
      false,
    );
  });

  it('fails a criterion that was never tested rather than treating absence as consent', async () => {
    const e = new ValidationAcceptanceTestingEngine(new InMemoryTrustStore());
    await e.record(c, {
      workItemId: 'wi',
      acceptanceCriterionId: 'ac-pass',
      method: 'MANUAL',
      result: 'PASS',
      notes: '',
    });

    expect(await e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac-pass', 'never-run'] })).toBe(
      false,
    );
  });

  it('returns a resolved verdict rather than a value the caller must interpret', async () => {
    // A promise is truthy, so `if (engine.passed(...))` on an unresolved call reads
    // as a pass. The method is async by contract; this asserts the shape callers see.
    const e = new ValidationAcceptanceTestingEngine(new InMemoryTrustStore());
    const verdict = e.passed(c, { workItemId: 'wi', acceptanceCriterionIds: ['ac'] });

    expect(typeof verdict.then).toBe('function');
    expect(await verdict).toBe(false);
  });
});

describe('Engine 35 Quality Assurance', () => {
  it('requires a root cause to resolve a defect and blocks the quality gate on open critical defects', async () => {
    const s = new InMemoryTrustStore();
    const e = new QualityAssuranceEngine(s);
    await e.definePlan(c, { executionWorkspaceId: 'ew', standards: ['NIS-1'], inspectionFrequency: 'WEEKLY' });
    const defect = await e.raiseDefect(c, { workItemId: 'wi', severity: 'CRITICAL', description: 'Weld porosity found' });
    expect(await e.evaluateGate(c, 'wi')).toMatchObject({ passed: false, criticalDefectCount: 1 });
    await expect(e.resolve(c, defect.id)).rejects.toThrow('DEFECT_NOT_IN_REWORK');
    await e.assignRootCause(c, { id: defect.id, rootCause: 'Contaminated filler rod' });
    const resolved = await e.resolve(c, defect.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(await e.evaluateGate(c, 'wi')).toMatchObject({ passed: true, criticalDefectCount: 0 });
    expect((await e.close(c, defect.id)).status).toBe('CLOSED');
  });
});
