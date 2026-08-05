import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

const timestamp = () => new Date().toISOString();
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workspace = (context: RequestContext) => {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
};
const assertText = (value: string, code: string) => {
  if (!value.trim()) throw new Error(code);
};

function records<T extends { workspaceId: string }>(
  store: TrustPersistence,
  name: string,
  context: RequestContext,
) {
  return store
    .list<T>(name)
    .filter((entry) => entry.workspaceId === workspace(context));
}
function record<T extends { id: string; workspaceId: string }>(
  store: TrustPersistence,
  name: string,
  context: RequestContext,
  id: string,
) {
  const found = records<T>(store, name, context).find(
    (entry) => entry.id === id,
  );
  if (!found) throw new Error('NOT_FOUND');
  return found;
}
function publish(
  store: TrustPersistence,
  context: RequestContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  metadata: Record<string, unknown> = {},
) {
  store.audit({
    tenantId: context.tenantId,
    workspaceId: workspace(context),
    actorId: context.actorUserId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId: context.correlationId,
    metadata,
  });
  store.emit({
    tenantId: context.tenantId,
    workspaceId: workspace(context),
    aggregateType,
    aggregateId,
    eventType,
    eventVersion: 1,
    payload: metadata,
    correlationId: context.correlationId,
  });
}

export type ProtectedAction =
  'APPROVAL' | 'WAIVER' | 'OVERRIDE' | 'CERTIFICATION';
export type CapabilityMode = 'READ' | 'PROPOSE' | 'EXECUTE_DETERMINISTIC';
export interface Capability {
  id: string;
  workspaceId: string;
  name: string;
  owner: string;
  permission: string;
  mode: CapabilityMode;
  deterministicContract: string;
  aiAllowed: boolean;
  humanApprovalRequired: boolean;
  protectedState: boolean;
  active: boolean;
  createdAt: string;
}

// Engine 62 — capabilities are contracts, never arbitrary functions or direct state handles.
export class CapabilityRegistryEngine {
  constructor(private readonly store: TrustPersistence) {}
  register(
    context: RequestContext,
    input: Omit<Capability, 'id' | 'workspaceId' | 'active' | 'createdAt'>,
  ) {
    assertText(input.name, 'CAPABILITY_NAME_REQUIRED');
    assertText(input.owner, 'CAPABILITY_OWNER_REQUIRED');
    assertText(input.permission, 'CAPABILITY_PERMISSION_REQUIRED');
    assertText(input.deterministicContract, 'DETERMINISTIC_CONTRACT_REQUIRED');
    if (input.protectedState && input.mode !== 'PROPOSE')
      throw new Error('AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES');
    const capability: Capability = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      active: true,
      createdAt: timestamp(),
    };
    this.store.append('agentCapabilities', capability);
    publish(
      this.store,
      context,
      'AgentCapabilityRegistered',
      'AgentCapability',
      capability.id,
      { name: capability.name, mode: capability.mode },
    );
    return capability;
  }
  get(context: RequestContext, id: string) {
    return record<Capability>(this.store, 'agentCapabilities', context, id);
  }
  list(context: RequestContext) {
    return records<Capability>(this.store, 'agentCapabilities', context);
  }
  deactivate(context: RequestContext, id: string) {
    const current = this.get(context, id);
    if (!current.active) throw new Error('CAPABILITY_NOT_ACTIVE');
    const next = { ...current, active: false };
    this.store.replace('agentCapabilities', next);
    publish(
      this.store,
      context,
      'AgentCapabilityDeactivated',
      'AgentCapability',
      id,
    );
    return next;
  }
}

export interface RegisteredAgent {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  owner: string;
  promptIds: string[];
  allowedCapabilityIds: string[];
  active: boolean;
  createdAt: string;
}

export const ASSURAPAY_AGENT_IDENTITIES = [
  'Atlas',
  'Blueprint',
  'DoD',
  'Evidence',
  'Validation',
  'Risk',
  'Settlement',
  'Analytics',
  'Advisor',
  'Coordinator',
] as const;

// Engine 63
export class AgentRegistryEngine {
  constructor(private readonly store: TrustPersistence) {}
  register(
    context: RequestContext,
    input: Omit<
      RegisteredAgent,
      'id' | 'workspaceId' | 'version' | 'active' | 'createdAt'
    >,
  ) {
    assertText(input.name, 'AGENT_NAME_REQUIRED');
    assertText(input.owner, 'AGENT_OWNER_REQUIRED');
    const prior = records<RegisteredAgent>(
      this.store,
      'registeredAgents',
      context,
    ).filter((agent) => agent.name === input.name);
    const agent: RegisteredAgent = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      version: Math.max(0, ...prior.map((x) => x.version)) + 1,
      active: false,
      createdAt: timestamp(),
    };
    this.store.append('registeredAgents', agent);
    publish(this.store, context, 'AgentVersionRegistered', 'Agent', agent.id, {
      name: agent.name,
      version: agent.version,
    });
    return agent;
  }
  activate(context: RequestContext, id: string) {
    const target = record<RegisteredAgent>(
      this.store,
      'registeredAgents',
      context,
      id,
    );
    for (const prior of records<RegisteredAgent>(
      this.store,
      'registeredAgents',
      context,
    ).filter((x) => x.name === target.name && x.active))
      this.store.replace('registeredAgents', { ...prior, active: false });
    const active = { ...target, active: true };
    this.store.replace('registeredAgents', active);
    publish(this.store, context, 'AgentActivated', 'Agent', id, {
      name: active.name,
      version: active.version,
    });
    return active;
  }
  get(context: RequestContext, id: string) {
    return record<RegisteredAgent>(this.store, 'registeredAgents', context, id);
  }
  active(context: RequestContext, name: string) {
    return records<RegisteredAgent>(
      this.store,
      'registeredAgents',
      context,
    ).find((x) => x.name === name && x.active);
  }
}

export interface PromptVersion {
  id: string;
  workspaceId: string;
  promptId: string;
  version: number;
  template: string;
  requiredVariables: string[];
  outputContract: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  checksum: string;
  createdAt: string;
}

// Engine 64
export class PromptRegistryEngine {
  constructor(private readonly store: TrustPersistence) {}
  createVersion(
    context: RequestContext,
    input: {
      promptId: string;
      template: string;
      requiredVariables: string[];
      outputContract: string;
    },
  ) {
    assertText(input.promptId, 'PROMPT_ID_REQUIRED');
    assertText(input.template, 'PROMPT_TEMPLATE_REQUIRED');
    assertText(input.outputContract, 'OUTPUT_CONTRACT_REQUIRED');
    for (const variable of input.requiredVariables)
      if (!input.template.includes(`{{${variable}}}`))
        throw new Error(`PROMPT_VARIABLE_MISSING:${variable}`);
    const prior = records<PromptVersion>(
      this.store,
      'promptVersions',
      context,
    ).filter((x) => x.promptId === input.promptId);
    const version: PromptVersion = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      requiredVariables: [...new Set(input.requiredVariables)].sort(),
      version: Math.max(0, ...prior.map((x) => x.version)) + 1,
      status: 'DRAFT',
      checksum: hash(input),
      createdAt: timestamp(),
    };
    this.store.append('promptVersions', version);
    return version;
  }
  publish(context: RequestContext, id: string) {
    const target = record<PromptVersion>(
      this.store,
      'promptVersions',
      context,
      id,
    );
    for (const current of records<PromptVersion>(
      this.store,
      'promptVersions',
      context,
    ).filter((x) => x.promptId === target.promptId && x.status === 'PUBLISHED'))
      this.store.replace('promptVersions', {
        ...current,
        status: 'RETIRED' as const,
      });
    const next = { ...target, status: 'PUBLISHED' as const };
    this.store.replace('promptVersions', next);
    publish(this.store, context, 'PromptPublished', 'PromptVersion', id, {
      promptId: next.promptId,
      version: next.version,
      checksum: next.checksum,
    });
    return next;
  }
  rollback(context: RequestContext, promptId: string, version: number) {
    const target = records<PromptVersion>(
      this.store,
      'promptVersions',
      context,
    ).find((x) => x.promptId === promptId && x.version === version);
    if (!target) throw new Error('PROMPT_VERSION_NOT_FOUND');
    return this.publish(context, target.id);
  }
  render(
    context: RequestContext,
    promptId: string,
    variables: Record<string, string>,
  ) {
    const active = records<PromptVersion>(
      this.store,
      'promptVersions',
      context,
    ).find((x) => x.promptId === promptId && x.status === 'PUBLISHED');
    if (!active) throw new Error('PUBLISHED_PROMPT_NOT_FOUND');
    let rendered = active.template;
    for (const variable of active.requiredVariables) {
      if (!(variable in variables))
        throw new Error(`PROMPT_VALUE_MISSING:${variable}`);
      rendered = rendered.replaceAll(`{{${variable}}}`, variables[variable]);
    }
    return { version: active, rendered };
  }
  test(
    context: RequestContext,
    id: string,
    cases: Array<{ variables: Record<string, string>; expectedText: string }>,
  ) {
    const prompt = record<PromptVersion>(
      this.store,
      'promptVersions',
      context,
      id,
    );
    return cases.map((testCase) => {
      let output = prompt.template;
      for (const [key, value] of Object.entries(testCase.variables))
        output = output.replaceAll(`{{${key}}}`, value);
      return { passed: output.includes(testCase.expectedText), output };
    });
  }
}

export interface ModelProvider {
  id: string;
  invoke(input: {
    model: string;
    prompt: string;
    outputContract: string;
    timeoutMs: number;
  }): Promise<{
    output: unknown;
    inputTokens: number;
    outputTokens: number;
    costMinor: number;
  }>;
}
export interface GatewayPolicy {
  allowedModels: string[];
  maxRequestsPerMinute: number;
  maxCostMinorPerInvocation: number;
  retries: number;
}
export interface GatewayResult {
  output: unknown;
  provider: string;
  model: string;
  attempts: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
}

// Engine 65
export class AiGatewayEngine {
  private readonly usage = new Map<string, number[]>();
  constructor(
    private readonly providers: ModelProvider[],
    private readonly policy: GatewayPolicy,
  ) {
    if (!providers.length) throw new Error('MODEL_PROVIDER_REQUIRED');
  }
  async invoke(
    context: RequestContext,
    input: {
      model: string;
      prompt: string;
      outputContract: string;
      timeoutMs?: number;
    },
  ): Promise<GatewayResult> {
    if (!this.policy.allowedModels.includes(input.model))
      throw new Error('MODEL_NOT_ALLOWED');
    const key = `${context.tenantId}:${workspace(context)}`;
    const cutoff = Date.now() - 60_000;
    const used = (this.usage.get(key) ?? []).filter((x) => x >= cutoff);
    if (used.length >= this.policy.maxRequestsPerMinute)
      throw new Error('AI_RATE_LIMIT_EXCEEDED');
    used.push(Date.now());
    this.usage.set(key, used);
    const started = Date.now();
    let attempts = 0;
    let lastError: unknown;
    for (let round = 0; round <= this.policy.retries; round++)
      for (const provider of this.providers) {
        attempts++;
        try {
          const timeoutMs = input.timeoutMs ?? 30_000;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const response = await Promise.race([
            provider.invoke({ ...input, timeoutMs }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('AI_PROVIDER_TIMEOUT')),
                timeoutMs,
              );
            }),
          ]).finally(() => timer && clearTimeout(timer));
          if (response.costMinor > this.policy.maxCostMinorPerInvocation)
            throw new Error('AI_COST_LIMIT_EXCEEDED');
          return {
            ...response,
            provider: provider.id,
            model: input.model,
            attempts,
            latencyMs: Date.now() - started,
          };
        } catch (error) {
          lastError = error;
        }
      }
    throw lastError instanceof Error
      ? lastError
      : new Error('AI_GATEWAY_FAILED');
  }
}

export interface ExecutionContextSnapshot {
  id: string;
  workspaceId: string;
  agreementId?: string;
  blueprintId?: string;
  milestoneIds: string[];
  definitionOfDoneIds: string[];
  historyRefs: string[];
  tenantId: string;
  userId: string;
  permissions: string[];
  checksum: string;
  createdAt: string;
}
// Engine 66 — caller supplies governed references/snapshots; this package never reads domain stores.
export class ContextEngine {
  constructor(private readonly store: TrustPersistence) {}
  create(
    context: RequestContext,
    input: Omit<
      ExecutionContextSnapshot,
      'id' | 'workspaceId' | 'tenantId' | 'userId' | 'checksum' | 'createdAt'
    >,
  ) {
    const body = {
      ...input,
      milestoneIds: [...input.milestoneIds],
      definitionOfDoneIds: [...input.definitionOfDoneIds],
      historyRefs: [...input.historyRefs],
      permissions: [...new Set(input.permissions)].sort(),
    };
    if (!context.tenantId) throw new Error('TENANT_CONTEXT_REQUIRED');
    const snapshot: ExecutionContextSnapshot = {
      id: randomUUID(),
      workspaceId: workspace(context),
      tenantId: context.tenantId,
      userId: context.actorUserId,
      ...body,
      checksum: hash(body),
      createdAt: timestamp(),
    };
    this.store.append('agentContextSnapshots', snapshot);
    return snapshot;
  }
  get(context: RequestContext, id: string) {
    return record<ExecutionContextSnapshot>(
      this.store,
      'agentContextSnapshots',
      context,
      id,
    );
  }
}

export interface MemoryEntry {
  id: string;
  workspaceId: string;
  executionId: string;
  agentId: string;
  sequence: number;
  kind: 'USER' | 'AGENT' | 'REASONING_METADATA' | 'TOOL' | 'RESULT';
  content: unknown;
  contentHash: string;
  createdAt: string;
}
// Engine 67 — append-only, explicit, inspectable memory.
export class ExecutionMemoryEngine {
  constructor(private readonly store: TrustPersistence) {}
  append(
    context: RequestContext,
    input: Omit<
      MemoryEntry,
      'id' | 'workspaceId' | 'sequence' | 'contentHash' | 'createdAt'
    >,
  ) {
    const prior = records<MemoryEntry>(
      this.store,
      'agentMemory',
      context,
    ).filter((x) => x.executionId === input.executionId);
    const entry: MemoryEntry = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      sequence: prior.length + 1,
      contentHash: hash(input.content),
      createdAt: timestamp(),
    };
    this.store.append('agentMemory', entry);
    return entry;
  }
  history(context: RequestContext, executionId: string) {
    return records<MemoryEntry>(this.store, 'agentMemory', context)
      .filter((x) => x.executionId === executionId)
      .sort((a, b) => a.sequence - b.sequence);
  }
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  executionId: string;
  requestedByAgentId: string;
  action: ProtectedAction;
  proposalHash: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedBy?: string;
  decidedAt?: string;
  consumedAt?: string;
  createdAt: string;
}
// Engine 68
export class HumanApprovalEngine {
  constructor(private readonly store: TrustPersistence) {}
  request(
    context: RequestContext,
    input: Omit<
      ApprovalRequest,
      | 'id'
      | 'workspaceId'
      | 'status'
      | 'createdAt'
      | 'decidedBy'
      | 'decidedAt'
      | 'consumedAt'
    >,
  ) {
    if (input.requestedByAgentId === context.actorUserId)
      throw new Error('AGENT_ID_CANNOT_BE_HUMAN_ACTOR');
    const request: ApprovalRequest = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      status: 'PENDING',
      createdAt: timestamp(),
    };
    this.store.append('agentApprovalRequests', request);
    publish(
      this.store,
      context,
      'AgentApprovalRequested',
      'AgentApproval',
      request.id,
      { action: request.action },
    );
    return request;
  }
  decide(
    context: RequestContext,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
  ) {
    const request = record<ApprovalRequest>(
      this.store,
      'agentApprovalRequests',
      context,
      id,
    );
    if (request.status !== 'PENDING')
      throw new Error('APPROVAL_ALREADY_DECIDED');
    if (context.actorUserId === request.requestedByAgentId)
      throw new Error('AGENT_CANNOT_SELF_APPROVE');
    const next = {
      ...request,
      status: decision,
      decidedBy: context.actorUserId,
      decidedAt: timestamp(),
    };
    this.store.replace('agentApprovalRequests', next);
    publish(this.store, context, 'AgentApprovalDecided', 'AgentApproval', id, {
      decision,
    });
    return next;
  }
  consume(context: RequestContext, id: string, proposalHash: string) {
    const request = record<ApprovalRequest>(
      this.store,
      'agentApprovalRequests',
      context,
      id,
    );
    if (request.status !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
    if (request.consumedAt) throw new Error('APPROVAL_ALREADY_CONSUMED');
    if (request.proposalHash !== proposalHash)
      throw new Error('APPROVAL_PROPOSAL_MISMATCH');
    const next = { ...request, consumedAt: timestamp() };
    this.store.replace('agentApprovalRequests', next);
    return next;
  }
}

export interface TelemetryRecord {
  id: string;
  workspaceId: string;
  executionId: string;
  agentId: string;
  provider?: string;
  latencyMs: number;
  costMinor: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  qualityScore?: number;
  hallucinationFlag: boolean;
  approvalRequested: boolean;
  createdAt: string;
}
// Engine 69
export class AgentTelemetryEngine {
  constructor(private readonly store: TrustPersistence) {}
  record(
    context: RequestContext,
    input: Omit<TelemetryRecord, 'id' | 'workspaceId' | 'createdAt'>,
  ) {
    if (
      [
        input.latencyMs,
        input.costMinor,
        input.inputTokens,
        input.outputTokens,
        input.errors,
      ].some((x) => !Number.isFinite(x) || x < 0)
    )
      throw new Error('INVALID_TELEMETRY_VALUE');
    if (
      input.qualityScore !== undefined &&
      (input.qualityScore < 0 || input.qualityScore > 100)
    )
      throw new Error('INVALID_QUALITY_SCORE');
    const value: TelemetryRecord = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      createdAt: timestamp(),
    };
    this.store.append('agentTelemetry', value);
    return value;
  }
  summarize(context: RequestContext, agentId?: string) {
    const values = records<TelemetryRecord>(
      this.store,
      'agentTelemetry',
      context,
    ).filter((x) => !agentId || x.agentId === agentId);
    const count = values.length;
    return {
      count,
      totalCostMinor: values.reduce((sum, x) => sum + x.costMinor, 0),
      errorRate: count
        ? values.reduce((sum, x) => sum + x.errors, 0) / count
        : 0,
      averageLatencyMs: count
        ? values.reduce((sum, x) => sum + x.latencyMs, 0) / count
        : 0,
      hallucinationRate: count
        ? values.filter((x) => x.hallucinationFlag).length / count
        : 0,
      approvalRate: count
        ? values.filter((x) => x.approvalRequested).length / count
        : 0,
    };
  }
}

export interface GovernancePolicy {
  id: string;
  workspaceId: string;
  version: number;
  allowedRoles: string[];
  allowedPromptIds: string[];
  allowedCapabilityIds: string[];
  allowedModels: string[];
  requireApprovalFor: ProtectedAction[];
  active: boolean;
  createdAt: string;
}
// Engine 70
export class AgentGovernanceEngine {
  constructor(private readonly store: TrustPersistence) {}
  publish(
    context: RequestContext,
    input: Omit<
      GovernancePolicy,
      'id' | 'workspaceId' | 'version' | 'active' | 'createdAt'
    >,
  ) {
    const prior = records<GovernancePolicy>(
      this.store,
      'agentGovernancePolicies',
      context,
    );
    for (const current of prior.filter((x) => x.active))
      this.store.replace('agentGovernancePolicies', {
        ...current,
        active: false,
      });
    const policy: GovernancePolicy = {
      id: randomUUID(),
      workspaceId: workspace(context),
      ...input,
      version: Math.max(0, ...prior.map((x) => x.version)) + 1,
      active: true,
      createdAt: timestamp(),
    };
    this.store.append('agentGovernancePolicies', policy);
    publish(
      this.store,
      context,
      'AgentGovernancePolicyPublished',
      'AgentGovernancePolicy',
      policy.id,
      { version: policy.version },
    );
    return policy;
  }
  authorize(
    context: RequestContext,
    input: {
      roles: string[];
      promptId: string;
      capabilityId: string;
      model: string;
      action?: ProtectedAction;
    },
  ) {
    const policy = records<GovernancePolicy>(
      this.store,
      'agentGovernancePolicies',
      context,
    ).find((x) => x.active);
    if (!policy) throw new Error('ACTIVE_AGENT_GOVERNANCE_POLICY_REQUIRED');
    if (!input.roles.some((role) => policy.allowedRoles.includes(role)))
      throw new Error('AGENT_ROLE_DENIED');
    if (!policy.allowedPromptIds.includes(input.promptId))
      throw new Error('PROMPT_POLICY_DENIED');
    if (!policy.allowedCapabilityIds.includes(input.capabilityId))
      throw new Error('CAPABILITY_POLICY_DENIED');
    if (!policy.allowedModels.includes(input.model))
      throw new Error('MODEL_POLICY_DENIED');
    const approvalRequired =
      input.action !== undefined &&
      policy.requireApprovalFor.includes(input.action);
    publish(
      this.store,
      context,
      'AgentGovernanceAuthorized',
      'AgentGovernancePolicy',
      policy.id,
      {
        promptId: input.promptId,
        capabilityId: input.capabilityId,
        model: input.model,
        approvalRequired,
      },
    );
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      approvalRequired,
    };
  }
}

export interface AgentExecution {
  id: string;
  workspaceId: string;
  agentId: string;
  capabilityId: string;
  promptVersionId: string;
  contextSnapshotId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  proposal?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}
export interface DeterministicCapabilityGateway {
  invoke(contract: string, input: unknown): Promise<unknown>;
}

// Engine 61 — the only execution entry point. Output is a proposal/result artifact, never protected state.
export class AgentRuntimeEngine {
  constructor(
    private readonly deps: {
      store: TrustPersistence;
      agents: AgentRegistryEngine;
      capabilities: CapabilityRegistryEngine;
      prompts: PromptRegistryEngine;
      contexts: ContextEngine;
      memory: ExecutionMemoryEngine;
      telemetry: AgentTelemetryEngine;
      governance: AgentGovernanceEngine;
      ai: AiGatewayEngine;
      deterministic: DeterministicCapabilityGateway;
    },
  ) {}
  cancel(context: RequestContext, id: string) {
    const run = record<AgentExecution>(
      this.deps.store,
      'agentExecutions',
      context,
      id,
    );
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING')
      throw new Error('EXECUTION_NOT_CANCELLABLE');
    const next = {
      ...run,
      status: 'CANCELLED' as const,
      completedAt: timestamp(),
    };
    this.deps.store.replace('agentExecutions', next);
    publish(
      this.deps.store,
      context,
      'AgentExecutionCancelled',
      'AgentExecution',
      id,
    );
    return next;
  }
  async execute(
    context: RequestContext,
    input: {
      agentId: string;
      capabilityId: string;
      promptId: string;
      contextSnapshotId: string;
      model: string;
      roles: string[];
      variables: Record<string, string>;
      maxAttempts?: number;
      timeoutMs?: number;
    },
  ) {
    const agent = this.deps.agents.get(context, input.agentId);
    if (!agent.active) throw new Error('AGENT_NOT_ACTIVE');
    if (!agent.allowedCapabilityIds.includes(input.capabilityId))
      throw new Error('AGENT_CAPABILITY_DENIED');
    if (!agent.promptIds.includes(input.promptId))
      throw new Error('AGENT_PROMPT_DENIED');
    const capability = this.deps.capabilities.get(context, input.capabilityId);
    if (!capability.active || !capability.aiAllowed)
      throw new Error('CAPABILITY_NOT_AVAILABLE_TO_AI');
    const authorization = this.deps.governance.authorize(context, {
      roles: input.roles,
      promptId: input.promptId,
      capabilityId: input.capabilityId,
      model: input.model,
      action: capability.humanApprovalRequired ? 'APPROVAL' : undefined,
    });
    const approvalRequired =
      authorization.approvalRequired || capability.humanApprovalRequired;
    this.deps.contexts.get(context, input.contextSnapshotId);
    const prompt = this.deps.prompts.render(
      context,
      input.promptId,
      input.variables,
    );
    const run: AgentExecution = {
      id: randomUUID(),
      workspaceId: workspace(context),
      agentId: agent.id,
      capabilityId: capability.id,
      promptVersionId: prompt.version.id,
      contextSnapshotId: input.contextSnapshotId,
      status: 'QUEUED',
      attempts: 0,
      createdAt: timestamp(),
    };
    this.deps.store.append('agentExecutions', run);
    const running = {
      ...run,
      status: 'RUNNING' as const,
      startedAt: timestamp(),
    };
    this.deps.store.replace('agentExecutions', running);
    this.deps.memory.append(context, {
      executionId: run.id,
      agentId: agent.id,
      kind: 'USER',
      content: input.variables,
    });
    const maxAttempts = Math.max(1, input.maxAttempts ?? 1);
    const started = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++)
      try {
        const ai = await this.deps.ai.invoke(context, {
          model: input.model,
          prompt: prompt.rendered,
          outputContract: prompt.version.outputContract,
          timeoutMs: input.timeoutMs,
        });
        const proposal =
          capability.mode === 'EXECUTE_DETERMINISTIC' && !approvalRequired
            ? await this.deps.deterministic.invoke(
                capability.deterministicContract,
                ai.output,
              )
            : ai.output;
        const succeeded: AgentExecution = {
          ...running,
          status: 'SUCCEEDED',
          attempts: attempt,
          proposal,
          completedAt: timestamp(),
        };
        this.deps.store.replace('agentExecutions', succeeded);
        this.deps.memory.append(context, {
          executionId: run.id,
          agentId: agent.id,
          kind: 'RESULT',
          content: proposal,
        });
        this.deps.telemetry.record(context, {
          executionId: run.id,
          agentId: agent.id,
          provider: ai.provider,
          latencyMs: Date.now() - started,
          costMinor: ai.costMinor,
          inputTokens: ai.inputTokens,
          outputTokens: ai.outputTokens,
          errors: attempt - 1,
          hallucinationFlag: false,
          approvalRequested: approvalRequired,
        });
        publish(
          this.deps.store,
          context,
          'AgentExecutionSucceeded',
          'AgentExecution',
          run.id,
          { capabilityId: capability.id, promptVersionId: prompt.version.id },
        );
        return succeeded;
      } catch (error) {
        lastError = error;
      }
    const message =
      lastError instanceof Error ? lastError.message : 'AGENT_EXECUTION_FAILED';
    const failed: AgentExecution = {
      ...running,
      status: 'FAILED',
      attempts: maxAttempts,
      error: message,
      completedAt: timestamp(),
    };
    this.deps.store.replace('agentExecutions', failed);
    this.deps.telemetry.record(context, {
      executionId: run.id,
      agentId: agent.id,
      latencyMs: Date.now() - started,
      costMinor: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: maxAttempts,
      hallucinationFlag: false,
      approvalRequested: false,
    });
    publish(
      this.deps.store,
      context,
      'AgentExecutionFailed',
      'AgentExecution',
      run.id,
      { error: message },
    );
    return failed;
  }
}

export * from './registration';
