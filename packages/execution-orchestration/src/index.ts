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

// Engine 31 — Execution Orchestration

export type ExecutionWorkspace = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  milestoneId: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'SUBMITTED';
  createdAt: string;
};

export type WorkItem = {
  id: string;
  workspaceId: string;
  executionWorkspaceId: string;
  deliverableId: string;
  title: string;
  assigneeId: string;
  status: 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'CANCELLED';
  createdAt: string;
  updatedAt: string;
};

const WORK_ITEM_TRANSITIONS: Record<WorkItem['status'], WorkItem['status'][]> = {
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: [],
  CANCELLED: [],
};

export class ExecutionOrchestrationEngine {
  constructor(private readonly store: TrustPersistence) {}

  async open(context: RequestContext, input: { blueprintId: string; milestoneId: string }) {
    const workspaceId = ws(context);
    if (
      (await this.store
        .list<ExecutionWorkspace>('executionWorkspaces'))
        .some((x) => x.workspaceId === workspaceId && x.milestoneId === input.milestoneId)
    )
      throw new Error('EXECUTION_WORKSPACE_ALREADY_OPEN');
    const workspace: ExecutionWorkspace = {
      id: randomUUID(),
      workspaceId,
      ...input,
      status: 'DRAFT',
      createdAt: now(),
    };
    await this.store.append('executionWorkspaces', workspace);
    await emit(this.store, context, 'ExecutionWorkspaceOpened', 'ExecutionWorkspace', workspace.id, {
      milestoneId: workspace.milestoneId,
    });
    return workspace;
  }

  async activate(context: RequestContext, id: string) {
    const workspace = await get<ExecutionWorkspace>(this.store, 'executionWorkspaces', context, id);
    if (workspace.status !== 'DRAFT') throw new Error('EXECUTION_WORKSPACE_NOT_DRAFT');
    const activated: ExecutionWorkspace = { ...workspace, status: 'ACTIVE' };
    await this.store.replace('executionWorkspaces', activated);
    await emit(this.store, context, 'ExecutionWorkspaceActivated', 'ExecutionWorkspace', id, {
      milestoneId: workspace.milestoneId,
    });
    return activated;
  }

  async assignWorkItem(
    context: RequestContext,
    input: { executionWorkspaceId: string; deliverableId: string; title: string; assigneeId: string },
  ) {
    const workspace = await get<ExecutionWorkspace>(this.store, 'executionWorkspaces', context, input.executionWorkspaceId);
    if (workspace.status !== 'ACTIVE') throw new Error('EXECUTION_WORKSPACE_NOT_ACTIVE');
    if (!input.title.trim()) throw new Error('TITLE_REQUIRED');
    const stamp = now();
    const item: WorkItem = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'ASSIGNED',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.store.append('workItems', item);
    await emit(this.store, context, 'WorkItemAssigned', 'WorkItem', item.id, {
      executionWorkspaceId: item.executionWorkspaceId,
      deliverableId: item.deliverableId,
    });
    return item;
  }

  async transitionWorkItem(context: RequestContext, input: { id: string; to: WorkItem['status'] }) {
    const item = await get<WorkItem>(this.store, 'workItems', context, input.id);
    if (!WORK_ITEM_TRANSITIONS[item.status].includes(input.to)) throw new Error('INVALID_WORK_ITEM_TRANSITION');
    const updated: WorkItem = { ...item, status: input.to, updatedAt: now() };
    await this.store.replace('workItems', updated);
    await emit(this.store, context, 'WorkItemTransitioned', 'WorkItem', item.id, {
      fromStatus: item.status,
      toStatus: input.to,
    });
    return updated;
  }

  async suspend(context: RequestContext, input: { id: string; reason: string }) {
    const workspace = await get<ExecutionWorkspace>(this.store, 'executionWorkspaces', context, input.id);
    if (workspace.status !== 'ACTIVE') throw new Error('EXECUTION_WORKSPACE_NOT_ACTIVE');
    if (!input.reason.trim()) throw new Error('SUSPENSION_REASON_REQUIRED');
    const suspended: ExecutionWorkspace = { ...workspace, status: 'SUSPENDED' };
    await this.store.replace('executionWorkspaces', suspended);
    await emit(this.store, context, 'ExecutionWorkspaceSuspended', 'ExecutionWorkspace', input.id, {
      reason: input.reason,
    });
    return suspended;
  }

  async resume(context: RequestContext, id: string) {
    const workspace = await get<ExecutionWorkspace>(this.store, 'executionWorkspaces', context, id);
    if (workspace.status !== 'SUSPENDED') throw new Error('EXECUTION_WORKSPACE_NOT_SUSPENDED');
    const resumed: ExecutionWorkspace = { ...workspace, status: 'ACTIVE' };
    await this.store.replace('executionWorkspaces', resumed);
    await emit(this.store, context, 'ExecutionWorkspaceResumed', 'ExecutionWorkspace', id, {});
    return resumed;
  }

  async submit(context: RequestContext, id: string) {
    const workspace = await get<ExecutionWorkspace>(this.store, 'executionWorkspaces', context, id);
    if (workspace.status !== 'ACTIVE') throw new Error('EXECUTION_WORKSPACE_NOT_ACTIVE');
    const workspaceId = ws(context);
    const items = (await this.store
      .list<WorkItem>('workItems'))
      .filter((x) => x.workspaceId === workspaceId && x.executionWorkspaceId === id);
    if (items.some((x) => x.status === 'ASSIGNED' || x.status === 'IN_PROGRESS'))
      throw new Error('WORK_ITEMS_NOT_TERMINAL');
    const submitted: ExecutionWorkspace = { ...workspace, status: 'SUBMITTED' };
    await this.store.replace('executionWorkspaces', submitted);
    await emit(this.store, context, 'ExecutionWorkspaceSubmitted', 'ExecutionWorkspace', id, {
      workItemCount: items.length,
    });
    return submitted;
  }
}

// Engine 32 — Progress Measurement

export type ProgressStage = 'DECLARED' | 'EVIDENCED' | 'VALIDATED' | 'ACCEPTED' | 'FINANCIALLY_EARNED';
const PROGRESS_STAGE_ORDER: ProgressStage[] = ['DECLARED', 'EVIDENCED', 'VALIDATED', 'ACCEPTED', 'FINANCIALLY_EARNED'];

export type ProgressRecord = {
  id: string;
  workspaceId: string;
  workItemId: string;
  stage: ProgressStage;
  percentComplete: number;
  earnedValueAmountMinor?: number;
  reportedBy: string;
  createdAt: string;
};

export class ProgressMeasurementEngine {
  constructor(private readonly store: TrustPersistence) {}

  async record(
    context: RequestContext,
    input: {
      workItemId: string;
      stage: ProgressStage;
      percentComplete: number;
      earnedValueAmountMinor?: number;
    },
  ) {
    if (input.percentComplete < 0 || input.percentComplete > 100) throw new Error('INVALID_PERCENT_COMPLETE');
    const workspaceId = ws(context);
    const latest = await this.latest(context, input.workItemId);
    const stageIndex = PROGRESS_STAGE_ORDER.indexOf(input.stage);
    if (latest) {
      const latestIndex = PROGRESS_STAGE_ORDER.indexOf(latest.stage);
      if (stageIndex < latestIndex) throw new Error('PROGRESS_STAGE_REGRESSION');
      if (input.percentComplete < latest.percentComplete) throw new Error('PROGRESS_PERCENT_REGRESSION');
    }
    if (input.stage === 'FINANCIALLY_EARNED') {
      if (!latest || latest.stage !== 'ACCEPTED') throw new Error('ACCEPTED_PROGRESS_REQUIRED');
      if (input.percentComplete !== 100) throw new Error('FINANCIALLY_EARNED_REQUIRES_COMPLETION');
      if (!input.earnedValueAmountMinor || !Number.isInteger(input.earnedValueAmountMinor) || input.earnedValueAmountMinor <= 0)
        throw new Error('EARNED_VALUE_MUST_BE_POSITIVE_INTEGER_MINOR_UNITS');
    }
    const record: ProgressRecord = {
      id: randomUUID(),
      workspaceId,
      ...input,
      reportedBy: context.actorUserId,
      createdAt: now(),
    };
    await this.store.append('progressRecords', record);
    await emit(this.store, context, 'ProgressRecorded', 'WorkItem', input.workItemId, {
      stage: record.stage,
      percentComplete: record.percentComplete,
    });
    return record;
  }

  async latest(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    const records = (await this.store
      .list<ProgressRecord>('progressRecords'))
      .filter((x) => x.workspaceId === workspaceId && x.workItemId === workItemId);
    return records[records.length - 1];
  }
}

// Engine 33 — Evidence Management

export type EvidenceRequirement = {
  id: string;
  workspaceId: string;
  deliverableId: string;
  kind: string;
  description: string;
  mandatory: boolean;
  createdAt: string;
};

export type EvidenceFile = { requirementId: string; reference: string; hash: string; mimeType: string };

export type EvidencePackage = {
  id: string;
  workspaceId: string;
  workItemId: string;
  deliverableId: string;
  files: EvidenceFile[];
  chainOfCustody: Array<{ actorId: string; action: string; at: string }>;
  status: 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
  createdAt: string;
};

export class EvidenceManagementEngine {
  constructor(private readonly store: TrustPersistence) {}

  async defineRequirement(
    context: RequestContext,
    input: { deliverableId: string; kind: string; description: string; mandatory: boolean },
  ) {
    const requirement: EvidenceRequirement = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      createdAt: now(),
    };
    await this.store.append('evidenceRequirements', requirement);
    await emit(this.store, context, 'EvidenceRequirementDefined', 'EvidenceRequirement', requirement.id, {
      deliverableId: requirement.deliverableId,
      mandatory: requirement.mandatory,
    });
    return requirement;
  }

  async submit(context: RequestContext, input: { workItemId: string; deliverableId: string; files: EvidenceFile[] }) {
    if (!input.files.length) throw new Error('EVIDENCE_FILE_REQUIRED');
    const workspaceId = ws(context);
    const requirements = (await this.store
      .list<EvidenceRequirement>('evidenceRequirements'))
      .filter((x) => x.workspaceId === workspaceId && x.deliverableId === input.deliverableId);
    for (const file of input.files)
      if (!requirements.some((x) => x.id === file.requirementId)) throw new Error('REQUIREMENT_NOT_FOUND');
    const coveredIds = input.files.map((x) => x.requirementId);
    if (requirements.some((x) => x.mandatory && !coveredIds.includes(x.id)))
      throw new Error('MANDATORY_EVIDENCE_MISSING');
    const stamp = now();
    const pkg: EvidencePackage = {
      id: randomUUID(),
      workspaceId,
      ...input,
      chainOfCustody: [{ actorId: context.actorUserId, action: 'SUBMITTED', at: stamp }],
      status: 'SUBMITTED',
      createdAt: stamp,
    };
    await this.store.append('evidencePackages', pkg);
    await emit(this.store, context, 'EvidencePackageSubmitted', 'EvidencePackage', pkg.id, {
      workItemId: pkg.workItemId,
      fileCount: pkg.files.length,
    });
    return pkg;
  }

  async verify(context: RequestContext, input: { id: string; decision: 'VERIFIED' | 'REJECTED'; notes: string }) {
    const pkg = await get<EvidencePackage>(this.store, 'evidencePackages', context, input.id);
    if (pkg.status !== 'SUBMITTED') throw new Error('EVIDENCE_PACKAGE_NOT_SUBMITTED');
    if (!input.notes.trim()) throw new Error('VERIFICATION_NOTES_REQUIRED');
    const verified: EvidencePackage = {
      ...pkg,
      status: input.decision,
      chainOfCustody: [...pkg.chainOfCustody, { actorId: context.actorUserId, action: input.decision, at: now() }],
    };
    await this.store.replace('evidencePackages', verified);
    await emit(this.store, context, 'EvidencePackageVerified', 'EvidencePackage', pkg.id, {
      decision: input.decision,
      contentHash: digest(pkg.files),
    });
    return verified;
  }
}

// Engine 34 — Validation & Acceptance Testing

export type ValidationTest = {
  id: string;
  workspaceId: string;
  workItemId: string;
  acceptanceCriterionId: string;
  method: 'MANUAL' | 'AUTOMATED';
  result: 'PASS' | 'FAIL' | 'CONDITIONAL_PASS' | 'WAIVED';
  notes: string;
  evidencePackageId?: string;
  retestOf?: string;
  testedBy: string;
  testedAt: string;
};

const ACCEPTABLE_TEST_RESULTS: ValidationTest['result'][] = ['PASS', 'CONDITIONAL_PASS', 'WAIVED'];

export class ValidationAcceptanceTestingEngine {
  constructor(private readonly store: TrustPersistence) {}

  async record(
    context: RequestContext,
    input: {
      workItemId: string;
      acceptanceCriterionId: string;
      method: ValidationTest['method'];
      result: ValidationTest['result'];
      notes: string;
      evidencePackageId?: string;
      retestOf?: string;
    },
  ) {
    if (input.result === 'CONDITIONAL_PASS' && !input.notes.trim())
      throw new Error('CONDITIONAL_PASS_NOTES_REQUIRED');
    if (input.retestOf) {
      const prior = await get<ValidationTest>(this.store, 'validationTests', context, input.retestOf);
      if (prior.result !== 'FAIL' && prior.result !== 'CONDITIONAL_PASS')
        throw new Error('RETEST_REQUIRES_PRIOR_FAILURE');
    }
    const test: ValidationTest = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      testedBy: context.actorUserId,
      testedAt: now(),
    };
    await this.store.append('validationTests', test);
    await emit(this.store, context, 'ValidationTestRecorded', 'ValidationTest', test.id, {
      workItemId: test.workItemId,
      result: test.result,
    });
    return test;
  }

  async latestResult(context: RequestContext, input: { workItemId: string; acceptanceCriterionId: string }) {
    const workspaceId = ws(context);
    const tests = (await this.store
      .list<ValidationTest>('validationTests'))
      .filter(
        (x) =>
          x.workspaceId === workspaceId &&
          x.workItemId === input.workItemId &&
          x.acceptanceCriterionId === input.acceptanceCriterionId,
      );
    return tests[tests.length - 1];
  }

  async passed(
    context: RequestContext,
    input: { workItemId: string; acceptanceCriterionIds: string[] },
  ): Promise<boolean> {
    // Results are resolved before the aggregate is computed. `every` with an async
    // predicate returns true for any non-empty list, because each predicate call
    // yields a truthy promise rather than a verdict — a validation gate that
    // always passes.
    const results = await Promise.all(
      input.acceptanceCriterionIds.map(async (acceptanceCriterionId) => {
        const latest = await this.latestResult(context, { workItemId: input.workItemId, acceptanceCriterionId });
        return !!latest && ACCEPTABLE_TEST_RESULTS.includes(latest.result);
      }),
    );
    return results.every((accepted) => accepted);
  }
}

// Engine 35 — Quality Assurance

export type QualityPlan = {
  id: string;
  workspaceId: string;
  executionWorkspaceId: string;
  standards: string[];
  inspectionFrequency: string;
  status: 'ACTIVE';
  createdAt: string;
};

export type Defect = {
  id: string;
  workspaceId: string;
  workItemId: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
  description: string;
  rootCause?: string;
  status: 'OPEN' | 'IN_REWORK' | 'RESOLVED' | 'CLOSED';
  raisedBy: string;
  createdAt: string;
  resolvedAt?: string;
};

export type QualityGateResult = {
  id: string;
  workspaceId: string;
  workItemId: string;
  passed: boolean;
  openDefectCount: number;
  criticalDefectCount: number;
  evaluatedAt: string;
};

export class QualityAssuranceEngine {
  constructor(private readonly store: TrustPersistence) {}

  async definePlan(
    context: RequestContext,
    input: { executionWorkspaceId: string; standards: string[]; inspectionFrequency: string },
  ) {
    if (!input.standards.length) throw new Error('QUALITY_STANDARD_REQUIRED');
    const plan: QualityPlan = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'ACTIVE',
      createdAt: now(),
    };
    await this.store.append('qualityPlans', plan);
    await emit(this.store, context, 'QualityPlanDefined', 'QualityPlan', plan.id, {
      executionWorkspaceId: plan.executionWorkspaceId,
    });
    return plan;
  }

  async raiseDefect(context: RequestContext, input: { workItemId: string; severity: Defect['severity']; description: string }) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    const defect: Defect = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      raisedBy: context.actorUserId,
      createdAt: now(),
    };
    await this.store.append('defects', defect);
    await emit(this.store, context, 'DefectRaised', 'Defect', defect.id, {
      workItemId: defect.workItemId,
      severity: defect.severity,
    });
    return defect;
  }

  async assignRootCause(context: RequestContext, input: { id: string; rootCause: string }) {
    const defect = await get<Defect>(this.store, 'defects', context, input.id);
    if (defect.status !== 'OPEN' && defect.status !== 'IN_REWORK') throw new Error('DEFECT_NOT_OPEN');
    if (!input.rootCause.trim()) throw new Error('ROOT_CAUSE_REQUIRED');
    const updated: Defect = { ...defect, rootCause: input.rootCause, status: 'IN_REWORK' };
    await this.store.replace('defects', updated);
    await emit(this.store, context, 'DefectRootCauseAssigned', 'Defect', defect.id, { rootCause: input.rootCause });
    return updated;
  }

  async resolve(context: RequestContext, id: string) {
    const defect = await get<Defect>(this.store, 'defects', context, id);
    if (defect.status !== 'IN_REWORK') throw new Error('DEFECT_NOT_IN_REWORK');
    if (!defect.rootCause) throw new Error('ROOT_CAUSE_REQUIRED');
    const resolved: Defect = { ...defect, status: 'RESOLVED', resolvedAt: now() };
    await this.store.replace('defects', resolved);
    await emit(this.store, context, 'DefectResolved', 'Defect', id, { workItemId: defect.workItemId });
    return resolved;
  }

  async close(context: RequestContext, id: string) {
    const defect = await get<Defect>(this.store, 'defects', context, id);
    if (defect.status !== 'RESOLVED') throw new Error('DEFECT_NOT_RESOLVED');
    const closed: Defect = { ...defect, status: 'CLOSED' };
    await this.store.replace('defects', closed);
    await emit(this.store, context, 'DefectClosed', 'Defect', defect.id, { workItemId: defect.workItemId });
    return closed;
  }

  async evaluateGate(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    const openDefects = (await this.store
      .list<Defect>('defects'))
      .filter(
        (x) =>
          x.workspaceId === workspaceId &&
          x.workItemId === workItemId &&
          (x.status === 'OPEN' || x.status === 'IN_REWORK'),
      );
    const criticalDefectCount = openDefects.filter((x) => x.severity === 'CRITICAL').length;
    const result: QualityGateResult = {
      id: randomUUID(),
      workspaceId,
      workItemId,
      passed: criticalDefectCount === 0,
      openDefectCount: openDefects.length,
      criticalDefectCount,
      evaluatedAt: now(),
    };
    await this.store.append('qualityGateResults', result);
    await emit(this.store, context, 'QualityGateEvaluated', 'QualityGateResult', result.id, {
      workItemId,
      passed: result.passed,
    });
    return result;
  }
}
