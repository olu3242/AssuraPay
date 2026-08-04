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
function get<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  collection: string,
  context: RequestContext,
  id: string,
) {
  const found = store
    .list<T>(collection)
    .find((x) => x.id === id && x.workspaceId === ws(context));
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
function emit(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  store.audit({
    tenantId: context.tenantId,
    workspaceId: ws(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata: payload,
  });
  store.emit({
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

  schedule(
    context: RequestContext,
    input: { workItemId: string; scheduledFor: string; checklist: ChecklistItem[]; reinspectionOfId?: string },
  ) {
    if (!input.checklist.length) throw new Error('CHECKLIST_REQUIRED');
    if (input.reinspectionOfId) {
      const prior = get<Inspection>(this.store, 'inspections', context, input.reinspectionOfId);
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
    this.store.append('inspections', inspection);
    emit(this.store, context, 'InspectionScheduled', 'Inspection', inspection.id, {
      workItemId: inspection.workItemId,
      reinspectionOfId: inspection.reinspectionOfId,
    });
    return inspection;
  }

  complete(context: RequestContext, input: { id: string; findings: InspectionFinding[] }) {
    const inspection = get<Inspection>(this.store, 'inspections', context, input.id);
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
    this.store.replace('inspections', completed);
    emit(this.store, context, 'InspectionCompleted', 'Inspection', inspection.id, {
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

  raise(
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
    this.store.append('issueRecords', issue);
    emit(this.store, context, 'IssueRaised', 'IssueRecord', issue.id, {
      workItemId: issue.workItemId,
      severity: issue.severity,
    });
    return issue;
  }

  escalate(context: RequestContext, input: { id: string; reason: string }) {
    const issue = get<IssueRecord>(this.store, 'issueRecords', context, input.id);
    if (issue.status !== 'OPEN') throw new Error('ISSUE_NOT_OPEN');
    if (!input.reason.trim()) throw new Error('ESCALATION_REASON_REQUIRED');
    const escalated: IssueRecord = { ...issue, status: 'ESCALATED', escalatedAt: now() };
    this.store.replace('issueRecords', escalated);
    emit(this.store, context, 'IssueEscalated', 'IssueRecord', issue.id, { reason: input.reason });
    return escalated;
  }

  openCapa(
    context: RequestContext,
    input: { issueId: string; actionPlan: string; ownerId: string; dueDate: string },
  ) {
    const issue = get<IssueRecord>(this.store, 'issueRecords', context, input.issueId);
    if (issue.status !== 'OPEN' && issue.status !== 'ESCALATED') throw new Error('ISSUE_NOT_OPEN');
    if (!input.actionPlan.trim()) throw new Error('ACTION_PLAN_REQUIRED');
    const capa: CorrectiveActionPlan = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      status: 'OPEN',
      createdAt: now(),
    };
    this.store.append('correctiveActionPlans', capa);
    this.store.replace('issueRecords', { ...issue, status: 'CAPA_IN_PROGRESS' });
    emit(this.store, context, 'CorrectiveActionPlanOpened', 'CorrectiveActionPlan', capa.id, {
      issueId: capa.issueId,
    });
    return capa;
  }

  completeCapa(context: RequestContext, id: string) {
    const capa = get<CorrectiveActionPlan>(this.store, 'correctiveActionPlans', context, id);
    if (capa.status !== 'OPEN') throw new Error('CAPA_NOT_OPEN');
    const completed: CorrectiveActionPlan = { ...capa, status: 'COMPLETED', completedAt: now() };
    this.store.replace('correctiveActionPlans', completed);
    emit(this.store, context, 'CorrectiveActionPlanCompleted', 'CorrectiveActionPlan', capa.id, {
      issueId: capa.issueId,
    });
    return completed;
  }

  verifyResolution(context: RequestContext, capaId: string) {
    const capa = get<CorrectiveActionPlan>(this.store, 'correctiveActionPlans', context, capaId);
    if (capa.status !== 'COMPLETED') throw new Error('CAPA_NOT_COMPLETED');
    const verified: CorrectiveActionPlan = { ...capa, status: 'VERIFIED', verifiedAt: now() };
    this.store.replace('correctiveActionPlans', verified);
    const issue = get<IssueRecord>(this.store, 'issueRecords', context, capa.issueId);
    this.store.replace('issueRecords', { ...issue, status: 'RESOLVED', resolvedAt: now() });
    emit(this.store, context, 'IssueResolved', 'IssueRecord', issue.id, { capaId });
    return verified;
  }

  close(context: RequestContext, issueId: string) {
    const issue = get<IssueRecord>(this.store, 'issueRecords', context, issueId);
    if (issue.status !== 'RESOLVED') throw new Error('ISSUE_NOT_RESOLVED');
    const closed: IssueRecord = { ...issue, status: 'CLOSED' };
    this.store.replace('issueRecords', closed);
    emit(this.store, context, 'IssueClosed', 'IssueRecord', closed.id, {});
    return closed;
  }

  blockers(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<IssueRecord>('issueRecords')
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

  draft(
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
    this.store.append('changeRequests', request);
    emit(this.store, context, 'ChangeRequestDrafted', 'ChangeRequest', request.id, {
      milestoneId: request.milestoneId,
      changeType: request.changeType,
    });
    return request;
  }

  submit(context: RequestContext, id: string) {
    const request = get<ChangeRequest>(this.store, 'changeRequests', context, id);
    if (request.status !== 'DRAFT') throw new Error('CHANGE_REQUEST_NOT_DRAFT');
    const submitted: ChangeRequest = { ...request, status: 'SUBMITTED' };
    this.store.replace('changeRequests', submitted);
    emit(this.store, context, 'ChangeRequestSubmitted', 'ChangeRequest', id, { changeType: request.changeType });
    return submitted;
  }

  decide(
    context: RequestContext,
    input: { changeRequestId: string; decision: ChangeApproval['decision']; rationale: string },
  ) {
    const request = get<ChangeRequest>(this.store, 'changeRequests', context, input.changeRequestId);
    if (request.status !== 'SUBMITTED') throw new Error('CHANGE_REQUEST_NOT_SUBMITTED');
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    const approval: ChangeApproval = {
      id: randomUUID(),
      workspaceId: ws(context),
      ...input,
      approverId: context.actorUserId,
      decidedAt: now(),
    };
    this.store.append('changeApprovals', approval);
    const decided: ChangeRequest = { ...request, status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
    this.store.replace('changeRequests', decided);
    emit(this.store, context, 'ChangeRequestDecided', 'ChangeRequest', request.id, { decision: input.decision });
    return decided;
  }

  implement(context: RequestContext, id: string) {
    const request = get<ChangeRequest>(this.store, 'changeRequests', context, id);
    if (request.status !== 'APPROVED') throw new Error('CHANGE_REQUEST_NOT_APPROVED');
    const implemented: ChangeRequest = { ...request, status: 'IMPLEMENTED' };
    this.store.replace('changeRequests', implemented);
    emit(this.store, context, 'ChangeRequestImplemented', 'ChangeRequest', id, {});
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

  decide(
    context: RequestContext,
    input: { workItemId: string; decision: AcceptanceDecisionKind; rationale: string; conditions?: string[] },
  ) {
    if (!input.rationale.trim()) throw new Error('RATIONALE_REQUIRED');
    if (input.decision === 'CONDITIONAL' && !(input.conditions && input.conditions.length))
      throw new Error('CONDITIONS_REQUIRED');
    const workspaceId = ws(context);
    const prior = this.latest(context, input.workItemId);
    if (prior) this.store.replace('acceptanceDecisions', { ...prior, status: 'SUPERSEDED' as const });
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
    this.store.append('acceptanceDecisions', decision);
    emit(this.store, context, 'AcceptanceDecided', 'AcceptanceDecision', decision.id, {
      workItemId: decision.workItemId,
      decision: decision.decision,
    });
    return decision;
  }

  latest(context: RequestContext, workItemId: string) {
    const workspaceId = ws(context);
    return this.store
      .list<AcceptanceDecision>('acceptanceDecisions')
      .filter((x) => x.workspaceId === workspaceId && x.workItemId === workItemId && x.status === 'ACTIVE')
      .pop();
  }

  isAccepted(context: RequestContext, workItemId: string) {
    const decision = this.latest(context, workItemId);
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

  issue(
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
      this.store
        .list<CompletionCertificate>('completionCertificates')
        .some((x) => x.workspaceId === workspaceId && x.workItemId === input.workItemId && x.status === 'CERTIFIED')
    )
      throw new Error('CERTIFICATE_ALREADY_ISSUED');
    if (!input.qualityGatePassed) throw new Error('QUALITY_GATE_NOT_PASSED');
    if (!input.inspectionPassed) throw new Error('INSPECTION_NOT_PASSED');
    if (input.openBlockingIssueCount > 0) throw new Error('BLOCKING_ISSUES_OPEN');
    const acceptance = get<AcceptanceDecision>(this.store, 'acceptanceDecisions', context, input.acceptanceDecisionId);
    if (acceptance.status !== 'ACTIVE' || !ACCEPTED_DECISIONS.includes(acceptance.decision))
      throw new Error('ACTIVE_ACCEPTANCE_REQUIRED');
    const sequence =
      this.store.list<CompletionCertificate>('completionCertificates').filter((x) => x.workspaceId === workspaceId)
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
    this.store.append('completionCertificates', certificate);
    emit(this.store, context, 'CompletionCertificateIssued', 'CompletionCertificate', certificate.id, {
      workItemId: certificate.workItemId,
      certificateNumber: certificate.certificateNumber,
    });
    return certificate;
  }

  revoke(context: RequestContext, input: { id: string; reason: string }) {
    const certificate = get<CompletionCertificate>(this.store, 'completionCertificates', context, input.id);
    if (certificate.status !== 'CERTIFIED') throw new Error('CERTIFICATE_NOT_CERTIFIED');
    if (!input.reason.trim()) throw new Error('REVOCATION_REASON_REQUIRED');
    const revoked: CompletionCertificate = { ...certificate, status: 'REVOKED', revokedAt: now() };
    this.store.replace('completionCertificates', revoked);
    emit(this.store, context, 'CompletionCertificateRevoked', 'CompletionCertificate', certificate.id, {
      reason: input.reason,
    });
    return revoked;
  }

  verify(context: RequestContext, id: string) {
    const certificate = get<CompletionCertificate>(this.store, 'completionCertificates', context, id);
    return { certificateId: id, status: certificate.status, canonicalHash: certificate.canonicalHash };
  }
}
