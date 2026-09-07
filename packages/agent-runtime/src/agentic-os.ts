import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { AgentRuntimeEngine } from './index';

const now = () => new Date().toISOString();
const workspaceId = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};
const tenantId = (context: RequestContext) => {
  if (!context.tenantId) throw new Error('TENANT_CONTEXT_REQUIRED');
  return context.tenantId;
};

export const ASSURA_PERSONAS = [
  'BUYER',
  'SUPPLIER',
  'PROJECT_MANAGER',
  'EXECUTIVE_APPROVER',
  'FINANCE_AP',
  'VALIDATOR_INSPECTOR',
  'EVIDENCE_CONTRIBUTOR',
  'PROCUREMENT',
  'LENDER',
  'INSURER_GUARANTOR',
  'PAYMENT_PARTNER',
  'AUDITOR',
  'DISPUTE_RESOLUTION',
  'PUBLIC_PROCUREMENT',
  'REGULATOR_OVERSIGHT',
  'ORG_ADMIN',
  'ASSURA_OPERATOR',
  'ASSURA_RISK_COMPLIANCE',
  'EXTERNAL_PLATFORM',
] as const;

export type AssuraPersona = (typeof ASSURA_PERSONAS)[number];
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type AgentTaskRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AgentActionClass =
  | 'READ'
  | 'ANALYZE'
  | 'RECOMMEND'
  | 'PREPARE'
  | 'EXECUTE_REVERSIBLE'
  | 'EXECUTE_POLICY_BOUND';

export interface PersonaAgentProfile {
  id: string;
  tenantId: string;
  workspaceId: string;
  persona: AssuraPersona;
  name: string;
  mission: string;
  registeredAgentId: string;
  promptId: string;
  capabilityId: string;
  autonomyLevel: AutonomyLevel;
  allowedRoles: string[];
  allowedActionClasses: AgentActionClass[];
  maxRisk: AgentTaskRisk;
  industry?: string;
  organizationId?: string;
  active: boolean;
  version: number;
  createdAt: string;
}

export interface AgenticTask {
  persona: AssuraPersona;
  actionClass: AgentActionClass;
  risk: AgentTaskRisk;
  contextSnapshotId: string;
  model: string;
  roles: string[];
  variables: Record<string, string>;
  transactionId?: string;
  agreementId?: string;
  industry?: string;
  organizationId?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

const RISK_ORDER: AgentTaskRisk[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const REQUIRED_AUTONOMY: Record<AgentActionClass, AutonomyLevel> = {
  READ: 0,
  ANALYZE: 0,
  RECOMMEND: 1,
  PREPARE: 2,
  EXECUTE_REVERSIBLE: 3,
  EXECUTE_POLICY_BOUND: 4,
};

/**
 * Persona assignment registry for the Agentic OS.
 *
 * A profile does not create a new AI runtime. It binds a commercial persona to an
 * already governed AgentRegistry identity, prompt and capability contract. This
 * keeps Agent Runtime Engines 61–70 canonical while making persona autonomy a
 * first-class, reviewable policy artifact.
 */
export class PersonaAgentRegistryEngine {
  constructor(private readonly store: TrustPersistence) {}

  async register(
    context: RequestContext,
    input: Omit<
      PersonaAgentProfile,
      'id' | 'tenantId' | 'workspaceId' | 'active' | 'version' | 'createdAt'
    >,
  ) {
    if (!ASSURA_PERSONAS.includes(input.persona)) throw new Error('PERSONA_INVALID');
    if (!input.name.trim()) throw new Error('PERSONA_AGENT_NAME_REQUIRED');
    if (!input.mission.trim()) throw new Error('PERSONA_AGENT_MISSION_REQUIRED');
    if (!input.registeredAgentId.trim()) throw new Error('REGISTERED_AGENT_REQUIRED');
    if (!input.promptId.trim()) throw new Error('PROMPT_REQUIRED');
    if (!input.capabilityId.trim()) throw new Error('CAPABILITY_REQUIRED');

    const scoped = (await this.store.list<PersonaAgentProfile>('personaAgentProfiles'))
      .filter((profile) => profile.workspaceId === workspaceId(context))
      .filter((profile) => profile.persona === input.persona)
      .filter((profile) => profile.industry === input.industry)
      .filter((profile) => profile.organizationId === input.organizationId);

    const profile: PersonaAgentProfile = {
      id: randomUUID(),
      tenantId: tenantId(context),
      workspaceId: workspaceId(context),
      ...input,
      allowedRoles: [...new Set(input.allowedRoles)].sort(),
      allowedActionClasses: [...new Set(input.allowedActionClasses)],
      version: Math.max(0, ...scoped.map((item) => item.version)) + 1,
      active: false,
      createdAt: now(),
    };

    await this.store.append('personaAgentProfiles', profile);
    await this.store.audit({
      tenantId: context.tenantId,
      workspaceId: context.activeWorkspaceId,
      actorId: context.actorUserId,
      eventType: 'PersonaAgentProfileRegistered',
      aggregateType: 'PersonaAgentProfile',
      aggregateId: profile.id,
      correlationId: context.correlationId,
      metadata: {
        persona: profile.persona,
        version: profile.version,
        autonomyLevel: profile.autonomyLevel,
        maxRisk: profile.maxRisk,
      },
    });
    return profile;
  }

  async activate(context: RequestContext, id: string) {
    const profiles = (await this.store.list<PersonaAgentProfile>('personaAgentProfiles'))
      .filter((profile) => profile.workspaceId === workspaceId(context));
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new Error('PERSONA_AGENT_NOT_FOUND');

    for (const profile of profiles.filter(
      (candidate) =>
        candidate.active &&
        candidate.persona === target.persona &&
        candidate.industry === target.industry &&
        candidate.organizationId === target.organizationId,
    )) {
      await this.store.replace('personaAgentProfiles', { ...profile, active: false });
    }

    const active = { ...target, active: true };
    await this.store.replace('personaAgentProfiles', active);
    await this.store.audit({
      tenantId: context.tenantId,
      workspaceId: context.activeWorkspaceId,
      actorId: context.actorUserId,
      eventType: 'PersonaAgentProfileActivated',
      aggregateType: 'PersonaAgentProfile',
      aggregateId: active.id,
      correlationId: context.correlationId,
      metadata: {
        persona: active.persona,
        version: active.version,
        autonomyLevel: active.autonomyLevel,
        maxRisk: active.maxRisk,
      },
    });
    return active;
  }

  async resolve(context: RequestContext, task: Pick<AgenticTask, 'persona' | 'industry' | 'organizationId'>) {
    const candidates = (await this.store.list<PersonaAgentProfile>('personaAgentProfiles'))
      .filter((profile) => profile.workspaceId === workspaceId(context))
      .filter((profile) => profile.active)
      .filter((profile) => profile.persona === task.persona);

    const organizationMatch = candidates.find(
      (profile) =>
        profile.organizationId === task.organizationId &&
        profile.industry === task.industry,
    );
    if (organizationMatch) return organizationMatch;

    const industryMatch = candidates.find(
      (profile) => !profile.organizationId && profile.industry === task.industry,
    );
    if (industryMatch) return industryMatch;

    const coreMatch = candidates.find(
      (profile) => !profile.organizationId && !profile.industry,
    );
    if (!coreMatch) throw new Error('ACTIVE_PERSONA_AGENT_REQUIRED');
    return coreMatch;
  }
}

export interface AgenticDispatchDecision {
  profileId: string;
  profileVersion: number;
  persona: AssuraPersona;
  autonomyLevel: AutonomyLevel;
  actionClass: AgentActionClass;
  risk: AgentTaskRisk;
  executionId?: string;
  status: 'DISPATCHED' | 'HUMAN_APPROVAL_REQUIRED';
  reason?: string;
}

/**
 * Constitutional dispatch layer for autonomous persona agents.
 *
 * It never bypasses AgentRuntimeEngine. Autonomy determines whether work may be
 * dispatched, not whether protected lifecycle state may be changed. Protected
 * payment/certification/release authority remains in deterministic domain engines.
 */
export class AgenticDispatchEngine {
  constructor(
    private readonly profiles: PersonaAgentRegistryEngine,
    private readonly runtime: Pick<AgentRuntimeEngine, 'execute'>,
  ) {}

  async dispatch(context: RequestContext, task: AgenticTask): Promise<AgenticDispatchDecision> {
    const profile = await this.profiles.resolve(context, task);

    if (!profile.allowedActionClasses.includes(task.actionClass)) {
      throw new Error('PERSONA_ACTION_CLASS_DENIED');
    }
    if (!task.roles.some((role) => profile.allowedRoles.includes(role))) {
      throw new Error('PERSONA_ROLE_DENIED');
    }
    if (RISK_ORDER.indexOf(task.risk) > RISK_ORDER.indexOf(profile.maxRisk)) {
      return {
        profileId: profile.id,
        profileVersion: profile.version,
        persona: profile.persona,
        autonomyLevel: profile.autonomyLevel,
        actionClass: task.actionClass,
        risk: task.risk,
        status: 'HUMAN_APPROVAL_REQUIRED',
        reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE',
      };
    }

    const required = REQUIRED_AUTONOMY[task.actionClass];
    if (profile.autonomyLevel < required) {
      return {
        profileId: profile.id,
        profileVersion: profile.version,
        persona: profile.persona,
        autonomyLevel: profile.autonomyLevel,
        actionClass: task.actionClass,
        risk: task.risk,
        status: 'HUMAN_APPROVAL_REQUIRED',
        reason: 'AUTONOMY_LEVEL_INSUFFICIENT',
      };
    }

    const execution = await this.runtime.execute(context, {
      agentId: profile.registeredAgentId,
      capabilityId: profile.capabilityId,
      promptId: profile.promptId,
      contextSnapshotId: task.contextSnapshotId,
      model: task.model,
      roles: task.roles,
      variables: {
        ...task.variables,
        persona: profile.persona,
        personaAgentProfileId: profile.id,
        personaAgentProfileVersion: String(profile.version),
        autonomyLevel: String(profile.autonomyLevel),
        transactionId: task.transactionId ?? '',
        agreementId: task.agreementId ?? '',
      },
      maxAttempts: task.maxAttempts,
      timeoutMs: task.timeoutMs,
    });

    return {
      profileId: profile.id,
      profileVersion: profile.version,
      persona: profile.persona,
      autonomyLevel: profile.autonomyLevel,
      actionClass: task.actionClass,
      risk: task.risk,
      executionId: execution.id,
      status: 'DISPATCHED',
    };
  }
}

export const DEFAULT_PERSONA_AGENT_MISSIONS: Record<AssuraPersona, string> = {
  BUYER: 'Protect the buyer from paying for unproven or non-conforming performance.',
  SUPPLIER: 'Help the supplier satisfy obligations, prove performance, and become payment-ready.',
  PROJECT_MANAGER: 'Continuously control milestone execution, dependencies, exceptions, and schedule risk.',
  EXECUTIVE_APPROVER: 'Prepare evidence-bound commercial decisions without self-authorizing protected state.',
  FINANCE_AP: 'Reconcile commercial acceptance to invoices, authorization, and settlement readiness.',
  VALIDATOR_INSPECTOR: 'Assess whether claimed performance satisfies the applicable Definition of Done.',
  EVIDENCE_CONTRIBUTOR: 'Capture, classify, and map admissible evidence to obligations and milestones.',
  PROCUREMENT: 'Evaluate counterparties using price, performance, capacity, and assurance history.',
  LENDER: 'Convert verified commercial activity into permissioned financeability evidence.',
  INSURER_GUARANTOR: 'Continuously assess insured commercial performance and changing execution risk.',
  PAYMENT_PARTNER: 'Coordinate non-custodial payment readiness and verify settlement state.',
  AUDITOR: 'Maintain continuous, reconstructable, evidence-linked control and transaction assurance.',
  DISPUTE_RESOLUTION: 'Construct neutral evidence timelines and resolution options for commercial exceptions.',
  PUBLIC_PROCUREMENT: 'Assure value-for-money, milestone integrity, and segregation of duties in public contracts.',
  REGULATOR_OVERSIGHT: 'Surface policy-scoped compliance exceptions and systemic assurance signals.',
  ORG_ADMIN: 'Govern persona assignments, access, policies, and organizational agent configuration.',
  ASSURA_OPERATOR: 'Operate the Agentic OS without acquiring hidden authority over commercial truth.',
  ASSURA_RISK_COMPLIANCE: 'Detect fraud, collusion, anomalies, and network-level commercial risk.',
  EXTERNAL_PLATFORM: 'Embed Assura assurance capabilities safely into external systems through governed APIs.',
};
