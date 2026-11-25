import { describe, expect, it } from 'vitest';
import {
  ASSURAPAY_AGENT_IDENTITIES,
  REQUIRED_AUTONOMY,
  authorizeDispatch,
} from '@assurapay/agent-runtime';
import { MONEY_AUTHORITIES, PERSONAS, persona } from './personas';
import {
  AGENT_RUNTIME_MONEY_KEYS,
  PERSONA_AGENTS,
  agentsFor,
  incoherentMandates,
  overreachingAgents,
  personaAgent,
  personaHoldsMoneyAuthority,
  personasWithoutAgents,
} from './persona-agents';

/**
 * The agent catalogue, as assertions.
 *
 * `ASSURAPAY_AGENT_IDENTITIES` has been a ten-name list with one implementation behind it since it
 * was written. A list of names is a declared capability that does not exist, and the honest way to
 * close that is not to invent nine agents but to say, per agent, which persona's work it assists and
 * how far it may go — then make those claims checkable.
 *
 * The assertion this suite exists for is the last block: there is no configuration of this table
 * under which an agent reaches a money authority, and no agent bound to a persona that holds one may
 * prepare on its behalf.
 */

describe('every declared agent has a mandate', () => {
  it('binds all ten names, and invents none', () => {
    // The roster is the package's list, exactly. An agent here that the runtime does not know is a
    // name with no identity; a name in the runtime with no mandate is the gap this closes.
    expect(PERSONA_AGENTS.map((entry) => entry.agent).sort()).toEqual(
      [...ASSURAPAY_AGENT_IDENTITIES].sort(),
    );
    expect(PERSONA_AGENTS).toHaveLength(10);
  });

  it('names a persona that exists for each one', () => {
    const known = new Set(PERSONAS.map((entry) => entry.id));
    for (const entry of PERSONA_AGENTS) {
      expect(known, `${entry.agent} names ${entry.persona}`).toContain(entry.persona);
      // And `persona()` resolves it, so the binding is usable rather than merely well-typed.
      expect(persona(entry.persona).id).toBe(entry.persona);
    }
  });

  it('says what each agent is for, and why it is its own mandate', () => {
    // Not vacuous: ten agents with empty missions would satisfy the count above.
    for (const entry of PERSONA_AGENTS) {
      expect(entry.mission.length, `${entry.agent} has no mission`).toBeGreaterThan(30);
      expect(entry.rationale.length, `${entry.agent} has no rationale`).toBeGreaterThan(60);
      expect(entry.mandate.allowedActionClasses.length, `${entry.agent} may do nothing`).toBeGreaterThan(0);
      expect(entry.mandate.allowedRoles.length, `${entry.agent} is dispatchable by nobody`).toBeGreaterThan(0);
    }
  });

  it('resolves an agent by name and refuses an unknown one', () => {
    expect(personaAgent('Atlas').persona).toBe('agreement-owner');
    expect(() => personaAgent('Nobody' as never)).toThrow(/unknown agent/);
  });

  it('lets several agents share a persona with separate mandates', () => {
    // Blueprint and DoD both assist the execution lead; Risk and Analytics both assist the auditor.
    // Separate mandates because they make different claims, not because the personas differ.
    expect(agentsFor('execution-lead').map((entry) => entry.agent)).toEqual(['Blueprint', 'DoD']);
    expect(agentsFor('auditor').map((entry) => entry.agent)).toEqual(['Risk', 'Analytics']);
  });

  it('reports the personas with no agent rather than inventing one each', () => {
    // Deliberately a report, not a failure. A persona without an agent is a product decision, and
    // filling the gap for symmetry is how nine fabricated agents get written.
    const unbound = personasWithoutAgents();
    expect(unbound).toContain('approver');
    expect(unbound).toContain('dispute-manager');
    // Every persona named is real.
    const known = new Set(PERSONAS.map((entry) => entry.id));
    for (const id of unbound) expect(known).toContain(id);
  });
});

describe('a mandate never exceeds its own autonomy level', () => {
  it('claims no action class the level cannot reach', () => {
    // A table could say "autonomy 0, may PREPARE" and read as deliberate. It would be refused at
    // dispatch, so the mandate would describe an agent that is quietly useless.
    expect(incoherentMandates()).toEqual([]);
  });

  it('dispatches the lowest class each agent claims, so no mandate is dead on arrival', () => {
    for (const entry of PERSONA_AGENTS) {
      const verdict = authorizeDispatch(entry.mandate, {
        actionClass: 'READ',
        risk: 'LOW',
        roles: [entry.mandate.allowedRoles[0]!],
      });
      expect(verdict.outcome, `${entry.agent} cannot even read`).toBe('DISPATCH');
    }
  });

  it('dispatches every class each mandate claims, at its stated ceiling', () => {
    for (const entry of PERSONA_AGENTS) {
      for (const actionClass of entry.mandate.allowedActionClasses) {
        const verdict = authorizeDispatch(entry.mandate, {
          actionClass,
          risk: entry.mandate.maxRisk,
          roles: [entry.mandate.allowedRoles[0]!],
        });
        expect(verdict.outcome, `${entry.agent}/${actionClass}`).toBe('DISPATCH');
      }
    }
  });
});

describe('no agent acts where its persona moves money', () => {
  it('agrees with `personas.ts` about which keys those are', () => {
    // `agent-runtime` restates the three keys because it must not import this layer. If the two
    // lists ever diverge, the package's ceiling would be guarding a different set from the one the
    // persona catalogue separates.
    expect([...AGENT_RUNTIME_MONEY_KEYS].sort()).toEqual(Object.values(MONEY_AUTHORITIES).sort());
  });

  it('caps every agent whose persona holds a money authority at RECOMMEND', () => {
    // The rule worth stating twice. An agent for `finance` could not submit a payment — no action
    // class does — but it could prepare the instruction its principal then waves through, and a
    // pre-filled instruction is an instruction in all but the clicking.
    expect(overreachingAgents()).toEqual([]);

    // Not vacuous: at least one agent is actually bound to a money-holding persona, so the rule has
    // something to bind. Settlement assists `finance`, which holds `payment-instructions:submit`.
    const exposed = PERSONA_AGENTS.filter((entry) => personaHoldsMoneyAuthority(entry.persona));
    expect(exposed.map((entry) => entry.agent)).toEqual(['Settlement']);
    expect(exposed[0]!.mandate.allowedActionClasses).not.toContain('PREPARE');
  });

  it('never grants an agent a money key, by any route', () => {
    // The mandate carries roles, not permission keys — but a role is how a key is held, so a
    // mandate naming a role that holds all three would reunite them behind the agent. Asserted
    // against the persona catalogue: no persona holds more than one, which `personas.test.ts`
    // enforces, so no single role can carry two.
    for (const entry of PERSONA_AGENTS) {
      const held = Object.values(MONEY_AUTHORITIES).filter((key) =>
        persona(entry.persona).grants.includes(key),
      );
      expect(held.length, `${entry.agent} assists a persona holding ${held.join(' and ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the observers observing', () => {
    // Risk, Analytics and Coordinator read and report. An agent that recommends starts shaping
    // outcomes — which for a risk read means quietly rating counterparties.
    for (const name of ['Risk', 'Analytics', 'Coordinator'] as const) {
      const entry = personaAgent(name);
      expect(entry.mandate.allowedActionClasses, name).toEqual(['READ', 'ANALYZE']);
      expect(entry.mandate.autonomyLevel, name).toBe(0);
      // And the level is consistent with the classes: reading needs none.
      expect(REQUIRED_AUTONOMY.READ).toBe(0);
    }
  });

  it('gives the counterparty-facing agent the lowest risk ceiling of the ten', () => {
    // Advisor is the only agent whose output a customer reads directly.
    const advisor = personaAgent('Advisor');
    expect(advisor.mandate.maxRisk).toBe('LOW');
    expect(advisor.persona).toBe('customer');
  });
});

describe('dispatch refuses a caller the mandate does not name', () => {
  it('denies every agent to a role none of them permit', () => {
    for (const entry of PERSONA_AGENTS) {
      const verdict = authorizeDispatch(entry.mandate, {
        actionClass: 'READ',
        risk: 'LOW',
        roles: ['NOT_A_ROLE_ANY_MANDATE_NAMES'],
      });
      expect(verdict, entry.agent).toEqual({
        outcome: 'DENY',
        reason: 'CALLER_HOLDS_NO_PERMITTED_ROLE',
      });
    }
  });

  it('escalates rather than denying when a task is merely too risky for the agent', () => {
    // Advisor's ceiling is LOW, so a HIGH-risk question about a customer's own agreement goes to a
    // person instead of being dropped.
    const advisor = personaAgent('Advisor');
    const verdict = authorizeDispatch(advisor.mandate, {
      actionClass: 'READ',
      risk: 'HIGH',
      roles: [advisor.mandate.allowedRoles[0]!],
    });
    expect(verdict).toEqual({ outcome: 'ESCALATE', reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE' });
  });
});
