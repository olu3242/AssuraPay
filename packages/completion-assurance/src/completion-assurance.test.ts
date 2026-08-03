import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AcceptanceDecisionEngine,
  ChangeControlEngine,
  CompletionCertificationEngine,
  InspectionEngine,
  IssueRiskCorrectiveActionEngine,
} from './index';

const c = {
  actorUserId: 'inspector',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};

describe('Engine 36 Inspection & Field Verification', () => {
  it('requires full checklist coverage, fails on a missed required item, and only allows reinspection after failure', () => {
    const s = new InMemoryTrustStore();
    const e = new InspectionEngine(s);
    const inspection = e.schedule(c, {
      workItemId: 'wi',
      scheduledFor: '2026-08-10',
      checklist: [{ item: 'weld-quality', required: true }, { item: 'coating', required: false }],
    });
    expect(() => e.complete(c, { id: inspection.id, findings: [{ checklistItem: 'weld-quality', result: 'FAIL', notes: '' }] })).toThrow(
      'CHECKLIST_COVERAGE_REQUIRED',
    );
    const failed = e.complete(c, {
      id: inspection.id,
      findings: [
        { checklistItem: 'weld-quality', result: 'FAIL', notes: 'porosity found' },
        { checklistItem: 'coating', result: 'PASS', notes: '' },
      ],
    });
    expect(failed.passed).toBe(false);
    expect(() =>
      e.schedule(c, { workItemId: 'wi', scheduledFor: '2026-08-12', checklist: [{ item: 'weld-quality', required: true }] }),
    ).not.toThrow();
    const passedInspection = e.complete(
      c,
      {
        id: e.schedule(c, { workItemId: 'wi2', scheduledFor: '2026-08-10', checklist: [{ item: 'x', required: true }] }).id,
        findings: [{ checklistItem: 'x', result: 'PASS', notes: '' }],
      },
    );
    expect(() =>
      e.schedule(c, { workItemId: 'wi2', scheduledFor: '2026-08-11', checklist: [{ item: 'x', required: true }], reinspectionOfId: passedInspection.id }),
    ).toThrow('REINSPECTION_REQUIRES_PRIOR_FAILURE');
    const reinspection = e.schedule(c, {
      workItemId: 'wi',
      scheduledFor: '2026-08-13',
      checklist: [{ item: 'weld-quality', required: true }],
      reinspectionOfId: failed.id,
    });
    expect(reinspection.reinspectionOfId).toBe(failed.id);
  });
});

describe('Engine 37 Issue, Risk & Corrective Action', () => {
  it('routes an issue through escalation, corrective action and resolution, and blocks on open high-severity issues', () => {
    const s = new InMemoryTrustStore();
    const e = new IssueRiskCorrectiveActionEngine(s);
    const issue = e.raise(c, { workItemId: 'wi', kind: 'ISSUE', severity: 'HIGH', description: 'Delayed material delivery' });
    expect(e.blockers(c, 'wi')).toHaveLength(1);
    expect(() => e.escalate(c, { id: issue.id, reason: '' })).toThrow('ESCALATION_REASON_REQUIRED');
    e.escalate(c, { id: issue.id, reason: 'past due by 5 days' });
    const capa = e.openCapa(c, { issueId: issue.id, actionPlan: 'Expedite via alternate supplier', ownerId: 'procurement', dueDate: '2026-08-20' });
    expect(() => e.verifyResolution(c, capa.id)).toThrow('CAPA_NOT_COMPLETED');
    e.completeCapa(c, capa.id);
    e.verifyResolution(c, capa.id);
    expect(e.blockers(c, 'wi')).toHaveLength(0);
    expect(e.close(c, issue.id).status).toBe('CLOSED');
  });
});

describe('Engine 38 Change Control', () => {
  it('requires submission before a decision and approval before implementation', () => {
    const s = new InMemoryTrustStore();
    const e = new ChangeControlEngine(s);
    const request = e.draft(c, {
      blueprintId: 'bp',
      milestoneId: 'm',
      changeType: 'SCHEDULE',
      description: 'Extend erection window by 5 days',
      impact: { scheduleDays: 5 },
    });
    expect(() => e.decide(c, { changeRequestId: request.id, decision: 'APPROVE', rationale: 'weather' })).toThrow(
      'CHANGE_REQUEST_NOT_SUBMITTED',
    );
    e.submit(c, request.id);
    expect(() => e.decide(c, { changeRequestId: request.id, decision: 'APPROVE', rationale: '' })).toThrow(
      'RATIONALE_REQUIRED',
    );
    const decided = e.decide(c, { changeRequestId: request.id, decision: 'APPROVE', rationale: 'weather delay accepted' });
    expect(decided.status).toBe('APPROVED');
    expect(e.implement(c, request.id).status).toBe('IMPLEMENTED');
  });
});

describe('Engine 39 Acceptance & Decision', () => {
  it('requires conditions for a conditional decision and supersedes the prior decision for the same work item', () => {
    const s = new InMemoryTrustStore();
    const e = new AcceptanceDecisionEngine(s);
    expect(() => e.decide(c, { workItemId: 'wi', decision: 'CONDITIONAL', rationale: 'minor punch list' })).toThrow(
      'CONDITIONS_REQUIRED',
    );
    const first = e.decide(c, {
      workItemId: 'wi',
      decision: 'CONDITIONAL',
      rationale: 'minor punch list',
      conditions: ['touch up paint'],
    });
    expect(e.isAccepted(c, 'wi')).toBe(true);
    const second = e.decide(c, { workItemId: 'wi', decision: 'FULL', rationale: 'punch list cleared' });
    expect(second.supersedesId).toBe(first.id);
    expect(e.latest(c, 'wi')?.id).toBe(second.id);
    e.decide(c, { workItemId: 'wi2', decision: 'REJECTED', rationale: 'work not to spec' });
    expect(e.isAccepted(c, 'wi2')).toBe(false);
  });
});

describe('Engine 40 Completion Certification', () => {
  it('requires every gate to pass before issuing exactly one certificate per work item', () => {
    const s = new InMemoryTrustStore();
    const acceptance = new AcceptanceDecisionEngine(s);
    const decision = acceptance.decide(c, { workItemId: 'wi', decision: 'FULL', rationale: 'all criteria met' });
    const e = new CompletionCertificationEngine(s);
    expect(() =>
      e.issue(c, {
        workItemId: 'wi',
        milestoneId: 'm',
        acceptanceDecisionId: decision.id,
        qualityGatePassed: false,
        inspectionPassed: true,
        openBlockingIssueCount: 0,
      }),
    ).toThrow('QUALITY_GATE_NOT_PASSED');
    expect(() =>
      e.issue(c, {
        workItemId: 'wi',
        milestoneId: 'm',
        acceptanceDecisionId: decision.id,
        qualityGatePassed: true,
        inspectionPassed: true,
        openBlockingIssueCount: 2,
      }),
    ).toThrow('BLOCKING_ISSUES_OPEN');
    const certificate = e.issue(c, {
      workItemId: 'wi',
      milestoneId: 'm',
      acceptanceDecisionId: decision.id,
      qualityGatePassed: true,
      inspectionPassed: true,
      openBlockingIssueCount: 0,
    });
    expect(certificate.status).toBe('CERTIFIED');
    expect(() =>
      e.issue(c, {
        workItemId: 'wi',
        milestoneId: 'm',
        acceptanceDecisionId: decision.id,
        qualityGatePassed: true,
        inspectionPassed: true,
        openBlockingIssueCount: 0,
      }),
    ).toThrow('CERTIFICATE_ALREADY_ISSUED');
    expect(e.verify(c, certificate.id)).toMatchObject({ status: 'CERTIFIED', canonicalHash: certificate.canonicalHash });
    expect(() => e.revoke(c, { id: certificate.id, reason: '' })).toThrow('REVOCATION_REASON_REQUIRED');
    expect(e.revoke(c, { id: certificate.id, reason: 'defect discovered post-certification' }).status).toBe('REVOKED');
  });
});
