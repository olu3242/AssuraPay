import {
  ASSURAPAY_AGENT_IDENTITIES,
  MONEY_AUTHORITY_KEYS,
  reachableActionClasses,
  type AgentActionClass,
  type AgentTaskRisk,
  type AutonomyLevel,
  type AutonomyMandate,
} from '@assurapay/agent-runtime';
import { MONEY_AUTHORITIES, PERSONAS, persona, type PersonaId } from './personas';

/**
 * The ten agents, bound to the eleven personas that already exist.
 *
 * ## Why this file is in the web policy layer
 *
 * `packages/agent-runtime` owns the autonomy model — levels, action classes, risk ceilings, the
 * dispatch verdict. It must not know about personas, because `personas.ts` is the web application's
 * own policy layer and a package depending on it would invert the dependency. So the *binding* lives
 * here, next to the catalogue it binds to.
 *
 * That placement is the substance of this change rather than a detail. PR #46 introduced a second
 * persona model — thirteen commercial personas in `packages/agent-runtime/src/persona-bootstrap.ts`
 * and `packages/database/src/persona-agent-repository.ts` — and left `personas.ts` untouched. Two
 * persona frameworks in one product is two answers to "who may do this", and the one that loses is
 * the one nobody updates. There is one catalogue, it is `personas.ts`, and these mandates are
 * declared against it.
 *
 * ## An agent assists a persona; it does not become one
 *
 * Each agent is bound to the persona whose work it helps with, and its mandate is narrower than that
 * persona's authority in every case. The persona decides; the agent reads, analyses, recommends and
 * prepares. `autonomy.ts` explains why no action class reaches further than that.
 *
 * ## The one rule worth stating twice
 *
 * **An agent bound to a persona that holds a money authority is capped at `RECOMMEND`.**
 *
 * `approver` holds `authorization-decisions:approve` and `finance` holds
 * `payment-instructions:submit`. An agent for either could not exercise those keys — no action class
 * does — but it could *prepare* the thing its principal then waves through, and a pre-filled
 * approval is an approval in all but the clicking. So those agents advise and stop. The cap is
 * asserted in `persona-agents.test.ts` rather than left to whoever edits the table next.
 */

export type AgentName = (typeof ASSURAPAY_AGENT_IDENTITIES)[number];

export type PersonaAgent = {
  readonly agent: AgentName;
  /** The persona whose work this agent assists. */
  readonly persona: PersonaId;
  /** What it is for, in one sentence, in the product's own language. */
  readonly mission: string;
  readonly mandate: AutonomyMandate;
  /** Why this agent exists as a distinct mandate rather than a setting on another. */
  readonly rationale: string;
};

/** Read and analyse only: the mandate of an agent that may look and report, and change nothing. */
const OBSERVER: AutonomyMandate = Object.freeze({
  autonomyLevel: 0 satisfies AutonomyLevel,
  allowedActionClasses: Object.freeze(['READ', 'ANALYZE'] as AgentActionClass[]),
  maxRisk: 'CRITICAL' satisfies AgentTaskRisk,
  allowedRoles: Object.freeze(['ASSURANCE_ANALYST', 'WORKSPACE_ADMINISTRATOR']),
});

/** Reads, analyses and recommends. The ceiling for any agent whose persona can move money. */
function advisor(roles: readonly string[], maxRisk: AgentTaskRisk = 'HIGH'): AutonomyMandate {
  return Object.freeze({
    autonomyLevel: 1 satisfies AutonomyLevel,
    allowedActionClasses: Object.freeze(['READ', 'ANALYZE', 'RECOMMEND'] as AgentActionClass[]),
    maxRisk,
    allowedRoles: Object.freeze([...roles]),
  });
}

/** Also prepares: drafts and stages work a person then decides on. */
function preparer(roles: readonly string[], maxRisk: AgentTaskRisk = 'MEDIUM'): AutonomyMandate {
  return Object.freeze({
    autonomyLevel: 2 satisfies AutonomyLevel,
    allowedActionClasses: Object.freeze([
      'READ',
      'ANALYZE',
      'RECOMMEND',
      'PREPARE',
    ] as AgentActionClass[]),
    maxRisk,
    allowedRoles: Object.freeze([...roles]),
  });
}

export const PERSONA_AGENTS: readonly PersonaAgent[] = Object.freeze([
  {
    agent: 'Atlas',
    persona: 'agreement-owner',
    mission: 'Reads a contract and reports what it commits each party to.',
    mandate: preparer(['CONTRACT_AUTHOR', 'ASSURANCE_ANALYST']),
    rationale:
      'The one agent that already exists and runs. Bound to the agreement owner because contract ' +
      'analysis is that persona’s work, and capped at preparing a draft the owner still submits.',
  },
  {
    agent: 'Blueprint',
    persona: 'execution-lead',
    mission: 'Drafts a performance blueprint and its milestones from an executed agreement.',
    mandate: preparer(['PERFORMANCE_PLANNER']),
    rationale:
      'Planning is the execution lead’s work and is reversible until activated, so a prepared ' +
      'blueprint is useful and safe. Activation stays with the planner.',
  },
  {
    agent: 'DoD',
    persona: 'execution-lead',
    mission: 'Proposes a definition of done, with the evidence each criterion would need.',
    mandate: preparer(['PERFORMANCE_PLANNER', 'EXECUTION_MANAGER']),
    rationale:
      'Distinct from Blueprint because a definition of done is what later certification is judged ' +
      'against: it is drafted once and then frozen, so it earns its own mandate and its own prompt.',
  },
  {
    agent: 'Evidence',
    persona: 'supplier',
    mission: 'Assembles the evidence a milestone’s definition of done asks for.',
    mandate: preparer(['EXECUTION_MANAGER']),
    rationale:
      'Bound to the supplier because it is the supplier’s evidence. It may gather and stage; it may ' +
      'not accept, which is the reviewer’s act and a different persona entirely.',
  },
  {
    agent: 'Validation',
    persona: 'reviewer',
    mission: 'Checks submitted evidence against the definition of done and reports the gaps.',
    mandate: advisor(['EXECUTION_MANAGER', 'CERTIFIER']),
    rationale:
      'Capped at recommending rather than preparing. A prepared acceptance decision is an ' +
      'acceptance in all but the clicking, and acceptance is what certification rests on.',
  },
  {
    agent: 'Risk',
    persona: 'auditor',
    mission: 'Reports counterparty and transaction risk from the records, without scoring a party.',
    mandate: OBSERVER,
    rationale:
      'An observer, deliberately. Risk work that recommends starts shaping who gets paid, and this ' +
      'platform has no appetite for an agent that quietly rates counterparties.',
  },
  {
    agent: 'Settlement',
    persona: 'finance',
    mission: 'Explains what a settlement is waiting on, and what would unblock it.',
    mandate: advisor(['PAYMENT_OPERATOR', 'SETTLEMENT_APPROVER'], 'MEDIUM'),
    rationale:
      'Bound to the persona that holds `payment-instructions:submit`, so it is capped at ' +
      'recommending: it may say why money has not moved and may not stage the instruction that ' +
      'moves it.',
  },
  {
    agent: 'Analytics',
    persona: 'auditor',
    mission: 'Derives reporting from records that already exist, and cites the rows.',
    mandate: OBSERVER,
    rationale:
      'An observer because reporting that prepares anything stops being reporting. Shares the ' +
      'auditor persona with Risk and keeps its own prompt, because a figure and a risk read are ' +
      'different claims.',
  },
  {
    agent: 'Advisor',
    persona: 'customer',
    mission: 'Answers a counterparty’s questions about their own agreement and its progress.',
    mandate: advisor(['EXECUTION_MANAGER'], 'LOW'),
    rationale:
      'The only agent bound to a counterparty persona, and the only one whose output a customer ' +
      'reads directly — so its risk ceiling is the lowest of the ten.',
  },
  {
    agent: 'Coordinator',
    persona: 'workspace-administrator',
    mission: 'Reports which journeys are stalled and what each is waiting on.',
    mandate: OBSERVER,
    rationale:
      'An observer over the flow relay’s own state. It reports stalls; the relay advances what it ' +
      'can and a person resolves the rest. An agent that could unstick a journey would be deciding ' +
      'what the stall was protecting.',
  },
]);

export function personaAgent(agent: AgentName): PersonaAgent {
  const found = PERSONA_AGENTS.find((entry) => entry.agent === agent);
  if (!found) throw new Error(`unknown agent: ${agent}`);
  return found;
}

/** The agents bound to one persona. Several may share a persona and keep separate mandates. */
export function agentsFor(id: PersonaId): PersonaAgent[] {
  return PERSONA_AGENTS.filter((entry) => entry.persona === id);
}

/** Whether this agent's persona can itself move money, which is what caps the agent at RECOMMEND. */
export function personaHoldsMoneyAuthority(id: PersonaId): boolean {
  const held = new Set(persona(id).grants);
  return Object.values(MONEY_AUTHORITIES).some((key) => held.has(key));
}

/**
 * Agents whose mandate exceeds what their persona should delegate — always empty.
 *
 * The companion to `inventedPermissionKeys()` in `personas.ts`: a derived list that must stay empty,
 * so the rule is enforced by a build rather than by whoever reads the table next.
 */
export function overreachingAgents(): string[] {
  return PERSONA_AGENTS.filter(
    (entry) =>
      personaHoldsMoneyAuthority(entry.persona) && entry.mandate.allowedActionClasses.includes('PREPARE'),
  ).map((entry) => `${entry.agent} prepares for ${entry.persona}, which can move money`);
}

/** Mandates that claim an action class their own autonomy level does not reach — always empty. */
export function incoherentMandates(): string[] {
  return PERSONA_AGENTS.flatMap((entry) => {
    const reachable = new Set(reachableActionClasses(entry.mandate.autonomyLevel));
    return entry.mandate.allowedActionClasses
      .filter((actionClass) => !reachable.has(actionClass))
      .map(
        (actionClass) =>
          `${entry.agent} allows ${actionClass} at autonomy ${entry.mandate.autonomyLevel}, which cannot reach it`,
      );
  });
}

/** Personas with no agent. Reported rather than forbidden: not every persona needs one. */
export function personasWithoutAgents(): PersonaId[] {
  const bound = new Set(PERSONA_AGENTS.map((entry) => entry.persona));
  return PERSONAS.map((entry) => entry.id).filter((id) => !bound.has(id));
}

/**
 * The money authorities, as both packages name them.
 *
 * `agent-runtime` restates the three keys because it must not import this layer. This re-export is
 * what `persona-agents.test.ts` compares, so the two lists cannot drift apart silently.
 */
export const AGENT_RUNTIME_MONEY_KEYS = MONEY_AUTHORITY_KEYS;
