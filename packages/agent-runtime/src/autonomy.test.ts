import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTION_CLASSES,
  AUTONOMY_LEVELS,
  MONEY_AUTHORITY_ACTION_CLASSES,
  MONEY_AUTHORITY_KEYS,
  REQUIRED_AUTONOMY,
  RISK_ORDER,
  authorizeDispatch,
  reachableActionClasses,
  type AgentActionClass,
  type AgentTaskRisk,
  type AutonomyLevel,
  type AutonomyMandate,
} from './autonomy';

/**
 * The autonomy model, enumerated rather than sampled.
 *
 * The decision function is pure precisely so this suite can walk the entire matrix — every action
 * class against every autonomy level against every risk — instead of testing the three cases that
 * happened to come to mind. A gap in an authorization table is not the kind of thing spot checks
 * find.
 *
 * The assertion that matters most is the last block: there is no configuration of autonomy, risk or
 * role under which an agent exercises a money authority. PR #46's version had an
 * `EXECUTE_POLICY_BOUND` class at autonomy 4 and defended it on the grounds that dispatch is not
 * state mutation. That is true and insufficient, and this is what replaces the argument.
 */

const ROLE = 'ANALYST';

function mandate(over: Partial<AutonomyMandate> = {}): AutonomyMandate {
  return {
    autonomyLevel: 5,
    allowedActionClasses: [...AGENT_ACTION_CLASSES],
    maxRisk: 'CRITICAL',
    allowedRoles: [ROLE],
    ...over,
  };
}

describe('no autonomy level reaches a money authority', () => {
  it('maps no action class to one, which is the whole ceiling', () => {
    // The list is empty and that is the assertion. Adding an entry is what makes the next test fail,
    // so the decision surfaces as a failing build rather than as a number in a config file.
    expect(MONEY_AUTHORITY_ACTION_CLASSES).toEqual([]);
  });

  it('offers no action class whose name promises execution', () => {
    // #46 had `EXECUTE_REVERSIBLE` and `EXECUTE_POLICY_BOUND`. An action class named *execute*,
    // reachable by raising a number, is an invitation — and the invariant it leaned on lived in a
    // different package from the number that unlocked it.
    for (const actionClass of AGENT_ACTION_CLASSES) {
      expect(actionClass, `${actionClass} promises execution`).not.toMatch(/EXECUTE/);
    }
    expect([...AGENT_ACTION_CLASSES]).toEqual(['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE']);
  });

  it('names the three authorities CLAUDE.md separates', () => {
    expect([...MONEY_AUTHORITY_KEYS].sort()).toEqual([
      'authorization-decisions:approve',
      'certification-requests:issue',
      'payment-instructions:submit',
    ]);
  });

  it('refuses a money-bearing class before reading anything configurable', () => {
    // Proved by construction rather than by example, since no such class exists to pass in: the
    // check is first, so a profile misconfigured with one is refused before its autonomy, risk
    // ceiling or roles are consulted. Asserted by giving the widest possible mandate a class the
    // mandate does not contain, and confirming the denial is about the mandate — then confirming
    // the money check would have won had the class been money-bearing.
    const verdict = authorizeDispatch(mandate({ allowedActionClasses: [] }), {
      actionClass: 'READ',
      risk: 'LOW',
      roles: [ROLE],
    });
    expect(verdict).toEqual({ outcome: 'DENY', reason: 'ACTION_CLASS_NOT_IN_MANDATE' });

    // And the ordering: with a money-bearing class present, that reason would come first. Simulated
    // against the real function by checking the list it consults is the first thing it reads.
    const source = authorizeDispatch.toString();
    expect(source.indexOf('MONEY_AUTHORITY_ACTION_CLASSES')).toBeLessThan(
      source.indexOf('allowedActionClasses'),
    );
  });

  it('cannot be widened by the highest autonomy and the widest mandate', () => {
    // The exhaustive form of the claim: at level 5, every class, every risk, nothing dispatched is
    // anything but read, analyse, recommend or prepare.
    for (const actionClass of AGENT_ACTION_CLASSES) {
      for (const risk of RISK_ORDER) {
        const verdict = authorizeDispatch(mandate(), { actionClass, risk, roles: [ROLE] });
        expect(verdict.outcome, `${actionClass}/${risk}`).toBe('DISPATCH');
      }
    }
    // Which is only meaningful because the set is bounded.
    expect(AGENT_ACTION_CLASSES).toHaveLength(4);
  });
});

describe('autonomy gates the action class', () => {
  it('requires a level for each class, and none for looking', () => {
    expect(REQUIRED_AUTONOMY).toEqual({ READ: 0, ANALYZE: 0, RECOMMEND: 1, PREPARE: 2 });
  });

  it('escalates every class above the level, across the whole matrix', () => {
    for (const level of AUTONOMY_LEVELS) {
      for (const actionClass of AGENT_ACTION_CLASSES) {
        const verdict = authorizeDispatch(mandate({ autonomyLevel: level }), {
          actionClass,
          risk: 'LOW',
          roles: [ROLE],
        });
        const expected = level >= REQUIRED_AUTONOMY[actionClass] ? 'DISPATCH' : 'ESCALATE';
        expect(verdict.outcome, `level ${level} / ${actionClass}`).toBe(expected);
        if (verdict.outcome === 'ESCALATE') {
          expect(verdict.reason).toBe('AUTONOMY_LEVEL_INSUFFICIENT');
        }
      }
    }
  });

  it('lets a level-0 agent read and analyse but not recommend', () => {
    // The one case worth stating in prose: an agent that can only look is still useful, and gating
    // that behind a level would make a level-0 agent unable to report anything at all.
    const zero = mandate({ autonomyLevel: 0 });
    expect(authorizeDispatch(zero, { actionClass: 'READ', risk: 'LOW', roles: [ROLE] }).outcome).toBe(
      'DISPATCH',
    );
    expect(
      authorizeDispatch(zero, { actionClass: 'ANALYZE', risk: 'LOW', roles: [ROLE] }).outcome,
    ).toBe('DISPATCH');
    expect(
      authorizeDispatch(zero, { actionClass: 'RECOMMEND', risk: 'LOW', roles: [ROLE] }).outcome,
    ).toBe('ESCALATE');
  });

  it('reports the classes a level reaches, so a mandate can be read back', () => {
    expect(reachableActionClasses(0)).toEqual(['READ', 'ANALYZE']);
    expect(reachableActionClasses(1)).toEqual(['READ', 'ANALYZE', 'RECOMMEND']);
    expect(reachableActionClasses(2)).toEqual(['READ', 'ANALYZE', 'RECOMMEND', 'PREPARE']);
    // Levels above 2 reach nothing further today, which is headroom rather than capability.
    expect(reachableActionClasses(5)).toEqual(reachableActionClasses(2));
  });
});

describe('the risk ceiling binds independently of autonomy', () => {
  it('escalates anything above the ceiling, at every level', () => {
    for (const ceiling of RISK_ORDER) {
      for (const risk of RISK_ORDER) {
        const verdict = authorizeDispatch(mandate({ maxRisk: ceiling }), {
          actionClass: 'READ',
          risk,
          roles: [ROLE],
        });
        const tooRisky = RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(ceiling);
        expect(verdict.outcome, `ceiling ${ceiling} / risk ${risk}`).toBe(
          tooRisky ? 'ESCALATE' : 'DISPATCH',
        );
      }
    }
  });

  it('names the risk ceiling when both risk and autonomy are exceeded', () => {
    // Deliberate ordering: the reported reason should be the constraint an operator would have to
    // change first, and that is the ceiling.
    const verdict = authorizeDispatch(mandate({ autonomyLevel: 0, maxRisk: 'LOW' }), {
      actionClass: 'PREPARE',
      risk: 'CRITICAL',
      roles: [ROLE],
    });
    expect(verdict).toEqual({ outcome: 'ESCALATE', reason: 'TASK_RISK_EXCEEDS_AGENT_MANDATE' });
  });

  it('keeps a narrow-risk agent useful at a wide action class', () => {
    // Risk and kind are separate axes, which is the reason for having both: an agent may prepare
    // freely and only on low-risk work.
    const narrow = mandate({ maxRisk: 'LOW' });
    expect(
      authorizeDispatch(narrow, { actionClass: 'PREPARE', risk: 'LOW', roles: [ROLE] }).outcome,
    ).toBe('DISPATCH');
  });
});

describe('denial and escalation are different answers', () => {
  it('denies a class outside the mandate rather than escalating it', () => {
    // The agent is not *for* this. Waiting does not make it acceptable, so there is nobody to
    // escalate to — unlike a task that is merely too big.
    const verdict = authorizeDispatch(mandate({ allowedActionClasses: ['READ'] }), {
      actionClass: 'PREPARE',
      risk: 'LOW',
      roles: [ROLE],
    });
    expect(verdict).toEqual({ outcome: 'DENY', reason: 'ACTION_CLASS_NOT_IN_MANDATE' });
  });

  it('denies a caller holding none of the permitted roles', () => {
    const verdict = authorizeDispatch(mandate(), {
      actionClass: 'READ',
      risk: 'LOW',
      roles: ['SOMEONE_ELSE'],
    });
    expect(verdict).toEqual({ outcome: 'DENY', reason: 'CALLER_HOLDS_NO_PERMITTED_ROLE' });
  });

  it('denies a caller holding no role at all', () => {
    const verdict = authorizeDispatch(mandate(), { actionClass: 'READ', risk: 'LOW', roles: [] });
    expect(verdict).toEqual({ outcome: 'DENY', reason: 'CALLER_HOLDS_NO_PERMITTED_ROLE' });
  });

  it('accepts a caller holding any one of the permitted roles', () => {
    const verdict = authorizeDispatch(mandate({ allowedRoles: ['A', 'B'] }), {
      actionClass: 'READ',
      risk: 'LOW',
      roles: ['C', 'B'],
    });
    expect(verdict.outcome).toBe('DISPATCH');
  });

  it('checks the mandate before the roles, so the clearer refusal wins', () => {
    // Both are denials, so the order does not change the outcome — only which reason a reader is
    // handed. "This agent does not do that" is more useful than "you may not ask this agent".
    const verdict = authorizeDispatch(mandate({ allowedActionClasses: ['READ'] }), {
      actionClass: 'PREPARE',
      risk: 'LOW',
      roles: ['NOBODY'],
    });
    expect(verdict).toEqual({ outcome: 'DENY', reason: 'ACTION_CLASS_NOT_IN_MANDATE' });
  });
});

describe('the verdict is total', () => {
  it('returns a verdict for every combination, and never throws', () => {
    // #46 threw for mandate and role failures and returned for risk and autonomy ones. A function
    // that sometimes throws and sometimes returns makes every caller handle two shapes, and the one
    // they forget is the throw.
    const levels: AutonomyLevel[] = [...AUTONOMY_LEVELS];
    const classes: AgentActionClass[] = [...AGENT_ACTION_CLASSES];
    const risks: AgentTaskRisk[] = [...RISK_ORDER];
    let considered = 0;
    for (const level of levels) {
      for (const allowed of [classes, ['READ'] as AgentActionClass[], []]) {
        for (const actionClass of classes) {
          for (const risk of risks) {
            for (const roles of [[ROLE], [], ['OTHER']]) {
              const verdict = authorizeDispatch(
                mandate({ autonomyLevel: level, allowedActionClasses: allowed }),
                { actionClass, risk, roles },
              );
              expect(['DISPATCH', 'ESCALATE', 'DENY']).toContain(verdict.outcome);
              considered += 1;
            }
          }
        }
      }
    }
    // 6 levels × 3 mandates × 4 classes × 4 risks × 3 role sets.
    expect(considered).toBe(6 * 3 * 4 * 4 * 3);
  });
});
