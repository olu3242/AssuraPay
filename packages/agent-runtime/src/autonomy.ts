/**
 * Agent autonomy: how far an agent may act before a person has to.
 *
 * ## Where this came from
 *
 * PR #46 ("converge persona agents with governed runtime") proposed this model and was left open for
 * two and a half months, by which time its branch had fallen 39 commits behind and no longer carried
 * any of the migration registrations that enforce the money-movement invariants. Merging it would
 * have dropped them. So the ideas are rebuilt here on current `main`, and the parts that were wrong
 * are corrected rather than carried over.
 *
 * Kept from #46, because they are the right shape:
 *
 * - **Autonomy levels 0–5.** One number per agent profile, saying how far it may go unaided.
 * - **Action classes.** What a task *is*, from reading to acting, each with a minimum autonomy.
 * - **Risk ceilings.** A per-profile cap, so a mandate can be narrow in risk and wide in kind.
 * - **Escalation rather than refusal** when autonomy or risk is insufficient: the work is handed to a
 *   person, not dropped.
 *
 * ## What is corrected
 *
 * #46's highest action class was `EXECUTE_POLICY_BOUND`, reachable at autonomy 4, and it defended
 * itself on the grounds that dispatch is not the same as mutating protected state. That is true and
 * it is not enough. An action class named *execute*, reachable by configuration, is an invitation —
 * and the invariant it leans on lives in a different package from the number that unlocks it.
 *
 * So the ceiling is structural here. `MONEY_AUTHORITY_ACTION_CLASSES` is empty: **no action class at
 * any autonomy level corresponds to certifying work, approving a release or submitting a payment.**
 * Those are the three authorities CLAUDE.md's second hard constraint separates, and an agent cannot
 * reach them by being given a higher number, because there is no number that reaches them. An agent
 * proposes; a deterministic engine enforces; a person decides. That ordering is not a policy an
 * operator can widen — `autonomy.test.ts` asserts it over the whole matrix.
 *
 * The highest class an agent can hold is therefore `PREPARE`: it may draft, stage and recommend, and
 * what it prepares still requires the decision it cannot make.
 */

/** How far an agent may act unaided. Higher is wider, never deeper into money movement. */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = Object.freeze([0, 1, 2, 3, 4, 5]);

/**
 * What a task does, in ascending order of consequence.
 *
 * `EXECUTE_REVERSIBLE` and `EXECUTE_POLICY_BOUND` from #46 are deliberately absent. Every action an
 * agent can take here stops short of changing protected lifecycle state, so there is no class whose
 * name promises execution and whose safety depends on a constraint enforced somewhere else.
 */
export type AgentActionClass = 'READ' | 'ANALYZE' | 'RECOMMEND' | 'PREPARE';

export const AGENT_ACTION_CLASSES: readonly AgentActionClass[] = Object.freeze([
  'READ',
  'ANALYZE',
  'RECOMMEND',
  'PREPARE',
]);

export type AgentTaskRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_ORDER: readonly AgentTaskRisk[] = Object.freeze([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

/**
 * The minimum autonomy each action class needs.
 *
 * Reading and analysing need none: an agent that can only look changes nothing, and gating that
 * behind a level would mean an agent configured at 0 could not even report. Recommending needs 1,
 * because a recommendation reaches a person and carries weight. Preparing needs 2, because a staged
 * draft is one approval away from being acted on.
 *
 * The gap between 2 and 5 is deliberate and is not spare capacity waiting for an execute class to
 * fill it. It is headroom for action classes that do not touch the money path — scheduling a check,
 * assembling an evidence bundle — added when there is one to add.
 */
export const REQUIRED_AUTONOMY: Readonly<Record<AgentActionClass, AutonomyLevel>> = Object.freeze({
  READ: 0,
  ANALYZE: 0,
  RECOMMEND: 1,
  PREPARE: 2,
});

/**
 * The permission keys no agent may ever act under, whatever its autonomy.
 *
 * The same three CLAUDE.md's second hard constraint separates, and the same three
 * `apps/web/lib/personas.ts` keeps apart across its persona catalogue. Restated here rather than
 * imported because this package must not depend on the web application's policy layer — and
 * `persona-agents.test.ts` in that layer asserts the two lists are identical, so the duplication
 * cannot drift.
 */
export const MONEY_AUTHORITY_KEYS: readonly string[] = Object.freeze([
  'certification-requests:issue',
  'authorization-decisions:approve',
  'payment-instructions:submit',
]);

/**
 * Action classes that would let an agent exercise a money authority.
 *
 * Empty, and that is the assertion. There is no autonomy level at which an agent certifies work,
 * approves a release or submits a payment. If a future action class belongs here, adding it to this
 * list is what makes `autonomy.test.ts` fail — which is the point: the decision becomes visible
 * instead of arriving as a number in a configuration file.
 */
export const MONEY_AUTHORITY_ACTION_CLASSES: readonly AgentActionClass[] = Object.freeze([]);

/** The mandate an agent profile carries, as the dispatcher needs to see it. */
export type AutonomyMandate = {
  readonly autonomyLevel: AutonomyLevel;
  readonly allowedActionClasses: readonly AgentActionClass[];
  readonly maxRisk: AgentTaskRisk;
  /** Roles the dispatching caller must hold at least one of. */
  readonly allowedRoles: readonly string[];
};

export type DispatchRequest = {
  readonly actionClass: AgentActionClass;
  readonly risk: AgentTaskRisk;
  /** Roles the caller holds. */
  readonly roles: readonly string[];
};

export type DispatchVerdict =
  /** Within mandate: route it through the runtime. */
  | { readonly outcome: 'DISPATCH' }
  /**
   * Beyond the mandate but legitimately requested: a person decides.
   *
   * Distinct from `DENY` on purpose. An agent asked to do something its mandate does not stretch to
   * is a scheduling question, and dropping the work would lose it silently — the same failure the
   * flow relay exists to remove. The work is escalated and still happens, with a human on it.
   */
  | { readonly outcome: 'ESCALATE'; readonly reason: EscalationReason }
  /**
   * Not a scheduling question. The request is outside what this agent is *for*, or outside what any
   * agent may do, and no amount of waiting makes it acceptable.
   */
  | { readonly outcome: 'DENY'; readonly reason: DenialReason };

export type EscalationReason = 'AUTONOMY_LEVEL_INSUFFICIENT' | 'TASK_RISK_EXCEEDS_AGENT_MANDATE';

export type DenialReason =
  | 'ACTION_CLASS_NOT_IN_MANDATE'
  | 'CALLER_HOLDS_NO_PERMITTED_ROLE'
  | 'ACTION_CLASS_WOULD_EXERCISE_MONEY_AUTHORITY';

/**
 * Whether this task may be dispatched, escalated or refused.
 *
 * Pure, and separated from the engine that acts on it so the whole matrix can be enumerated in a
 * test rather than sampled through a composition root. The order of the checks is the substance:
 *
 * 1. **Money authority first**, because it is the one answer that must not depend on anything
 *    configurable. A profile misconfigured with a money-bearing class is refused before its
 *    autonomy, risk ceiling or roles are even read.
 * 2. **Mandate and roles next**, as denials: the agent is not for this, or the caller may not ask.
 * 3. **Risk, then autonomy**, as escalations: the request is legitimate and too big for this agent.
 *
 * Risk is checked before autonomy so the reported reason names the binding constraint a reader can
 * act on. When a task is both too risky and above the agent's level, the risk ceiling is the one an
 * operator would have to change first.
 */
export function authorizeDispatch(
  mandate: AutonomyMandate,
  request: DispatchRequest,
): DispatchVerdict {
  if (MONEY_AUTHORITY_ACTION_CLASSES.includes(request.actionClass)) {
    return { outcome: 'DENY', reason: 'ACTION_CLASS_WOULD_EXERCISE_MONEY_AUTHORITY' };
  }
  if (!mandate.allowedActionClasses.includes(request.actionClass)) {
    return { outcome: 'DENY', reason: 'ACTION_CLASS_NOT_IN_MANDATE' };
  }
  if (!request.roles.some((role) => mandate.allowedRoles.includes(role))) {
    return { outcome: 'DENY', reason: 'CALLER_HOLDS_NO_PERMITTED_ROLE' };
  }
  if (RISK_ORDER.indexOf(request.risk) > RISK_ORDER.indexOf(mandate.maxRisk)) {
    return { outcome: 'ESCALATE', reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE' };
  }
  if (mandate.autonomyLevel < REQUIRED_AUTONOMY[request.actionClass]) {
    return { outcome: 'ESCALATE', reason: 'AUTONOMY_LEVEL_INSUFFICIENT' };
  }
  return { outcome: 'DISPATCH' };
}

/**
 * The highest action class a given autonomy level reaches.
 *
 * For reporting a mandate to a person in the terms they set it, rather than making them read the
 * `REQUIRED_AUTONOMY` table backwards.
 */
export function reachableActionClasses(level: AutonomyLevel): AgentActionClass[] {
  return AGENT_ACTION_CLASSES.filter((actionClass) => REQUIRED_AUTONOMY[actionClass] <= level);
}
