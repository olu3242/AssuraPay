import {
  IdentityAssertionService,
  IdentityGateway,
  IdentityService,
  InMemoryAssertionReplayStore,
  type AssertionReplayStore,
  issueAssertionForSession,
  type IssueAssertionInput,
  type IssuedAssertion,
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
import { requireActiveWorkspace, type RequestContext } from '@assurapay/shared';
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
  ContractRepositoryEngine,
  ContractRiskEngine,
  ContractVersionEngine,
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
import { AuditLedgerEngine } from '@assurapay/audit-ledger';
import { ProgressiveTrustEngine } from '@assurapay/progressive-trust';
import { RouteAccessError, requirementForRoute } from './route-permissions';
import { enterMutableTrustScope } from '@assurapay/database';
import { requireReadyPersistence, trustStore } from './persistence';

const globalTrust = globalThis as typeof globalThis & {
  assurapayAssertionReplayStore?: InMemoryAssertionReplayStore;
};

/**
 * The repository, from the canonical runtime.
 *
 * This module used to construct an `InMemoryTrustStore` here and cache it on
 * `globalThis` — a production composition root choosing volatile storage
 * unconditionally. `persistence.ts` now owns that decision, reading it from validated
 * server-only configuration that refuses an in-memory adapter in any durable deployment.
 */
export { trustStore } from './persistence';
import { getPersistenceRuntime } from './persistence';
import { DurableAssertionReplayStore } from './assertion-replay';

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

let identityGateway: Promise<IdentityGateway> | undefined;

/**
 * The replay store this deployment actually has, chosen by its persistence adapter.
 *
 * Not a fallback, and the distinction matters. `loadPersistenceConfig` refuses an in-memory adapter
 * for every durable deployment class, so a runtime without SQL *is* a non-durable deployment — a
 * test or a developer's machine — where one process is the whole system and `process-local` is the
 * accurate guarantee rather than a downgrade of a better one. A runtime with SQL gets the shared
 * table, and its guarantee is `distributed` because it genuinely is.
 *
 * Deciding here rather than declaring a guarantee up front is the reason this function, and the
 * gateway built from it, are asynchronous. The adapter is known only once the runtime resolves, and
 * `ReplayProtectionGuarantee` exists so "a deployment cannot accidentally present process-local
 * protection as distributed" — which a store that claimed `distributed` before knowing whether it
 * had a database would do.
 */
async function replayStoreForDeployment(): Promise<AssertionReplayStore> {
  const runtime = await getPersistenceRuntime();
  return runtime.sql ? new DurableAssertionReplayStore(runtime.sql) : assertionReplayStore;
}

/**
 * The governed identity boundary. Built on first use so an unconfigured
 * environment still boots and fails closed on the request paths that need
 * identity, rather than breaking the whole application at import.
 *
 * Construction refuses a process-local replay store when the configuration
 * requires distributed protection, so production cannot silently run on
 * single-process replay semantics — and since `replayStoreForDeployment` now supplies a distributed
 * store wherever there is a database, that guard stops being a rule every production deployment had
 * to opt out of.
 */
export function getIdentityGateway(): Promise<IdentityGateway> {
  // The promise is cached, not the instance, so two concurrent first requests await one
  // construction — the same reason `getPersistenceRuntime` caches a promise. A rejection is
  // cleared rather than cached: an unconfigured keyring must fail closed on every attempt, not
  // poison the process against a later fix.
  identityGateway ??= (async () =>
    new IdentityGateway(
      trustStore,
      loadAssertionKeyring(process.env),
      await replayStoreForDeployment(),
      loadGatewayConfig(process.env),
    ))().catch((error: unknown) => {
    identityGateway = undefined;
    throw error;
  });
  return identityGateway;
}
export const trust = {
  identity: new IdentityService(trustStore),
  // Engine 06. The «policy evaluates» link of the governing rule: an advisory recommendation is
  // bounded against a deterministic level computed from governed facts, and can only ever raise
  // scrutiny. Composed here rather than beside the agent runtime deliberately — Progressive Trust
  // must work identically whether an agent ran, was disregarded, or was never configured, which is
  // every deployment of this repository today.
  progressiveTrust: new ProgressiveTrustEngine(trustStore),
  // Engine 08. It reads the chain the store writes and never rewrites it, so it is
  // safe to share one instance across every request.
  auditLedger: new AuditLedgerEngine(trustStore),
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
  // `analysis` is composed in `agent-runtime-app.ts`, not here, and the move is the point of the
  // gateway convergence rather than tidying. Contract analysis now runs through the single shared
  // `AiGatewayEngine`, and that engine holds the per-tenant rate-limit window in memory — so it has
  // to be one instance, which means the analysis engine has to be composed where the runtime is.
  // Composing it here instead would need this module to import the runtime, which imports
  // `trustStore` from this module: a cycle. See `getGovernedContractAnalysis`.
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
export async function requestContext(request: Request): Promise<RequestContext> {
  const correlationId = correlationOf(request);
  const identity = await (await getIdentityGateway()).authenticate(request, correlationId);
  // The gateway proves identity and refuses to resolve membership. Enforcement
  // resolves it from the authoritative record, so workspace-scoped engines see
  // proven membership rather than a claim.
  return resolveMemberships(identity, membershipReader);
}

/**
 * Verified identity context for a path that acts, consuming the assertion so it
 * cannot authorise a second action.
 *
 * Kept for a caller outside the route policy table. Every mapped route reaches
 * consumption through `authorizedContextForRoute`, which decides by method.
 */
export async function actingRequestContext(request: Request): Promise<RequestContext> {
  const correlationId = correlationOf(request);
  const identity = await (await getIdentityGateway()).consumeRequestContext(request, correlationId);
  return resolveMemberships(identity, membershipReader);
}

/**
 * Methods that only read. Everything else acts, and acting consumes the assertion.
 *
 * Derived from the request rather than declared per route, deliberately. The gateway has always
 * had two entry points — `authenticate`, which verifies and leaves the nonce, and
 * `consumeRequestContext`, which burns it — and `consumeIdentityAssertion`'s own unit tests prove
 * the refusal works. Nothing called it. `actingRequestContext` was exported with no callers, so
 * every one of the 177 mapped routes authenticated through the verify-without-consume path and
 * `ASSERTION_REPLAYED` was unreachable over HTTP: an assertion could authorise an unlimited number
 * of actions inside its validity window.
 *
 * A per-route `consumes` flag would have been the other option and is worse. It is 177 entries to
 * annotate, it defaults to unsafe when a new route forgets, and the thing it would express is
 * already carried by the method. This way a route cannot opt out of replay protection by omission,
 * and a new acting route gets it without anyone remembering to ask.
 *
 * The consequence is deliberate and is the point: one assertion authorises one action, so a client
 * performing two writes mints two assertions. The application's own clients already do — both
 * `bootstrap-console.tsx` and `approval-inbox.tsx` fetch a fresh assertion at every call site.
 *
 * A read-only POST, were there one, would consume an assertion it did not need to. That is
 * wasteful and safe; the reverse — an acting route that forgets to consume — is the hole this
 * closes. So the default is to consume, and no exception list exists until a route needs one.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function methodActs(method: string): boolean {
  return !READ_ONLY_METHODS.has(method.toUpperCase());
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
export async function authorizedContextForRoute(request: Request): Promise<RequestContext> {
  // Bound here, in the synchronous prologue, before this function's first `await` — and filled in
  // below once authentication has said who the caller is.
  //
  // The order is the whole point. `enterWith` binds the *current* execution context, and an async
  // function resumes after an `await` in a context the caller does not reliably share. Entering the
  // scope after authentication therefore bound it for the funnel and nobody else: the funnel's own
  // `resolveMemberships` read was scoped, and every read the route performed afterwards ran with no
  // scope at all. Under forced RLS those reads returned nothing, so `GET /v1/me/workspaces` answered
  // `[]` to a caller holding an ACTIVE membership. `enterMutableTrustScope` explains the measurement.
  const scope = enterMutableTrustScope();
  const access = requirementForRoute(new URL(request.url).pathname, request.method);
  const correlationId = correlationOf(request);

  if (access.access === 'public') {
    throw new RouteAccessError(
      'ROUTE_NOT_MAPPED',
      'a public route must not request an authorized context',
    );
  }

  // Before authentication, because an unready store cannot record the authentication
  // attempt either. Both gates are required: an authorized caller whose write cannot be
  // audited must be refused, not served.
  await requireReadyPersistence();

  const identity = await (await getIdentityGateway()).authenticate(request, correlationId);

  // The tenancy scope Row Level Security reads, established here because this is the one
  // place every protected route passes through. Without it, forced RLS denies every read —
  // which is the correct default and would also be a broken application.
  //
  // Set from the verified identity, never from a request field. A tenant taken from a header
  // or a body would let a caller name the scope its own reads are checked against, which is
  // the whole boundary handed to the caller.
  // Assigned into the already-bound object rather than binding a new one, so the route sees it.
  scope.tenantId = identity.tenantId;
  scope.workspaceId = identity.activeWorkspaceId;
  scope.actorId = identity.actorUserId;

  // Burn the nonce, for a method that acts. See `methodActs` for why the method decides.
  //
  // ## Why this is here and not above
  //
  // The order is load-bearing, and the obvious arrangement is broken. `consume` writes an
  // `IdentityAssertionConsumed` audit record carrying the assertion's own `tenantId`, and
  // `trust_audit_records` admits an insert only when `tenant_id IS NULL` — an untenanted platform
  // event — or when it equals `trust_current_tenant()`. Consuming before the scope above is bound
  // gives a record that is neither: it names the caller's tenant while the session has no scope
  // set, so forced row-level security refuses it and the whole request fails.
  //
  // Found by clicking, not by reading. Consuming first took the browser suite from 21 passing to 13
  // failing, and the bootstrap journey reported "Tenant founding succeeded, but administration could
  // not be founded: new row violates row-level security policy for table trust_audit_records" —
  // which is the audit boundary working exactly as designed, on a write that had no business being
  // unscoped. Authenticating first costs one extra signature verification and nothing else.
  //
  // Still before the route runs, and before enforcement below, so a replayed assertion is refused
  // without the handler being reached. The authorization work done after this point is wasted on a
  // replay, which is the right trade: the alternative is enforcing first and burning the nonce only
  // once a request is known to be allowed, which would let an attacker probe permissions with one
  // assertion indefinitely.
  if (methodActs(request.method)) {
    await (await getIdentityGateway()).consumeRequestContext(request, correlationId);
  }

  // An identity-class route is authenticated and membership-scoped, but carries no
  // permission requirement; see route-permissions.ts for why that is not a gap.
  if (access.access === 'identity') {
    return resolveMemberships(identity, membershipReader);
  }

  return await enforcePermission(identity, access, {
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
export async function authorizedContext(
  request: Request,
  requirement: PermissionRequirement,
): Promise<RequestContext> {
  const correlationId = correlationOf(request);
  const identity = await (await getIdentityGateway()).authenticate(request, correlationId);
  return await enforcePermission(identity, requirement, {
    memberships: membershipReader,
    permissions: trust.permissions,
    store: trustStore,
  });
}

/**
 * A context proven to carry workspace scope.
 *
 * `RequestContext` types `activeWorkspaceId` and `tenantId` as optional because an
 * identity-class context legitimately has neither. Enforcement guarantees both for
 * a permission-class route, but the type cannot express that, so a route needing to
 * scope a write says so and gets a stable failure instead of a cast.
 */
export type WorkspaceScopedContext = RequestContext & {
  activeWorkspaceId: string;
  tenantId: string;
};

export function workspaceScoped(context: RequestContext): WorkspaceScopedContext {
  requireActiveWorkspace(context);
  return context;
}

/**
 * Mints an identity assertion for the holder of a valid session cookie.
 *
 * This is the bridge that makes the authorized API reachable. Sign-in produces a
 * session cookie; every authorized route authenticates a signed assertion; nothing
 * joined the two, so a real client could reach nothing.
 *
 * Deliberately not exposed through the gateway's `exchange`, which stays
 * unsupported: exchange transfers privilege between assertions under attenuation
 * rules that are not defined, whereas this starts from a session the identity
 * engine owns and can revoke, and mints something strictly weaker.
 */
export async function issueSessionAssertion(input: IssueAssertionInput): Promise<IssuedAssertion> {
  // Bound in the prologue, before the first `await`, for the reason `enterMutableTrustScope`
  // documents — and needed here even though this route is `public`.
  //
  // Issuance reads two things beyond the session: the requested workspace, and the caller's
  // membership of it. `POST /v1/auth/assertion` carries no assertion by construction, so it never
  // passes through `authorizedContextForRoute` and had no trust scope at all — those reads ran
  // unscoped and returned nothing, so selecting a workspace the caller genuinely owned failed with
  // `ISSUANCE_WORKSPACE_UNKNOWN`. The browser hit it at the last step of the bootstrap journey:
  // "Context activation failed: assertion could not be minted: ISSUANCE_WORKSPACE_UNKNOWN".
  const scope = enterMutableTrustScope();

  // The session is resolved here purely to learn who is asking, so the reads below have an actor to
  // be scoped by. `issueAssertionForSession` resolves it again and that duplication is deliberate:
  // the alternative is threading a persistence scope through Engine 01's issuance signature, which
  // would couple the identity engine to the store's scoping mechanism. Both resolutions read the
  // identity plane, which `202608110020` makes readable without a tenant, and neither can succeed on
  // a revoked or expired session — so this cannot widen what issuance would have accepted.
  const session = await trust.identity.resolveSession(input.rawSessionToken);
  scope.actorId = session.userId;

  // The tenant, when a workspace is in play — because issuance *audits* what it mints, and an audit
  // record carries the tenant of the workspace it concerns. `trust_audit_tenant_scope` requires a
  // tenanted row to match the caller's scope, so with an actor-only scope the audit write was refused:
  // "assertion could not be minted: PERSISTENCE_SCOPE_INVALID: 42501: new row violates row-level
  // security policy for table \"trust_audit_records\"".
  //
  // The tenant is *derived from a read that is itself the membership proof*, never from the request.
  // `trust_workspaces_tenant_scope` reveals a workspace to an actor-only caller only when that actor
  // holds an ACTIVE membership in it, so a workspace this read returns is one the caller belongs to —
  // and a workspace it does not return leaves the scope untenanted, after which issuance refuses with
  // `ISSUANCE_WORKSPACE_UNKNOWN` exactly as it did before. Naming someone else's workspace therefore
  // grants nothing: the read comes back empty and no tenant is entered.
  const requestedWorkspaceId = input.workspaceId?.trim() || session.workspaceId?.trim();
  if (requestedWorkspaceId) {
    const workspaces = await trustStore.list<{ id: string; tenantId?: string; status?: string }>(
      'trustWorkspaces',
    );
    const workspace = workspaces.find(
      (entry) => entry.id === requestedWorkspaceId && entry.status === 'ACTIVE',
    );
    if (workspace?.tenantId) scope.tenantId = workspace.tenantId;
  }

  return await issueAssertionForSession(
    await getIdentityGateway(),
    trust.identity,
    trustStore,
    input,
  );
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
export async function bootstrapFoundingAdministrator(
  input: BootstrapInput,
): Promise<WorkspaceBootstrap> {
  return await bootstrapWorkspaceGrants(trustStore, input, getCatalogueConfig());
}

/**
 * Assigns a catalogue role on the authorized path.
 *
 * The caller's own authority is established by `authorizedContextForRoute` before
 * this is reached; what this adds is the segregation-of-duties check on the
 * resulting permission set, which a single request cannot see.
 */
export async function assignRole(
  context: RequestContext,
  input: GrantRoleInput,
): Promise<PermissionGrant[]> {
  return await grantRole(trust.permissions, trustStore, context, input);
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
