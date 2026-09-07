import type { RequestContext } from '@assurapay/shared';
import type {
  FlowDefinition,
  FlowInstance,
  StepHandler,
} from '@assurapay/flow-orchestration';
import type {
  AgentActionClass,
  AgentTaskRisk,
  AssuraPersona,
} from '@assurapay/agent-runtime/agentic-os';
import { getAgentRuntime } from './agent-runtime-app';
import { trustStore } from './trust-app';

type Membership = {
  workspaceId: string;
  userId: string;
  status: string;
  role?: string;
  membershipType?: string;
};

const assuranceRisk: Record<FlowInstance['assuranceLevel'], AgentTaskRisk> = {
  LIGHT: 'LOW',
  STANDARD: 'MEDIUM',
  ENHANCED: 'HIGH',
  HIGH_ASSURANCE: 'CRITICAL',
  INSTITUTIONAL: 'CRITICAL',
};

async function activeRoles(context: RequestContext): Promise<string[]> {
  if (!context.activeWorkspaceId) throw new Error('ACTIVE_WORKSPACE_REQUIRED');
  const memberships = await trustStore.list<Membership>('memberships');
  const roles = memberships
    .filter((membership) => membership.workspaceId === context.activeWorkspaceId)
    .filter((membership) => membership.userId === context.actorUserId)
    .filter((membership) => membership.status === 'ACTIVE')
    .flatMap((membership) => [membership.role, membership.membershipType])
    .filter((role): role is string => Boolean(role));
  return [...new Set(roles)];
}

function handlerFor(
  persona: AssuraPersona,
  actionClass: AgentActionClass,
  purpose: string,
): StepHandler {
  return async ({ context, flow, definition }) => {
    const agentic = getAgentRuntime();
    const roles = await activeRoles(context);
    if (!roles.length) throw new Error('AGENTIC_FLOW_CALLER_HAS_NO_ACTIVE_ROLE');

    const snapshot = await agentic.contexts.create(context, {
      agreementId: flow.agreementId,
      milestoneIds: [],
      definitionOfDoneIds: [],
      historyRefs: [
        `flow:${flow.id}`,
        `transaction:${flow.transactionId}`,
        `step:${definition.id}`,
      ],
      permissions: roles.map((role) => `role:${role}`),
    });

    const decision = await agentic.dispatch.dispatch(context, {
      persona,
      actionClass,
      risk: assuranceRisk[flow.assuranceLevel],
      contextSnapshotId: snapshot.id,
      model: process.env.AGENTIC_OS_MODEL ?? 'sandbox',
      roles,
      variables: {
        purpose,
        flowId: flow.id,
        flowStep: definition.id,
        assuranceLevel: flow.assuranceLevel,
      },
      transactionId: flow.transactionId,
      agreementId: flow.agreementId,
      organizationId: flow.organizationId,
    });

    if (decision.status === 'HUMAN_APPROVAL_REQUIRED') {
      throw new Error(`AGENTIC_FLOW_ESCALATION_REQUIRED:${decision.reason ?? 'UNSPECIFIED'}`);
    }
    return 'COMPLETED';
  };
}

/**
 * Governed bridge from Flow OS to Agentic OS.
 *
 * The handlers only invoke persona agents through AgenticDispatchEngine. They do
 * not issue certificates, approve releases, execute payments, or mutate any
 * protected domain aggregate. Protected truth continues to enter the flow through
 * the authoritative domain events between these agent steps.
 */
export const AGENTIC_FLOW_HANDLERS: Record<string, StepHandler> = {
  buyerAssurance: handlerFor(
    'BUYER',
    'RECOMMEND',
    'Assess buyer-side obligation, acceptance, and commercial exposure risk.',
  ),
  supplierPerformance: handlerFor(
    'SUPPLIER',
    'PREPARE',
    'Prepare the supplier for the next evidence-bound execution obligation.',
  ),
  evidenceAssurance: handlerFor(
    'EVIDENCE_CONTRIBUTOR',
    'ANALYZE',
    'Assess evidence completeness, relevance, provenance, and missing proof.',
  ),
  validationAssurance: handlerFor(
    'VALIDATOR_INSPECTOR',
    'RECOMMEND',
    'Assess whether submitted performance appears to satisfy the Definition of Done.',
  ),
  financeAssurance: handlerFor(
    'FINANCE_AP',
    'RECOMMEND',
    'Reconcile accepted commercial performance to payment readiness.',
  ),
  riskAssurance: handlerFor(
    'ASSURA_RISK_COMPLIANCE',
    'ANALYZE',
    'Assess transaction, counterparty, evidence, and settlement risk before release.',
  ),
  auditAssurance: handlerFor(
    'AUDITOR',
    'ANALYZE',
    'Build a final evidence-linked assurance and control review for the completed transaction.',
  ),
};

/**
 * Agentic extension of the canonical commercial journey.
 *
 * Every protected transition is still represented by a waitForEvent step. Persona
 * agents operate between those transitions to analyze, prepare, recommend, or
 * escalate. This makes AI native to the flow without making AI the source of truth.
 */
export const AGENTIC_COMMERCIAL_ASSURANCE_FLOW_V1: FlowDefinition = {
  id: 'AGENTIC_COMMERCIAL_ASSURANCE_FLOW',
  version: 1,
  name: 'Agentic commercial assurance',
  description: 'AI-native, non-custodial commercial assurance orchestration with governed persona agents and authoritative domain-event state transitions.',
  steps: [
    { id: 'agreement-executed', title: 'Agreement executed', waitForEvent: 'AgreementExecuted' },
    { id: 'buyer-assurance', title: 'Buyer assurance analysis', dependencies: ['agreement-executed'], handler: 'buyerAssurance' },
    { id: 'supplier-performance', title: 'Supplier performance preparation', dependencies: ['buyer-assurance'], handler: 'supplierPerformance' },
    { id: 'agreement-intelligence', title: 'Agreement intelligence published', dependencies: ['supplier-performance'], waitForEvent: 'AgreementIntelligencePublished' },
    { id: 'blueprint', title: 'Performance blueprint activated', dependencies: ['agreement-intelligence'], waitForEvent: 'PerformanceBlueprintActivated' },
    { id: 'dod', title: 'Definition of Done published', dependencies: ['blueprint'], waitForEvent: 'DefinitionOfDonePackagePublished' },
    { id: 'execution', title: 'Execution workspace activated', dependencies: ['dod'], waitForEvent: 'ExecutionWorkspaceActivated' },
    { id: 'evidence', title: 'Evidence verified', dependencies: ['execution'], waitForEvent: 'EvidencePackageVerified' },
    { id: 'evidence-assurance', title: 'Evidence assurance analysis', dependencies: ['evidence'], handler: 'evidenceAssurance' },
    { id: 'validation', title: 'Validation completed', dependencies: ['evidence-assurance'], waitForEvent: 'ValidationRecorded' },
    { id: 'validation-assurance', title: 'Validation assurance recommendation', dependencies: ['validation'], handler: 'validationAssurance' },
    { id: 'completion', title: 'Completion certificate issued', dependencies: ['validation-assurance'], waitForEvent: 'CompletionCertificateIssued' },
    { id: 'eligibility', title: 'Payment eligibility assessed', dependencies: ['completion'], waitForEvent: 'PaymentEligibilityAssessed' },
    { id: 'finance-assurance', title: 'Finance assurance recommendation', dependencies: ['eligibility'], handler: 'financeAssurance' },
    { id: 'release', title: 'Release eligibility evaluated', dependencies: ['finance-assurance'], waitForEvent: 'ReleaseRequestEvaluated' },
    { id: 'risk-assurance', title: 'Pre-release risk assurance', dependencies: ['release'], handler: 'riskAssurance' },
    { id: 'enhanced-approval', title: 'Independent release approval', dependencies: ['risk-assurance'], humanTaskRole: 'RELEASE_APPROVER', minimumAssurance: 'ENHANCED' },
    { id: 'payment', title: 'Payment instruction submitted', dependencies: ['enhanced-approval'], waitForEvent: 'PaymentInstructionSubmitted' },
    { id: 'reconciliation', title: 'Settlement reconciled', dependencies: ['payment'], waitForEvent: 'ReconciliationRecorded' },
    { id: 'closure', title: 'Final settlement closed', dependencies: ['reconciliation'], waitForEvent: 'FinalSettlementAccountClosed' },
    { id: 'audit-assurance', title: 'Continuous assurance closeout', dependencies: ['closure'], handler: 'auditAssurance' },
  ],
};
