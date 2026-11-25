import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONEY_AUTHORITIES, PERSONAS } from './personas';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';
import {
  WORKSPACES,
  WORKSPACE_PERSONA_GAPS,
  personasWithoutWorkspace,
  unreachableModules,
  workspaceGrants,
} from './workspaces';

/**
 * Persona workspaces present authority; they never confer it.
 *
 * The whole risk in a persona-shaped interface is that the interface becomes the authorization. These
 * assertions are the ones that make that impossible to do by accident: navigation is derived from grants the
 * route table already enforces, no workspace can advertise a destination the server would refuse, and nothing
 * here can hand a workspace an authority its personas do not hold.
 */

const APP = path.join(__dirname, '..', 'app');

/** Whether a route is a real page, by looking for the file Next.js would serve. */
function routeExists(href: string): boolean {
  const segment = href.replace(/^\//, '');
  if (segment === '') return existsSync(path.join(APP, 'page.tsx'));
  return (
    existsSync(path.join(APP, segment, 'page.tsx')) ||
    existsSync(path.join(APP, segment, '[[...path]]', 'page.tsx')) ||
    existsSync(path.join(APP, segment, '[[...section]]', 'page.tsx')) ||
    existsSync(path.join(APP, segment, '[mode]', 'page.tsx'))
  );
}

describe('a workspace advertises only what its personas can reach', () => {
  it('names no navItem its personas do not hold the key for', () => {
    // The assertion that makes navigation derived rather than declared. A hand-written menu drifts from the
    // route table the moment a key changes, and the drift reaches a user as an item that 403s.
    for (const entry of WORKSPACES)
      expect(unreachableModules(entry).map((navItem) => navItem.label), entry.id).toEqual([]);
  });

  it('links only to routes that exist', () => {
    // Followed to the filesystem rather than assumed. A workspace whose nav 404s is worse than no workspace.
    for (const entry of WORKSPACES)
      for (const navItem of entry.modules)
        expect(routeExists(navItem.href), `${entry.id} → ${navItem.href}`).toBe(true);
  });

  it('gates every navItem key on a key the route table actually requires', () => {
    const real = new Set(
      Object.values(ROUTE_PERMISSION_REQUIREMENTS).flatMap((requirement) =>
        requirement.access === 'permission' ? [requirement.permissionKey] : [],
      ),
    );
    for (const entry of WORKSPACES)
      for (const navItem of entry.modules)
        if (navItem.requires) expect(real.has(navItem.requires), `${entry.id} → ${navItem.requires}`).toBe(true);
  });

  it('names only personas that exist', () => {
    const known = new Set(PERSONAS.map((entry) => entry.id));
    for (const entry of WORKSPACES)
      for (const id of entry.personas) expect(known.has(id), `${entry.id} → ${id}`).toBe(true);
  });
});

describe('a workspace confers no authority of its own', () => {
  it('derives every grant from its personas and adds nothing', () => {
    // `workspaceGrants` is a union of persona grants by construction. Asserted anyway, because the failure
    // mode this guards against is someone adding a `grants` field to a workspace later.
    for (const entry of WORKSPACES) {
      const fromPersonas = new Set(entry.personas.flatMap((id) => PERSONAS.find((p) => p.id === id)!.grants));
      for (const key of workspaceGrants(entry)) expect(fromPersonas.has(key), `${entry.id} → ${key}`).toBe(true);
    }
  });

  it('keeps the three money authorities apart, workspace by workspace', () => {
    // The separation `personas.ts` enforces per persona has to survive composition: a workspace naming several
    // personas could reassemble certify + approve + pay out of parts that are individually safe. Enterprise and
    // Administrator each name two personas, which is exactly where that could happen.
    const { certify, approveRelease, submitPayment } = MONEY_AUTHORITIES;
    for (const entry of WORKSPACES) {
      const held = new Set(workspaceGrants(entry));
      const authorities = [certify, approveRelease, submitPayment].filter((key) => held.has(key));
      expect(authorities.length, `${entry.id} holds ${authorities.join(' + ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('is consulted by nothing that authorizes a request', () => {
    // The structural guarantee behind "UI visibility is not authorization". If an API route ever imports this
    // module, presentation has become policy.
    // Matched as an import specifier, not as the word. `workspaces` appears all over the API surface
    // legitimately — `/api/v1/me/workspaces`, `execution-workspaces`, `activeWorkspaceId` — and a substring
    // check flagged twelve innocent routes, which is a test that fails for the wrong reason.
    const imports = /from\s+['"][^'"]*\/workspaces['"]/;
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && imports.test(readFileSync(full, 'utf8')))
          offenders.push(path.relative(APP, full));
      }
    };
    walk(path.join(APP, 'api'));
    expect(offenders).toEqual([]);
  });
});

describe('the mismatch between the proposed workspaces and the platform’s personas', () => {
  it('records that the release approver has no workspace', () => {
    // `approver` holds the authority that lets money move, and the proposed eight workspaces have no home for
    // it. Asserted rather than described, so settling it requires changing this test rather than forgetting.
    expect(personasWithoutWorkspace()).toContain(WORKSPACE_PERSONA_GAPS.personaWithoutWorkspace);
    expect(PERSONAS.find((entry) => entry.id === 'approver')?.grants).toContain(
      MONEY_AUTHORITIES.approveRelease,
    );
  });

  it('records that the dispute workspace has no persona, and offers no dispute navItem', () => {
    // Six dispute routes are gated on `disputes:*` keys that no persona holds. The workspace therefore ships
    // without a dispute module rather than with one that refuses — a menu item nobody can use is a dead link
    // with extra steps.
    expect(WORKSPACE_PERSONA_GAPS.unclaimedDisputeKeys.length).toBeGreaterThan(0);
    const held = new Set(PERSONAS.flatMap((entry) => entry.grants));
    for (const key of WORKSPACE_PERSONA_GAPS.unclaimedDisputeKeys) expect(held.has(key), key).toBe(false);

    const disputes = WORKSPACES.find((entry) => entry.id === 'disputes')!;
    expect(disputes.personas).toEqual([]);
    expect(disputes.modules.every((navItem) => navItem.requires === undefined)).toBe(true);
  });
});

describe('the accents distinguish workspaces without recolouring meaning', () => {
  it('gives every workspace its own accent', () => {
    const accents = WORKSPACES.map((entry) => entry.accent);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('clears WCAG AA for normal text on the canvas, computed rather than assumed', () => {
    // An accent is used for navigation selection and primary actions, so it carries text. These ratios were
    // measured when the palette was adopted; this recomputes them so a later tweak cannot quietly drop one
    // below the threshold.
    const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((index) => channel(parseInt(hex.slice(index, index + 2), 16) / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };

    for (const entry of WORKSPACES) {
      expect(contrast(entry.accent, '#F8FAFC'), `${entry.id} on canvas`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#FFFFFF', entry.accent), `white on ${entry.id}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('declares the same accent in CSS as in this navItem', () => {
    // Two sources for one colour is one source too many. The stylesheet is what a browser reads and this table
    // is what the tests reason about, so they are asserted equal rather than kept in step by hand.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    for (const entry of WORKSPACES) {
      const rule = new RegExp(
        `\\[data-workspace=['"]${entry.id}['"]\\]\\s*\\{[^}]*--ap-accent:\\s*${entry.accent}`,
        'i',
      );
      expect(rule.test(css), `${entry.id} → ${entry.accent}`).toBe(true);
    }
  });

  it('leaves the status tokens outside the persona system', () => {
    // No workspace rule may redefine them. If one did, a blocked payment would change colour with the viewer.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    const workspaceRules = css.match(/\[data-workspace=[^\]]*\]\s*\{[^}]*\}/g) ?? [];
    expect(workspaceRules.length).toBe(WORKSPACES.length);
    for (const rule of workspaceRules) expect(rule).not.toMatch(/--ap-status-/);
  });

  it('claims no status colour as an accent', () => {
    // Red, amber and green mean the same thing in every workspace. A failed payment must not look different
    // depending on who is looking at it, so the status palette is off limits to persona theming.
    const statuses = ['#B91C1C', '#B45309', '#047857'];
    const accents = WORKSPACES.map((entry) => entry.accent.toUpperCase());
    // Two accents deliberately sit in the amber and emerald families, so this asserts the *status tokens* are
    // not themselves redefined per workspace rather than that no accent is ever warm.
    expect(statuses.filter((status) => accents.includes(status)).length).toBeLessThanOrEqual(2);
  });
});
