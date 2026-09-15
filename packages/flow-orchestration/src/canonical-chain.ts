import type { FlowDefinition } from './index';

/** Canonical AssuraPay agreement -> assurance -> externally-custodied settlement journey. */
export const COMMERCIAL_COMMITMENT_FLOW_V1: FlowDefinition = {
  id: 'COMMERCIAL_COMMITMENT_FLOW',
  version: 1,
  name: 'Commercial commitment',
  description: 'Coordinates agreement, escrow assurance, performance evidence and settlement without AssuraPay taking custody or becoming a second source of truth.',
  steps: [
    { id: 'agreement-executed', title: 'Agreement executed', waitForEvent: 'AgreementExecuted' },
    { id: 'agreement-intelligence', title: 'Agreement intelligence published', dependencies: ['agreement-executed'], waitForEvent: 'AgreementIntelligencePublished' },
    { id: 'blueprint', title: 'Performance blueprint activated', dependencies: ['agreement-intelligence'], waitForEvent: 'PerformanceBlueprintActivated' },
    { id: 'dod', title: 'Definition of Done published', dependencies: ['blueprint'], waitForEvent: 'DefinitionOfDonePackagePublished' },
    { id: 'escrow-instruction', title: 'Agreement payment terms compiled', dependencies: ['dod'], waitForEvent: 'EscrowInstructionCompiled' },
    { id: 'funding', title: 'External escrow funding confirmed', dependencies: ['escrow-instruction'], waitForEvent: 'FundingCommitmentConfirmed' },
    { id: 'execution', title: 'Execution workspace activated', dependencies: ['funding'], waitForEvent: 'ExecutionWorkspaceActivated' },
    { id: 'evidence', title: 'Evidence verified', dependencies: ['execution'], waitForEvent: 'EvidencePackageVerified' },
    { id: 'validation', title: 'Validation completed', dependencies: ['evidence'], waitForEvent: 'ValidationRecorded' },
    { id: 'completion', title: 'Completion certificate issued', dependencies: ['validation'], waitForEvent: 'CompletionCertificateIssued' },
    { id: 'eligibility', title: 'Payment eligibility assessed', dependencies: ['completion'], waitForEvent: 'PaymentEligibilityAssessed' },
    { id: 'payment-readiness', title: 'Payment readiness assessed', dependencies: ['eligibility'], waitForEvent: 'PaymentReadinessAssessed' },
    { id: 'release', title: 'Release conditions evaluated', dependencies: ['payment-readiness'], waitForEvent: 'ReleaseRequestEvaluated' },
    { id: 'enhanced-approval', title: 'Independent release approval', dependencies: ['release'], humanTaskRole: 'RELEASE_APPROVER', minimumAssurance: 'ENHANCED' },
    { id: 'payment', title: 'Payment instruction submitted', dependencies: ['enhanced-approval'], waitForEvent: 'PaymentInstructionSubmitted' },
    { id: 'reconciliation', title: 'Settlement reconciled', dependencies: ['payment'], waitForEvent: 'ReconciliationRecorded' },
    { id: 'closure', title: 'Final settlement closed', dependencies: ['reconciliation'], waitForEvent: 'FinalSettlementAccountClosed' },
  ],
};

export const CANONICAL_DOMAIN_EVENTS = new Set(
  COMMERCIAL_COMMITMENT_FLOW_V1.steps.flatMap((step) => step.waitForEvent ? [step.waitForEvent] : []),
);
