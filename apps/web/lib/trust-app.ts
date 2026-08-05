import { InMemoryTrustStore } from '@assurapay/database';
import {
  IdentityAssertionService,
  IdentityGateway,
  IdentityService,
  InMemoryAssertionReplayStore,
  loadAssertionKeyring,
  loadGatewayConfig,
} from '@assurapay/identity';
import { OrganizationService } from '@assurapay/organizations';
import {
  PermissionService,
  TrustStoreMembershipReader,
  bootstrapWorkspaceGrants,
  enforcePermission,
  grantRole,
  loadCatalogueConfig,
  resolveMemberships,
  type BootstrapInput,
  type CatalogueConfig,
  type GrantRoleInput,
  type PermissionGrant,
  type PermissionRequirement,
  type WorkspaceBootstrap,
} from '@assurapay/permissions';
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
import { RouteAccessError, requirementForRoute } from './route-permissions';

const globalTrust = globalThis as typeof globalThis & {
  assurapayTrustStore?: InMemoryTrustStore;
  assurapayAssertionReplayStore?: InMemoryAssertionReplayStore;
};
export const trustStore = (globalTrust.assurapayTrustStore ??=
  new InMemoryTrustStore());

/**
 * Replay guard state must survive a dev-server reload, or a reload would forget
 * every consumed nonce and re-admit replays.
 */
const assertionReplayStore = (globalTrust.assurapayAssertionReplayStore ??=
  new InMemoryAssertionReplayStore());

let identityAssertions: IdentityAssertionService | undefined;

/**
 * Assertion signing requires configured keys, so the service is built on first
 * use rather than at import. An unconfigured environment still boots and fails
 * closed with ASSERTION_KEYRING_REQUIRED on the paths that need an assertion,
 * instead of breaking the whole application at load.
 */
export function getIdentityAssertions(): IdentityAssertionService {
  identityAssertions ??= new IdentityAssertionService(
    trustStore,
    loadAssertionKeyring(process.env),
    assertionReplayStore,
  );
  return identityAssertions;
}

let identityGateway: IdentityGateway | undefined;

/**
 * The governed identity boundary. Built on first use so an unconfigured
 * environment still boots and fails closed on the request paths that need
 * identity, rather than breaking the whole application at import.
 *
 * Construction refuses a process-local replay store when the configuration
 * requires distributed protection, so production cannot silently run on
 * single-process replay semantics.
 */
export function getIdentityGateway(): IdentityGateway {
  identityGateway ??= new IdentityGateway(
    trustStore,
    loadAssertionKeyring(process.env),
    assertionReplayStore,
    loadGatewayConfig(process.env),
  );
  return identityGateway;
}
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
/**
 * Authoritative membership reader. Enforcement resolves membership from the record
 * engine 02 owns; nothing infers it from a header or a signature.
 */
const membershipReader = new TrustStoreMembershipReader(trustStore);

function correlationOf(request: Request): string {
  return request.headers.get('x-correlation-id') ?? crypto.randomUUID();
}

/**
 * Verified identity context for a request.
 *
 * Identity comes from a signed assertion, never from request headers. The previous
 * implementation read `x-assurapay-user-id`, `x-assurapay-session-id`,
 * `x-assurapay-tenant-id`, `x-assurapay-assurance` and `x-assurapay-memberships`
 * directly, so any caller could claim any identity, tenant, assurance level and
 * membership set. That was a complete authentication and authorization bypass on
 * every route that used it.
 *
 * This verifies without consuming, so it is safe on every request and leaves the
 * assertion's single use available to an acting path. `memberships` is always
 * empty: authentication cannot prove membership, so workspace-scoped paths must
 * have it resolved by the membership authority.
 */
export function requestContext(request: Request): RequestContext {
  const correlationId = correlationOf(request);
  const identity = getIdentityGateway().authenticate(request, correlationId);
  // The gateway proves identity and refuses to resolve membership. Enforcement
  // resolves it from the authoritative record, so workspace-scoped engines see
  // proven membership rather than a claim.
  return resolveMemberships(identity, membershipReader);
}

/**
 * Verified identity context for a path that acts, consuming the assertion so it
 * cannot authorise a second action.
 */
export function actingRequestContext(request: Request): RequestContext {
  const correlationId = correlationOf(request);
  const identity = getIdentityGateway().consumeRequestContext(request, correlationId);
  return resolveMemberships(identity, membershipReader);
}

/**
 * Authorized context derived from the route policy table.
 *
 * The route's own path and method select the requirement, so a route does not
 * restate its permission key and the two cannot drift apart. Unmapped routes
 * throw: deny by default.
 *
 * A `public` classification is a programming error here — a public route must not
 * ask for an authorized context — so it is refused rather than silently allowed.
 */
export function authorizedContextForRoute(request: Request): RequestContext {
  const access = requirementForRoute(new URL(request.url).pathname, request.method);
  const correlationId = correlationOf(request);

  if (access.access === 'public') {
    throw new RouteAccessError(
      'ROUTE_NOT_MAPPED',
      'a public route must not request an authorized context',
    );
  }

  const identity = getIdentityGateway().authenticate(request, correlationId);

  // An identity-class route is authenticated and membership-scoped, but carries no
  // permission requirement; see route-permissions.ts for why that is not a gap.
  if (access.access === 'identity') {
    return resolveMemberships(identity, membershipReader);
  }

  return enforcePermission(identity, access, {
    memberships: membershipReader,
    permissions: trust.permissions,
    store: trustStore,
  });
}

/**
 * Authorized context for a route that names the permission it requires.
 *
 * Enforcement is applied here, at the composition root, never inside an engine:
 * an engine receives an already-authorized context and does not decide whether the
 * caller may act. Deny by default — absent an applicable grant, this throws.
 */
export function authorizedContext(
  request: Request,
  requirement: PermissionRequirement,
): RequestContext {
  const correlationId = correlationOf(request);
  const identity = getIdentityGateway().authenticate(request, correlationId);
  return enforcePermission(identity, requirement, {
    memberships: membershipReader,
    permissions: trust.permissions,
    store: trustStore,
  });
}

let catalogueConfig: CatalogueConfig | undefined;

/**
 * Catalogue configuration for this deployment.
 *
 * Read once and cached, so an invalid value fails the first path that needs it
 * rather than differing between requests.
 */
export function getCatalogueConfig(): CatalogueConfig {
  catalogueConfig ??= loadCatalogueConfig(process.env);
  return catalogueConfig;
}

/**
 * Grants the founding administrator for a newly created workspace.
 *
 * This is the one path in the application that produces a grant without an
 * authorized caller, and it is why the rest of the authorization surface can exist
 * at all: deny-by-default over an empty grant table denies everyone, including the
 * person who would issue the first grant.
 *
 * It is not an escape hatch. The workspace owner membership must already exist, the
 * workspace must hold no grant yet, the role must be the bootstrappable one, and
 * configuration must permit it. Every refusal carries a `CATALOGUE_*` code.
 */
export function bootstrapFoundingAdministrator(
  input: BootstrapInput,
): WorkspaceBootstrap {
  return bootstrapWorkspaceGrants(trustStore, input, getCatalogueConfig());
}

/**
 * Assigns a catalogue role on the authorized path.
 *
 * The caller's own authority is established by `authorizedContextForRoute` before
 * this is reached; what this adds is the segregation-of-duties check on the
 * resulting permission set, which a single request cannot see.
 */
export function assignRole(
  context: RequestContext,
  input: GrantRoleInput,
): PermissionGrant[] {
  return grantRole(trust.permissions, trustStore, context, input);
}

/**
 * Catalogue refusals that describe the state of the workspace rather than the
 * caller's authority, so they answer 409 instead of 403. Repeating a founding call
 * or granting a conflicting role is a conflict with what already exists; retrying
 * with better credentials would not help.
 */
const CONFLICT_CODES = new Set([
  'CATALOGUE_ALREADY_BOOTSTRAPPED',
  'CATALOGUE_SEGREGATION_CONFLICT',
]);

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  // Assertion and gateway failures are authentication failures, not bad requests.
  const status =
    message.includes('UNAUTHENTICATED') ||
    message.startsWith('ASSERTION_') ||
    message.startsWith('GATEWAY_')
      ? 401
      : CONFLICT_CODES.has(message)
        ? 409
        : message.startsWith('ENFORCEMENT_') || message.startsWith('PERMISSION_DENIED')
          ? 403
          : message.startsWith('CATALOGUE_BOOTSTRAP_DISABLED') ||
              message.startsWith('CATALOGUE_ROLE_NOT_BOOTSTRAPPABLE')
            ? 403
            : message.includes('DENIED') || message.includes('REQUIRED')
              ? 403
              : 400;
  return Response.json({ error: message }, { status });
}
