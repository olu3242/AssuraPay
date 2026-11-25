import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import {
  authorizeDispatch,
  type AgentActionClass,
  type AgentTaskRisk,
  type AutonomyLevel,
  type AutonomyMandate,
  type DenialReason,
  type EscalationReason,
} from './autonomy';
import type { AgentRuntimeEngine } from './index';

/**
 * Constitutional dispatch: the only way an agent is asked to do anything.
 *
 * ## What "constitutional" means here, and what it does not
 *
 * PR #46 named this layer and the name is worth keeping, because it says the right thing: there is
 * one route from "someone wants an agent to do this" to an agent doing it, and it runs through
 * `AgentRuntimeEngine.execute`. No parallel path, no second runtime, no direct model call. The
 * runtime keeps its capability contract, its prompt allowlist, its governance policy, its rate limit
 * and its telemetry, and dispatch adds a mandate check in front.
 *
 * What it is not is an authority. `autonomy.ts` holds the ceiling — no action class at any level
 * reaches a money authority — and this engine cannot widen it, because the verdict it acts on is
 * computed by a pure function it does not own.
 *
 * ## Escalation is durable, because the alternative is a silent drop
 *
 * A task beyond an agent's mandate is not refused. It is a legitimate request that is simply bigger
 * than the agent, so it goes to a person — and the record of that is written to the store before
 * this method returns.
 *
 * That durability is the lesson of the flow relay. `FlowSignalRelay.drain` was correct and had no
 * caller, so journeys stalled invisibly; an escalation returned to a caller and never persisted
 * would stall exactly as invisibly, with the added insult of having been noticed. An open escalation
 * is a row somebody can list.
 *
 * ## Why a new record rather than an existing one
 *
 * Neither existing store fits, and forcing it would have meant inventing identifiers:
 *
 * - `ApprovalRequest` (Engine 68) requires an `executionId`. It is for an agent that is *already
 *   running* and has reached a protected action. An escalated task never ran.
 * - `HumanTask` requires a `flowInstanceId` and a `stepInstanceId`. An escalated task may have no
 *   flow at all — the request can come from a screen rather than from a journey.
 *
 * So `agentEscalations` is its own governed document. It needs no migration: governed documents live
 * in `trust_records` under their collection name, with the same forced row-level security every other
 * document gets.
 *
 * ## Idempotency
 *
 * A caller that retries must not accumulate escalations. The task carries an `idempotencyKey` and a
 * repeat returns the escalation already recorded — the same decision `FlowOrchestrator.signal` takes
 * about domain events, and for the same reason: retrying is normal and duplicating is not.
 */

/** The collection escalations are stored in. Registered as a governed document in `postgres-store`. */
export const AGENT_ESCALATION_COLLECTION = 'agentEscalations';

/**
 * The agent being dispatched, as the engine needs to see it.
 *
 * `agent` and `persona` are opaque strings here. This package must not know the persona catalogue —
 * `apps/web/lib/persona-agents.ts` owns that binding — so they travel as labels for the record and
 * are never interpreted.
 */
export type DispatchProfile = {
  readonly agent: string;
  readonly persona: string;
  readonly mandate: AutonomyMandate;
  /** The governed runtime identities. All three are enforced by `AgentRuntimeEngine.execute`. */
  readonly registeredAgentId: string;
  readonly capabilityId: string;
  readonly promptId: string;
};

export type DispatchTask = {
  readonly actionClass: AgentActionClass;
  readonly risk: AgentTaskRisk;
  /** Roles the dispatching caller holds. */
  readonly roles: readonly string[];
  readonly contextSnapshotId: string;
  readonly model: string;
  readonly variables: Readonly<Record<string, string>>;
  /** Spent once per task, so a retry neither re-executes nor re-escalates. */
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
};

export type AgentEscalation = {
  id: string;
  workspaceId: string;
  agent: string;
  persona: string;
  actionClass: AgentActionClass;
  risk: AgentTaskRisk;
  autonomyLevel: AutonomyLevel;
  reason: EscalationReason;
  /** The human who asked. Never an agent: dispatch is always requested by a person or a worker. */
  requestedBy: string;
  idempotencyKey: string;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type DispatchOutcome =
  | { readonly outcome: 'DISPATCHED'; readonly executionId: string }
  | { readonly outcome: 'ESCALATED'; readonly escalation: AgentEscalation }
  | { readonly outcome: 'DENIED'; readonly reason: DenialReason };

export type DispatchDependencies = {
  readonly runtime: Pick<AgentRuntimeEngine, 'execute'>;
  readonly store: TrustPersistence;
  readonly now?: () => Date;
};

export class AgenticDispatchEngine {
  constructor(private readonly deps: DispatchDependencies) {}

  private timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /**
   * Asks an agent to do one task, or records that a person must.
   *
   * Returns rather than throws for every outcome, including denial. `authorizeDispatch` is total for
   * the same reason: a function that sometimes throws makes each caller handle two shapes, and the
   * one they forget is the throw. #46's version threw for mandate and role failures.
   */
  async dispatch(
    context: RequestContext,
    profile: DispatchProfile,
    task: DispatchTask,
  ): Promise<DispatchOutcome> {
    requireActiveWorkspace(context);

    // The spent key is checked first, so a retry is answered from the record rather than re-judged.
    // Re-judging would be harmless today and would stop being harmless the moment a mandate changes
    // between the first call and the retry.
    const existing = await this.escalationFor(context, task.idempotencyKey);
    if (existing) return { outcome: 'ESCALATED', escalation: existing };

    const verdict = authorizeDispatch(profile.mandate, {
      actionClass: task.actionClass,
      risk: task.risk,
      roles: task.roles,
    });

    if (verdict.outcome === 'DENY') return { outcome: 'DENIED', reason: verdict.reason };

    if (verdict.outcome === 'ESCALATE') {
      const escalation: AgentEscalation = {
        id: randomUUID(),
        workspaceId: context.activeWorkspaceId,
        agent: profile.agent,
        persona: profile.persona,
        actionClass: task.actionClass,
        risk: task.risk,
        autonomyLevel: profile.mandate.autonomyLevel,
        reason: verdict.reason,
        requestedBy: context.actorUserId,
        idempotencyKey: task.idempotencyKey,
        status: 'OPEN',
        createdAt: this.timestamp(),
      };
      // Written before returning. An escalation the caller knows about and the store does not is a
      // stall nobody can list.
      await this.deps.store.append(AGENT_ESCALATION_COLLECTION, escalation);
      return { outcome: 'ESCALATED', escalation };
    }

    const execution = await this.deps.runtime.execute(context, {
      agentId: profile.registeredAgentId,
      capabilityId: profile.capabilityId,
      promptId: profile.promptId,
      contextSnapshotId: task.contextSnapshotId,
      model: task.model,
      roles: [...task.roles],
      variables: {
        ...task.variables,
        // Recorded on the execution so a telemetry reader can see which mandate admitted it. Strings
        // because that is what the runtime's variable map holds.
        agent: profile.agent,
        persona: profile.persona,
        actionClass: task.actionClass,
        risk: task.risk,
        autonomyLevel: String(profile.mandate.autonomyLevel),
      },
      ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
      ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    });

    return { outcome: 'DISPATCHED', executionId: execution.id };
  }

  /** Escalations still waiting on a person, oldest first. */
  async openEscalations(context: RequestContext): Promise<AgentEscalation[]> {
    requireActiveWorkspace(context);
    return (await this.deps.store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION))
      .filter(
        (entry) => entry.workspaceId === context.activeWorkspaceId && entry.status === 'OPEN',
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Marks an escalation handled.
   *
   * Append-only in spirit: this records that a person dealt with it and by whom. It does not record
   * *what* they decided, because deciding is not this engine's business — the decision happens in
   * whichever deterministic engine owns the act, under that engine's own authorization and audit.
   * An escalation is a routing record, not an approval.
   */
  async resolve(context: RequestContext, escalationId: string): Promise<AgentEscalation> {
    requireActiveWorkspace(context);
    const all = await this.deps.store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION);
    const found = all.find(
      (entry) => entry.id === escalationId && entry.workspaceId === context.activeWorkspaceId,
    );
    if (!found) throw new Error('AGENT_ESCALATION_NOT_FOUND');
    if (found.status === 'RESOLVED') return found;
    const resolved: AgentEscalation = {
      ...found,
      status: 'RESOLVED',
      resolvedAt: this.timestamp(),
      resolvedBy: context.actorUserId,
    };
    await this.deps.store.replace(AGENT_ESCALATION_COLLECTION, resolved);
    return resolved;
  }

  private async escalationFor(
    context: RequestContext,
    idempotencyKey: string,
  ): Promise<AgentEscalation | undefined> {
    requireActiveWorkspace(context);
    return (await this.deps.store.list<AgentEscalation>(AGENT_ESCALATION_COLLECTION)).find(
      (entry) =>
        entry.workspaceId === context.activeWorkspaceId && entry.idempotencyKey === idempotencyKey,
    );
  }
}
