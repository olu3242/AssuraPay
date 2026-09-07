import { describe, expect, it } from 'vitest';
import {
  AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1,
  AGENTIC_FLOW_HANDLERS,
} from './agentic-flow-bridge';

const protectedEvents = [
  'AgreementExecuted',
  'AgreementIntelligencePublished',
  'PerformanceBlueprintActivated',
  'DefinitionOfDonePackagePublished',
  'ExecutionWorkspaceActivated',
  'EvidencePackageVerified',
  'ValidationRecorded',
  'CompletionCertificateIssued',
  'PaymentEligibilityAssessed',
  'ReleaseRequestEvaluated',
  'PaymentInstructionSubmitted',
  'ReconciliationRecorded',
  'FinalSettlementAccountClosed',
];

describe('agentic commercial assurance flow', () => {
  it('keeps protected commercial transitions event-authoritative', () => {
    const waits = AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1.steps
      .map((step) => step.waitForEvent)
      .filter((event): event is string => Boolean(event));

    expect(waits).toEqual(expect.arrayContaining(protectedEvents));
    expect(protectedEvents.every((event) => waits.includes(event))).toBe(true);
  });

  it('uses registered handlers only for non-protected persona work', () => {
    const handled = AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1.steps.filter(
      (step) => step.handler,
    );

    expect(handled.length).toBeGreaterThan(0);
    for (const step of handled) {
      expect(step.waitForEvent).toBeUndefined();
      expect(AGENTIC_FLOW_HANDLERS[step.handler!]).toBeTypeOf('function');
    }
  });

  it('requires independent human release approval at enhanced assurance and above', () => {
    const approval = AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1.steps.find(
      (step) => step.id === 'enhanced-approval',
    );

    expect(approval).toMatchObject({
      humanTaskRole: 'RELEASE_APPROVER',
      minimumAssurance: 'ENHANCED',
    });
    expect(approval?.dependencies).toEqual(['risk-assurance']);
  });

  it('finishes with audit assurance after authoritative settlement closure', () => {
    const audit = AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1.steps.find(
      (step) => step.id === 'audit-assurance',
    );
    expect(audit).toMatchObject({
      handler: 'auditAssurance',
      dependencies: ['closure'],
    });
  });
});
