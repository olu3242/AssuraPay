import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService } from '@assurapay/identity';
import { OrganizationService } from '@assurapay/organizations';
import { PermissionService } from '@assurapay/permissions';
import {
  DeterministicVerificationProvider,
  PartyService,
} from '@assurapay/parties';
import { LegalService } from '@assurapay/legal';
import type { RequestContext } from '@assurapay/shared';
import {
  CertificationEngine,
  DefinitionOfDoneEngine,
  ExecutionEngine,
  MilestoneEngine,
  PaymentTriggerEngine,
} from '@assurapay/governance-core';
import {
  ApprovalWorkflowEngine,
  ClauseIntelligenceEngine,
  ContractAuthoringEngine,
  DigitalExecutionEngine,
  NegotiationEngine,
  deterministicSignatureProvider,
} from '@assurapay/agreement-creation';
import {
  AgreementIntelligenceEngine,
  ContractAnalysisEngine,
  ContractRepositoryEngine,
  ContractRiskEngine,
  ContractVersionEngine,
  deterministicAnalysisGateway,
  inMemorySecureStore,
} from '@assurapay/agreement-intelligence';
import {
  DefinitionOfDonePackageEngine,
  DeliverablesEngine,
  MilestonePlanningEngine,
  PerformanceBlueprintEngine,
  ScopeDefinitionEngine,
} from '@assurapay/performance-blueprint';
import {
  AcceptanceCriteriaEngine,
  DependencyIntelligenceEngine,
  PaymentTriggerRuleEngine,
  PerformanceBaselineEngine,
  SuccessMetricsEngine,
} from '@assurapay/performance-readiness';
import {
  EvidenceManagementEngine,
  ExecutionOrchestrationEngine,
  ProgressMeasurementEngine,
  QualityAssuranceEngine,
  ValidationAcceptanceTestingEngine,
} from '@assurapay/execution-orchestration';
import {
  AcceptanceDecisionEngine,
  ChangeControlEngine,
  CompletionCertificationEngine,
  InspectionEngine,
  IssueRiskCorrectiveActionEngine,
} from '@assurapay/completion-assurance';
import {
  ConditionalReleaseOrchestrationEngine,
  EscrowFundingAssuranceEngine,
  FinancialEntitlementEngine,
  InvoiceClaimEngine,
  PaymentEligibilityEngine,
  deterministicCustodyGateway,
} from '@assurapay/settlement-assurance';
import {
  DisputeResolutionEngine,
  FinalSettlementEngine,
  FinancialApprovalAuthorityEngine,
  PaymentExecutionEngine,
  ReconciliationLedgerEngine,
  deterministicPaymentGateway,
} from '@assurapay/settlement-execution';
import {
  EnterpriseKpiEngine,
  ExecutionAssuranceIndexEngine,
  ExecutiveDashboardEngine,
  PredictiveExecutionIntelligenceEngine,
  SettlementAssuranceIndexEngine,
  deterministicForecastGateway,
} from '@assurapay/enterprise-intelligence';
import {
  AiDecisionSupportEngine,
  FinancialPaymentIntelligenceEngine,
  PortfolioAnalyticsEngine,
  RenewalRelationshipIntelligenceEngine,
  VendorCustomerPerformanceEngine,
  deterministicFinancialForecastGateway,
} from '@assurapay/enterprise-analytics';
import {
  BottleneckDetectionEngine,
  DependencyIntelligenceEngine as WorkflowDependencyIntelligenceEngine,
  EscalationIntelligenceEngine,
  ExceptionManagementEngine,
  ExecutionHealthEngine,
  PredictiveRiskIntelligenceEngine,
  ResourceIntelligenceEngine,
  ScheduleOptimizationEngine,
  SlaIntelligenceEngine,
  WorkflowIntelligenceEngine,
  deterministicRiskPredictionGateway,
} from '@assurapay/workflow-intelligence';
const globalTrust = globalThis as typeof globalThis & {
  assurapayTrustStore?: InMemoryTrustStore;
};
export const trustStore = (globalTrust.assurapayTrustStore ??=
  new InMemoryTrustStore());
export const trust = {
  identity: new IdentityService(trustStore),
  organizations: new OrganizationService(trustStore),
  permissions: new PermissionService(trustStore),
  parties: new PartyService(trustStore, [
    new DeterministicVerificationProvider(),
  ]),
  legal: new LegalService(trustStore),
};
export const governance = {
  executions: new ExecutionEngine(trustStore),
  milestones: new MilestoneEngine(trustStore),
  dod: new DefinitionOfDoneEngine(trustStore),
  certifications: new CertificationEngine(trustStore),
  paymentTriggers: new PaymentTriggerEngine(trustStore),
};
export const agreements = {
  authoring: new ContractAuthoringEngine(trustStore),
  clauses: new ClauseIntelligenceEngine(trustStore),
  negotiations: new NegotiationEngine(trustStore),
  approvals: new ApprovalWorkflowEngine(trustStore),
  execution: new DigitalExecutionEngine(
    trustStore,
    deterministicSignatureProvider,
    process.env.SIGNATURE_WEBHOOK_SECRET ?? 'development-signature-secret',
  ),
};
export const intelligence = {
  analysis: new ContractAnalysisEngine(
    trustStore,
    deterministicAnalysisGateway,
  ),
  risk: new ContractRiskEngine(trustStore),
  versions: new ContractVersionEngine(trustStore),
  repository: new ContractRepositoryEngine(trustStore, inMemorySecureStore),
  structured: new AgreementIntelligenceEngine(trustStore),
};
export const blueprint = {
  plan: new PerformanceBlueprintEngine(trustStore),
  scope: new ScopeDefinitionEngine(trustStore),
  deliverables: new DeliverablesEngine(trustStore),
  milestones: new MilestonePlanningEngine(trustStore),
  dod: new DefinitionOfDonePackageEngine(trustStore),
};
export const readiness = {
  acceptanceCriteria: new AcceptanceCriteriaEngine(trustStore),
  successMetrics: new SuccessMetricsEngine(trustStore),
  dependencies: new DependencyIntelligenceEngine(trustStore),
  paymentTriggers: new PaymentTriggerRuleEngine(trustStore),
  baselines: new PerformanceBaselineEngine(trustStore),
};
export const orchestration = {
  workspaces: new ExecutionOrchestrationEngine(trustStore),
  progress: new ProgressMeasurementEngine(trustStore),
  evidence: new EvidenceManagementEngine(trustStore),
  validation: new ValidationAcceptanceTestingEngine(trustStore),
  quality: new QualityAssuranceEngine(trustStore),
};
export const completion = {
  inspections: new InspectionEngine(trustStore),
  issues: new IssueRiskCorrectiveActionEngine(trustStore),
  changes: new ChangeControlEngine(trustStore),
  acceptance: new AcceptanceDecisionEngine(trustStore),
  certification: new CompletionCertificationEngine(trustStore),
};
export const settlement = {
  eligibility: new PaymentEligibilityEngine(trustStore),
  entitlement: new FinancialEntitlementEngine(trustStore),
  invoices: new InvoiceClaimEngine(trustStore),
  funding: new EscrowFundingAssuranceEngine(
    trustStore,
    deterministicCustodyGateway,
  ),
  release: new ConditionalReleaseOrchestrationEngine(trustStore),
};
export const treasury = {
  approvals: new FinancialApprovalAuthorityEngine(trustStore),
  payments: new PaymentExecutionEngine(trustStore, deterministicPaymentGateway),
  ledger: new ReconciliationLedgerEngine(trustStore),
  disputes: new DisputeResolutionEngine(trustStore),
  closure: new FinalSettlementEngine(trustStore),
};
export const enterprise = {
  executionIndex: new ExecutionAssuranceIndexEngine(trustStore),
  settlementIndex: new SettlementAssuranceIndexEngine(trustStore),
  kpis: new EnterpriseKpiEngine(trustStore),
  dashboards: new ExecutiveDashboardEngine(trustStore),
  forecasts: new PredictiveExecutionIntelligenceEngine(
    trustStore,
    deterministicForecastGateway,
  ),
};
export const analytics = {
  financialForecasts: new FinancialPaymentIntelligenceEngine(
    trustStore,
    deterministicFinancialForecastGateway,
  ),
  performance: new VendorCustomerPerformanceEngine(trustStore),
  portfolio: new PortfolioAnalyticsEngine(trustStore),
  renewal: new RenewalRelationshipIntelligenceEngine(trustStore),
  aiDecisionSupport: new AiDecisionSupportEngine(trustStore),
};
export const workflowIntelligence = {
  workflow: new WorkflowIntelligenceEngine(trustStore),
  dependencies: new WorkflowDependencyIntelligenceEngine(),
  bottlenecks: new BottleneckDetectionEngine(),
  sla: new SlaIntelligenceEngine(),
  exceptions: new ExceptionManagementEngine(trustStore),
  escalations: new EscalationIntelligenceEngine(),
  risks: new PredictiveRiskIntelligenceEngine(
    deterministicRiskPredictionGateway,
  ),
  schedules: new ScheduleOptimizationEngine(),
  resources: new ResourceIntelligenceEngine(),
  health: new ExecutionHealthEngine(trustStore),
};
export function requestContext(request: Request): RequestContext {
  const actorUserId = request.headers.get('x-assurapay-user-id');
  const sessionId = request.headers.get('x-assurapay-session-id');
  const activeWorkspaceId =
    request.headers.get('x-assurapay-workspace-id') ?? undefined;
  const tenantId = request.headers.get('x-assurapay-tenant-id') ?? undefined;
  if (!actorUserId || !sessionId) throw new Error('UNAUTHENTICATED');
  return {
    actorUserId,
    sessionId,
    activeWorkspaceId,
    tenantId,
    identityAssuranceLevel:
      (request.headers.get(
        'x-assurapay-assurance',
      ) as RequestContext['identityAssuranceLevel']) ?? 'IAL1_BASIC',
    memberships: (request.headers.get('x-assurapay-memberships') ?? '')
      .split(',')
      .filter(Boolean),
    correlationId:
      request.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  };
}
export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  const status = message.includes('UNAUTHENTICATED')
    ? 401
    : message.includes('DENIED') || message.includes('REQUIRED')
      ? 403
      : 400;
  return Response.json({ error: message }, { status });
}
