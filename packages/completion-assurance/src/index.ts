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

// Engine 36 — Inspection & Field Verification

export type ChecklistItem = { item: string; required: boolean };
export type InspectionFinding = {
  checklistItem: string;
  result: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  evidenceReference?: string;
  notes: string;
};

export type Inspection = {
  id: string;
  workspaceId: string;
  workItemId: string;
  scheduledFor: string;
  checklist: ChecklistItem[];
  findings: InspectionFinding[];
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  passed: boolean;
  reinspectionOfId?: string;
  createdAt: string;
};

export class InspectionEngine {
  constructor(private readonly store: TrustPersistence) {}

  async schedule(
    context: RequestContext,
    input: { workItemId: string; scheduledFor: string; checklist: ChecklistItem[]; reinspectionOfId?: string },
  ) {
    if (!input.checklist.length) throw new Error('CHECKLIST_REQUIRED');
    if (input.reinspectionOfId) {
      const prior = await get<Inspection>(this.store, 'inspections', context, input.reinspectionOfId);
      if (prior.status !== 'COMPLETED' || prior.passed) throw new Error('REINSPECTION_REQUIRES_PRIOR_FAILURE');
    }
    const inspection: Inspection = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      findings: [],
      status: 'SCHEDULED',
      passed: false,
      createdAt: now(),
    };
    await this.store.append('inspections', inspection);
    await emit(this.store, context, 'InspectionScheduled', 'Inspection', inspection.id, {
      workItemId: inspection.workItemId,
      reinspectionOfId: inspection.reinspectionOfId,
    });
    return inspection;
  }

  async complete(context: RequestContext, input: { id: string; findings: InspectionFinding[] }) {
    const inspection = await get<Inspection>(this.store, 'inspections', context, input.id);
    if (inspection.status !== 'SCHEDULED') throw new Error('INSPECTION_NOT_SCHEDULED');
    if (
      input.findings.length !== inspection.checklist.length ||
      !inspection.checklist.every((item) => input.findings.some((f) => f.checklistItem === item.item))
    )
      throw new Error('CHECKLIST_COVERAGE_REQUIRED');
    const passed = inspection.checklist
      .filter((item) => item.required)
      .every((item) => input.findings.find((f) => f.checklistItem === item.item)?.result === 'PASS');
    const completed: Inspection = { ...inspection, findings: input.findings, status: 'COMPLETED', passed };
    await this.store.replace('inspections', completed);
    await emit(this.store, context, 'InspectionCompleted', 'Inspection', inspection.id, {
      workItemId: inspection.workItemId,
      passed,
    });
    return completed;
  }
}

// Engine 37 — Issue, Risk & Corrective Action

export type IssueRecord = {
  id: string;
  workspaceId: string;
  workItemId: string;
  kind: 'ISSUE' | 'RISK';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  status: 'OPEN' | 'ESCALATED' | 'CAPA_IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  raisedBy: string;
  createdAt: string;
  escalatedAt?: string;
  resolvedAt?: string;
};

export type CorrectiveActionPlan = {
  id: string;
  workspaceId: string;
  issueId: string;
  actionPlan: string;
  ownerId: string;
  dueDate: string;
  status: 'OPEN' | 'COMPLETED' | 'VERIFIED';
  createdAt: string;
  completedAt?: string;
  verifiedAt?: string;
};

export class IssueRiskCorrectiveActionEngine {
  constructor(private readonly store: TrustPersistence) {}

  async raise(
    context: RequestContext,
    input: { workItemId: string; kind: IssueRecord['kind']; severity: IssueRecord['severity']; description: string },
  ) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    const issue: IssueRecord = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      raisedBy: context.actorUserId,
      createdAt: now(),
    };
    await this.store.append('issueRecords', issue);
    await emit(this.store, context, 'IssueRaised', 'IssueRecord', issue.id, {
      workItemId: issue.workItemId,
      severity: issue.severity,
    });
    return issue;
  }

  async escalate(context: RequestContext, input: { id: string; reason: string }) {
    const issue = await get<IssueRecord>(this.store, 'issueRecords', context, input.id);
    if (issue.status !== 'OPEN') throw new Error('ISSUE_NOT_OPEN');
    if (!input.reason.trim()) throw new Error('ESCALATION_REASON_REQUIRED');
    const escalated: IssueRecord = { ...issue, status: 'ESCALATED', escalatedAt: now() };
    await this.store.replace('issueRecords', escalated);
    await emit(this.store, context, 'IssueEscalated', 'IssueRecord', issue.id, { reason: input.reason });
    return escalated;
  }

  async openCapa(
    context: RequestContext,
    input: { issueId: string; actionPlan: string; ownerId: string; dueDate: string },
  ) {
    const issue = await get<IssueRecord>(this.store, 'issueRecords', context, input.issueId);
    if (issue.status !== 'OPEN' && issue.status !== 'ESCALATED') throw new Error('ISSUE_NOT_OPEN');
    if (!input.actionPlan.trim()) throw new Error('ACTION_PLAN_REQUIRED');
    const capa: CorrectiveActionPlan = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      createdAt: now(),
    };
    await this.store.append('correctiveActionPlans', capa);
    await this.store.replace('issueRecords', { ...issue, status: 'CAPA_IN_PROGRESS' });
    await emit(this.store, context, 'CorrectiveActionPlanOpened', 'CorrectiveActionPlan', capa.id, {
      issueId: capa.issueId,
    });
    return capa;
  }

  async completeCapa(context: RequestContext, id: string) {
    const capa = await get<CorrectiveActionPlan>(this.store, 'correctiveActionPlans', context, id);
    if (capa.status !== 'OPEN') throw new Error('CAPA_NOT_OPEN');
    const completed: CorrectiveActionPlan = { ...capa, status: 'COMPLETED', completedAt: now() };
    await this.store.replace('correctiveActionPlans', completed);
    await emit(this.store, context, 'CorrectiveActionPlanCompleted', 'CorrectiveActionPlan', capa.id, {
      issueId: capa.issueId,
    });
    return completed;
  }

  async verifyResolution(context: RequestContext, capaId: string) {
    const capa = await get<CorrectiveActionPlan>(this.store, 'correctiveActionPlans', context, capaId);
    if (capa.status !== 'COMPLETED') throw new Error('CAPA_NOT_COMPLETED');
    const verified: CorrectiveActionPlan = { ...capa, status: 'VERIFIED', verifiedAt: now() };
    await this.store.replace('correctiveActionPlans', verified);
    const issue = await get<IssueRecord>(this.store, 'issueRecords', context, capa.issueId);
    await this.store.replace('issueRecords', { ...issue, status: 'RESOLVED', resolvedAt: now() });
    await emit(this.store, context, 'IssueResolved', 'IssueRecord', issue.id, { capaId });
    return verified;
  }

  async close(context: RequestContext, issueId: string) {
    const issue = await get<IssueRecord>(this.store, 'issueRecords', context, issueId);
    if (issue.status !== 'RESOLVED') throw new Error('ISSUE_NOT_RESOLVED');
    const closed: IssueRecord = { ...issue, status: 'CLOSED' };
    await this.store.replace('issueRecords', closed);
    await emit(this.store, context, 'IssueClosed', 'IssueRecord', closed.id, {});
    return closed;
  }

  async blockers(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    return (await this.store
      .list<IssueRecord>('issueRecords'))
      .filter(
        (x) =>
          x.workspaceId === workspaceId &&
          x.workItemId === workItemId &&
          x.status !== 'RESOLVED' &&
          x.status !== 'CLOSED' &&
          (x.severity === 'HIGH' || x.severity === 'CRITICAL'),
      );
  }
}

// Engine 38 — Change Control

export type ChangeRequest = {
  id: string;
  workspaceId: string;
  blueprintId: string;
  milestoneId: string;
  changeType: 'SCOPE' | 'SCHEDULE' | 'COST' | 'ACCEPTANCE_CRITERIA' | 'EVIDENCE_REQUIREMENT' | 'PAYMENT_TRIGGER';
  description: string;
  impact: { scheduleDays?: number; costAmountMinor?: number };
  requestedBy: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'IMPLEMENTED';
  createdAt: string;
};

export type ChangeApproval = {
  id: string;
  workspaceId: string;
  changeRequestId: string;
  approverId: string;
  decision: 'APPROVE' | 'REJECT';
  rationale: string;
  decidedAt: string;
};

export class ChangeControlEngine {
  constructor(private readonly store: TrustPersistence) {}

  async draft(
    context: RequestContext,
    input: {
      blueprintId: string;
      milestoneId: string;
      changeType: ChangeRequest['changeType'];
      description: string;
      impact: ChangeRequest['impact'];
    },
  ) {
    if (!input.description.trim()) throw new Error('DESCRIPTION_REQUIRED');
    if (input.impact.costAmountMinor !== undefined && !Number.isInteger(input.impact.costAmountMinor))
      throw new Error('IMPACT_COST_AMOUNT_MUST_BE_INTEGER_MINOR_UNITS');
    const request: ChangeRequest = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      requestedBy: context.actorUserId,
      status: 'DRAFT',
      createdAt: now(),
    };
    await this.store.append('changeRequests', request);
    await emit(this.store, context, 'ChangeRequestDrafted', 'ChangeRequest', request.id, {
      milestoneId: request.milestoneId,
      changeType: request.changeType,
    });
    return request;
  }

  async submit(context: RequestContext, id: string) {
    const request = await get<ChangeRequest>(this.store, 'changeRequests', context, id);
    if (request.status !== 'DRAFT') throw new Error('CHANGE_REQUEST_NOT_DRAFT');
    const submitted: ChangeRequest = { ...request, status: 'SUBMITTED' };
    await this.store.replace('changeRequests', submitted);
    await emit(this.store, context, 'ChangeRequestSubmitted', 'ChangeRequest', id, { changeType: request.changeType });
    return submitted;
  }

  async decide(
    context: RequestContext,
    input: { changeRequestId: string; decision: ChangeApproval['decision']; rationale: string },
  ) {
    const request = await get<ChangeRequest>(this.store, 'changeRequests', context, input.changeRequestId);
    if (request.status !== 'SUBMITTED') throw new Error('CHANGE_REQUEST_NOT_SUBMITTED');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const approval: ChangeApproval = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      approverId: context.actorUserId,
      decidedAt: now(),
    };
    await this.store.append('changeApprovals', approval);
    const decided: ChangeRequest = { ...request, status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    await this.store.replace('changeRequests', decided);
    await emit(this.store, context, 'ChangeRequestDecided', 'ChangeRequest', request.id, { decision: input.decision });
    return decided;
  }

  async implement(context: RequestContext, id: string) {
    const request = await get<ChangeRequest>(this.store, 'changeRequests', context, id);
    if (request.status !== 'APPROVED') throw new Error('CHANGE_REQUEST_NOT_APPROVED');
    const implemented: ChangeRequest = { ...request, status: 'IMPLEMENTED' };
    await this.store.replace('changeRequests', implemented);
    await emit(this.store, context, 'ChangeRequestImplemented', 'ChangeRequest', id, {});
    return implemented;
  }
}

// Engine 39 — Acceptance & Decision

export type AcceptanceDecisionKind = 'FULL' | 'PARTIAL' | 'CONDITIONAL' | 'PROVISIONAL' | 'REJECTED' | 'DEFERRED';
const ACCEPTED_DECISIONS: AcceptanceDecisionKind[] = ['FULL', 'PARTIAL', 'CONDITIONAL', 'PROVISIONAL'];

export type AcceptanceDecision = {
  id: string;
  workspaceId: string;
  workItemId: string;
  decision: AcceptanceDecisionKind;
  rationale: string;
  conditions: string[];
  status: 'ACTIVE' | 'SUPERSEDED';
  decidedBy: string;
  decidedAt: string;
  supersedesId?: string;
};

export class AcceptanceDecisionEngine {
  constructor(private readonly store: TrustPersistence) {}

  async decide(
    context: RequestContext,
    input: { workItemId: string; decision: AcceptanceDecisionKind; rationale: string; conditions?: string[] },
  ) {
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    if (input.decision === 'CONDITIONAL' && !(input.conditions && input.conditions.length))
      throw new Error('CONDITIONS_REQUIRED');
    const workspaceId = ws(context);
    const prior = await this.latest(context, input.workItemId);
    if (prior) await this.store.replace('acceptanceDecisions', { ...prior, status: 'SUPERSEDED' as const });
    const decision: AcceptanceDecision = {
      id: randomUUID(),
      workspaceId,
      workItemId: input.workItemId,
      decision: input.decision,
      rationale: input.rationale,
      conditions: input.conditions ?? [],
      status: 'ACTIVE',
      decidedBy: context.actorUserId,
      decidedAt: now(),
      supersedesId: prior?.id,
    };
    await this.store.append('acceptanceDecisions', decision);
    await emit(this.store, context, 'AcceptanceDecided', 'AcceptanceDecision', decision.id, {
      workItemId: decision.workItemId,
      decision: decision.decision,
    });
    return decision;
  }

  async latest(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    return (await this.store
      .list<AcceptanceDecision>('acceptanceDecisions'))
      .filter((x) => x.workspaceId === workspaceId && x.workItemId === workItemId && x.status === 'ACTIVE')
      .pop();
  }

  async isAccepted(context: RequestContext, workItemId: string) {
    const decision = await this.latest(context, workItemId);
    return !!decision && ACCEPTED_DECISIONS.includes(decision.decision);
  }
}

// Engine 40 — Completion Certification

export type CompletionCertificate = {
  id: string;
  workspaceId: string;
  workItemId: string;
  milestoneId: string;
  certificateNumber: string;
  acceptanceDecisionId: string;
  canonicalHash: string;
  status: 'CERTIFIED' | 'REVOKED';
  issuedBy: string;
  issuedAt: string;
  revokedAt?: string;
};

export class CompletionCertificationEngine {
  constructor(private readonly store: TrustPersistence) {}

  async issue(
    context: RequestContext,
    input: {
      workItemId: string;
      milestoneId: string;
      acceptanceDecisionId: string;
      qualityGatePassed: boolean;
      inspectionPassed: boolean;
      openBlockingIssueCount: number;
    },
  ) {
    const workspaceId = ws(context);
    if (
      (await this.store
        .list<CompletionCertificate>('completionCertificates'))
        .some((x) => x.workspaceId === workspaceId && x.workItemId === input.workItemId && x.status === 'CERTIFIED')
    )
      throw new Error('CERTIFICATE_ALREADY_ISSUED');
    if (!input.qualityGatePassed) throw new Error('QUALITY_GATE_NOT_PASSED');
    if (!input.inspectionPassed) throw new Error('INSPECTION_NOT_PASSED');
    if (input.openBlockingIssueCount > 0) throw new Error('BLOCKING_ISSUES_OPEN');
    const acceptance = await get<AcceptanceDecision>(this.store, 'acceptanceDecisions', context, input.acceptanceDecisionId);
    if (acceptance.status !== 'ACTIVE' || !ACCEPTED_DECISIONS.includes(acceptance.decision))
      throw new Error('ACTIVE_ACCEPTANCE_REQUIRED');
    const sequence =
      (await this.store.list<CompletionCertificate>('completionCertificates')).filter((x) => x.workspaceId === workspaceId)
        .length + 1;
    const stamp = now();
    const certificate: CompletionCertificate = {
      id: randomUUID(),
      workspaceId,
      workItemId: input.workItemId,
      milestoneId: input.milestoneId,
      certificateNumber: `CERT-${sequence.toString().padStart(6, '0')}`,
      acceptanceDecisionId: input.acceptanceDecisionId,
      canonicalHash: digest({
        workItemId: input.workItemId,
        milestoneId: input.milestoneId,
        acceptanceDecisionId: input.acceptanceDecisionId,
        acceptanceDecision: acceptance.decision,
      }),
      status: 'CERTIFIED',
      issuedBy: context.actorUserId,
      issuedAt: stamp,
    };
    await this.store.append('completionCertificates', certificate);
    await emit(this.store, context, 'CompletionCertificateIssued', 'CompletionCertificate', certificate.id, {
      workItemId: certificate.workItemId,
      certificateNumber: certificate.certificateNumber,
    });
    return certificate;
  }

  async revoke(context: RequestContext, input: { id: string; reason: string }) {
    const certificate = await get<CompletionCertificate>(this.store, 'completionCertificates', context, input.id);
    if (certificate.status !== 'CERTIFIED') throw new Error('CERTIFICATE_NOT_CERTIFIED');
    if (!input.reason.trim()) throw new Error('REVOCATION_REASON_REQUIRED');
    const revoked: CompletionCertificate = { ...certificate, status: 'REVOKED', revokedAt: now() };
    await this.store.replace('completionCertificates', revoked);
    await emit(this.store, context, 'CompletionCertificateRevoked', 'CompletionCertificate', certificate.id, {
      reason: input.reason,
    });
    return revoked;
  }

  async verify(context: RequestContext, id: string) {
    const certificate = await get<CompletionCertificate>(this.store, 'completionCertificates', context, id);
    return { certificateId: id, status: certificate.status, canonicalHash: certificate.canonicalHash };
  }
}
