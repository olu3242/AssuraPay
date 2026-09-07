import type { FlowDefinition } from './index';

/**
 * Canonical AssuraPay commercial execution journey.
 *
 * Protected domain state remains owned by the existing engines. The flow waits for
 * the domain events those engines emit and advances only after the authoritative
 * transition has happened. This prevents Flow OS from becoming a second source of
 * truth for certification, release, payment or settlement state.
 */
export const COMMERCIAL_COMMITMENT_FLOW_V1: FlowDefinition = {
  id: 'COMMERCIAL_COMMITMENT_FLOW',
  version: 1,
  name: 'Commercial commitment',
  description: 'Coordinates AssuraPay canonical agreement-to-settlement execution without taking custody or mutating protected domain state.',
  steps: [
    { id: 'agreement-executed', title: 'Agreement executed', waitForEvent: 'AgreementExecuted' },
    { id: 'agreement-intelligence', title: 'Agreement intelligence published', dependencies: ['agreement-executed'], waitForEvent: 'AgreementIntelligencePublished' },
    { id: 'blueprint', title: 'Performance blueprint activated', dependencies: ['agreement-intelligence'], waitForEvent: 'PerformanceBlueprintActivated' },
    { id: 'dod', title: 'Definition of Done published', dependencies: ['blueprint'], waitForEvent: 'DefinitionOfDonePackagePublished' },
    { id: 'execution', title: 'Execution workspace activated', dependencies: ['dod'], waitForEvent: 'ExecutionWorkspaceActivated' },
    { id: 'evidence', title: 'Evidence verified', dependencies: ['execution'], waitForEvent: 'EvidencePackageVerified' },
    { id: 'validation', title: 'Validation completed', dependencies: ['evidence'], waitForEvent: 'ValidationRecorded' },
    { id: 'completion', title: 'Completion certificate issued', dependencies: ['validation'], waitForEvent: 'CompletionCertificateIssued' },
    { id: 'eligibility', title: 'Payment eligibility assessed', dependencies: ['completion'], waitForEvent: 'PaymentEligibilityAssessed' },
    { id: 'release', title: 'Release eligibility evaluated', dependencies: ['eligibility'], waitForEvent: 'ReleaseRequestEvaluated' },
    { id: 'enhanced-approval', title: 'Independent release approval', dependencies: ['release'], humanTaskRole: 'RELEASE_APPROVER', minimumAssurance: 'ENHANCED' },
    { id: 'payment', title: 'Payment instruction submitted', dependencies: ['enhanced-approval'], waitForEvent: 'PaymentInstructionSubmitted' },
    { id: 'reconciliation', title: 'Settlement reconciled', dependencies: ['payment'], waitForEvent: 'ReconciliationRecorded' },
    { id: 'closure', title: 'Final settlement closed', dependencies: ['reconciliation'], waitForEvent: 'FinalSettlementAccountClosed' },
  ],
};

export const CANONICAL_DOMAIN_EVENTS = new Set(
  COMMERCIAL_COMMITMENT_FLOW_V1.steps.flatMap((step) => step.waitForEvent ? [step.waitForEvent] : []),
);
