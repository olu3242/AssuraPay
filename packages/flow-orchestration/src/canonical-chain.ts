import type { FlowDefinition } from './index';

/**
 * Canonical AssuraPay commercial execution journey V1.
 *
 * V1 is immutable because persisted flow instances bind to a definition version. It
 * intentionally contains no currency-route step so in-flight V1 instances remain
 * resolvable after multi-currency support is introduced.
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

/**
 * V2 adds governed settlement-currency routing before payment submission. The flow
 * still observes authoritative domain events; it does not execute FX or move funds.
 */
export const COMMERCIAL_COMMITMENT_FLOW_V2: FlowDefinition = {
  ...COMMERCIAL_COMMITMENT_FLOW_V1,
  version: 2,
  description: 'Coordinates agreement-to-settlement execution with governed settlement-currency routing while remaining non-custodial.',
  steps: [
    ...COMMERCIAL_COMMITMENT_FLOW_V1.steps.slice(0, 11),
    {
      id: 'currency-route',
      title: 'Settlement currency route authorized',
      dependencies: ['enhanced-approval'],
      waitForEvent: 'SettlementCurrencyRouteAuthorized',
    },
    { id: 'payment', title: 'Payment instruction submitted', dependencies: ['currency-route'], waitForEvent: 'PaymentInstructionSubmitted' },
    { id: 'reconciliation', title: 'Settlement reconciled', dependencies: ['payment'], waitForEvent: 'ReconciliationRecorded' },
    { id: 'closure', title: 'Final settlement closed', dependencies: ['reconciliation'], waitForEvent: 'FinalSettlementAccountClosed' },
  ],
};

export const CANONICAL_DOMAIN_EVENTS = new Set(
  [COMMERCIAL_COMMITMENT_FLOW_V1, COMMERCIAL_COMMITMENT_FLOW_V2].flatMap((definition) =>
    definition.steps.flatMap((step) => (step.waitForEvent ? [step.waitForEvent] : [])),
  ),
);
