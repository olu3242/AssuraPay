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
  BlueprintDefinitionOfDoneEngine,
  DeliverablesEngine,
  MilestonePlanningEngine,
  PerformanceBlueprintEngine,
  ScopeDefinitionEngine,
} from '@assurapay/performance-blueprint';
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
export const planning = {
  blueprints: new PerformanceBlueprintEngine(trustStore),
  scope: new ScopeDefinitionEngine(trustStore),
  deliverables: new DeliverablesEngine(trustStore),
  milestones: new MilestonePlanningEngine(trustStore),
  dod: new BlueprintDefinitionOfDoneEngine(trustStore),
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
