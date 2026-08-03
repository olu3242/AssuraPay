import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  AcceptanceDecisionEngine,
  ChangeControlEngine,
  CompletionCertificationEngine,
  InspectionEngine,
  IssueRiskCorrectiveActionEngine,
} from './index';

describe('e2e Batch 8 field-verified, issue-cleared work item to a completion certificate', () => {
  it('carries a failed then passed reinspection, a resolved blocking issue, an approved change and a full acceptance into a certificate', () => {
    const s = new InMemoryTrustStore();
    const c = {
      actorUserId: 'inspector',
      sessionId: 's',
      identityAssuranceLevel: 'IAL2_VERIFIED' as const,
      activeWorkspaceId: 'w',
      tenantId: 't',
      memberships: ['w'],
      correlationId: 'c',
    };

    const inspections = new InspectionEngine(s);
    const first = inspections.schedule(c, {
      workItemId: 'wi',
      scheduledFor: '2026-08-10',
      checklist: [{ item: 'weld-quality', required: true }],
    });
    const failed = inspections.complete(c, {
      id: first.id,
      findings: [{ checklistItem: 'weld-quality', result: 'FAIL', notes: 'porosity found' }],
    });

    const issues = new IssueRiskCorrectiveActionEngine(s);
    const issue = issues.raise(c, {
      workItemId: 'wi',
      kind: 'ISSUE',
      severity: 'HIGH',
      description: 'Weld porosity blocking sign-off',
    });
    const capa = issues.openCapa(c, {
      issueId: issue.id,
      actionPlan: 'Re-weld and re-inspect affected joints',
      ownerId: 'contractor',
      dueDate: '2026-08-14',
    });
    issues.completeCapa(c, capa.id);
    issues.verifyResolution(c, capa.id);
    expect(issues.blockers(c, 'wi')).toHaveLength(0);

    const reinspection = inspections.schedule(c, {
      workItemId: 'wi',
      scheduledFor: '2026-08-15',
      checklist: [{ item: 'weld-quality', required: true }],
      reinspectionOfId: failed.id,
    });
    const passed = inspections.complete(c, {
      id: reinspection.id,
      findings: [{ checklistItem: 'weld-quality', result: 'PASS', notes: 're-weld verified' }],
    });
    expect(passed.passed).toBe(true);

    const changes = new ChangeControlEngine(s);
    const change = changes.draft(c, {
      blueprintId: 'bp',
      milestoneId: 'm',
      changeType: 'SCHEDULE',
      description: 'Extend milestone due date for re-weld rework',
      impact: { scheduleDays: 4 },
    });
    changes.submit(c, change.id);
    changes.decide(c, { changeRequestId: change.id, decision: 'APPROVE', rationale: 'rework justified' });
    expect(changes.implement(c, change.id).status).toBe('IMPLEMENTED');

    const acceptance = new AcceptanceDecisionEngine(s);
    const decision = acceptance.decide(c, { workItemId: 'wi', decision: 'FULL', rationale: 'reinspection passed' });

    const certification = new CompletionCertificationEngine(s);
    const certificate = certification.issue(c, {
      workItemId: 'wi',
      milestoneId: 'm',
      acceptanceDecisionId: decision.id,
      qualityGatePassed: true,
      inspectionPassed: passed.passed,
      openBlockingIssueCount: issues.blockers(c, 'wi').length,
    });
    expect(certificate).toMatchObject({ status: 'CERTIFIED', workItemId: 'wi', milestoneId: 'm' });
    expect(certification.verify(c, certificate.id)).toMatchObject({
      status: 'CERTIFIED',
      canonicalHash: certificate.canonicalHash,
    });
  });
});
