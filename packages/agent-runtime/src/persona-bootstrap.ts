import type { RequestContext } from '@assurapay/shared';
import {
  ASSURA_PERSONAS,
  DEFAULT_PERSONA_AGENT_MISSIONS,
  type AgentActionClass,
  type AgentTaskRisk,
  type AssuraPersona,
  type AutonomyLevel,
  type PersonaAgentProfile,
  type PersonaAgentRegistryEngine,
} from './agentic-os';

export type PersonaAgentBinding = {
  registeredAgentId: string;
  promptId: string;
  capabilityId: string;
};

export type PersonaAgentPolicy = {
  autonomyLevel: AutonomyLevel;
  maxRisk: AgentTaskRisk;
  allowedRoles: string[];
  allowedActionClasses: AgentActionClass[];
};

const advisory: AgentActionClass[] = ['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE'];
const observational: AgentActionClass[] = ['READ', 'ANALYZE', 'RECOMMEND'];

/**
 * Conservative defaults for the first production bootstrap.
 *
 * No persona receives EXECUTE_POLICY_BOUND by default. The two profiles allowed
 * EXECUTE_REVERSIBLE are limited to evidence/operations work; protected payment,
 * certification, release and settlement state remains outside persona authority.
 */
export const DEFAULT_PERSONA_AGENT_POLICIES: Record<AssuraPersona, PersonaAgentPolicy> = {
  BUYER: { autonomyLevel: 2, maxRisk: 'HIGH', allowedRoles: ['BUYER', 'ORG_ADMIN'], allowedActionClasses: advisory },
  SUPPLIER: { autonomyLevel: 2, maxRisk: 'HIGH', allowedRoles: ['SUPPLIER', 'ORG_ADMIN'], allowedActionClasses: advisory },
  PROJECT_MANAGER: { autonomyLevel: 2, maxRisk: 'HIGH', allowedRoles: ['PROJECT_MANAGER', 'ORG_ADMIN'], allowedActionClasses: advisory },
  EXECUTIVE_APPROVER: { autonomyLevel: 1, maxRisk: 'CRITICAL', allowedRoles: ['EXECUTIVE_APPROVER', 'ORG_ADMIN'], allowedActionClasses: observational },
  FINANCE_AP: { autonomyLevel: 2, maxRisk: 'HIGH', allowedRoles: ['FINANCE_AP', 'ORG_ADMIN'], allowedActionClasses: advisory },
  VALIDATOR_INSPECTOR: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['VALIDATOR_INSPECTOR', 'ORG_ADMIN'], allowedActionClasses: observational },
  EVIDENCE_CONTRIBUTOR: { autonomyLevel: 3, maxRisk: 'MEDIUM', allowedRoles: ['EVIDENCE_CONTRIBUTOR', 'SUPPLIER', 'ORG_ADMIN'], allowedActionClasses: [...advisory, 'EXECUTE_REVERSIBLE'] },
  PROCUREMENT: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['PROCUREMENT', 'ORG_ADMIN'], allowedActionClasses: observational },
  LENDER: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['LENDER', 'ORG_ADMIN'], allowedActionClasses: observational },
  INSURER_GUARANTOR: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['INSURER_GUARANTOR', 'ORG_ADMIN'], allowedActionClasses: observational },
  PAYMENT_PARTNER: { autonomyLevel: 1, maxRisk: 'CRITICAL', allowedRoles: ['PAYMENT_PARTNER', 'ORG_ADMIN'], allowedActionClasses: observational },
  AUDITOR: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['AUDITOR', 'ORG_ADMIN'], allowedActionClasses: observational },
  DISPUTE_RESOLUTION: { autonomyLevel: 1, maxRisk: 'HIGH', allowedRoles: ['DISPUTE_RESOLUTION', 'ORG_ADMIN'], allowedActionClasses: observational },
  PUBLIC_PROCUREMENT: { autonomyLevel: 1, maxRisk: 'CRITICAL', allowedRoles: ['PUBLIC_PROCUREMENT', 'ORG_ADMIN'], allowedActionClasses: observational },
  REGULATOR_OVERSIGHT: { autonomyLevel: 1, maxRisk: 'CRITICAL', allowedRoles: ['REGULATOR_OVERSIGHT', 'ORG_ADMIN'], allowedActionClasses: observational },
  ORG_ADMIN: { autonomyLevel: 2, maxRisk: 'HIGH', allowedRoles: ['ORG_ADMIN'], allowedActionClasses: advisory },
  ASSURA_OPERATOR: { autonomyLevel: 3, maxRisk: 'MEDIUM', allowedRoles: ['ASSURA_OPERATOR'], allowedActionClasses: [...advisory, 'EXECUTE_REVERSIBLE'] },
  ASSURA_RISK_COMPLIANCE: { autonomyLevel: 1, maxRisk: 'CRITICAL', allowedRoles: ['ASSURA_RISK_COMPLIANCE', 'ORG_ADMIN'], allowedActionClasses: observational },
  EXTERNAL_PLATFORM: { autonomyLevel: 2, maxRisk: 'MEDIUM', allowedRoles: ['EXTERNAL_PLATFORM', 'ORG_ADMIN'], allowedActionClasses: advisory },
};

export type PersonaBootstrapResult = {
  persona: AssuraPersona;
  profile: PersonaAgentProfile;
  changed: boolean;
};

/**
 * Idempotently ensures one active core profile per supplied persona binding.
 *
 * Industry and organization profiles are intentionally not created here. They are
 * trained/configured later and win through PersonaAgentRegistryEngine.resolve's
 * organization > industry > core precedence.
 */
export async function bootstrapCorePersonaAgents(
  context: RequestContext,
  registry: PersonaAgentRegistryEngine,
  bindings: Partial<Record<AssuraPersona, PersonaAgentBinding>>,
): Promise<PersonaBootstrapResult[]> {
  const results: PersonaBootstrapResult[] = [];

  for (const persona of ASSURA_PERSONAS) {
    const binding = bindings[persona];
    if (!binding) continue;

    let current: PersonaAgentProfile | undefined;
    try {
      current = await registry.resolve(context, { persona });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'ACTIVE_PERSONA_AGENT_REQUIRED') throw error;
    }

    if (
      current &&
      current.registeredAgentId === binding.registeredAgentId &&
      current.promptId === binding.promptId &&
      current.capabilityId === binding.capabilityId &&
      !current.industry &&
      !current.organizationId
    ) {
      results.push({ persona, profile: current, changed: false });
      continue;
    }

    const policy = DEFAULT_PERSONA_AGENT_POLICIES[persona];
    const registered = await registry.register(context, {
      persona,
      name: `${persona.replaceAll('_', ' ')} Agent`,
      mission: DEFAULT_PERSONA_AGENT_MISSIONS[persona],
      registeredAgentId: binding.registeredAgentId,
      promptId: binding.promptId,
      capabilityId: binding.capabilityId,
      autonomyLevel: policy.autonomyLevel,
      allowedRoles: policy.allowedRoles,
      allowedActionClasses: policy.allowedActionClasses,
      maxRisk: policy.maxRisk,
    });
    const active = await registry.activate(context, registered.id);
    results.push({ persona, profile: active, changed: true });
  }

  return results;
}
