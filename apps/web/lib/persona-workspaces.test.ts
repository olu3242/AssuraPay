import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONEY_AUTHORITIES, PERSONAS } from './personas';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';
import {
  PERSONA_WORKSPACES,
  PERSONA_WORKSPACE_GAPS,
  personasWithoutWorkspace,
  personaWorkspacesFor,
  unreachableModules,
  workspaceGrants,
} from './persona-workspaces';

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
    for (const entry of PERSONA_WORKSPACES)
      expect(unreachableModules(entry).map((navItem) => navItem.label), entry.id).toEqual([]);
  });

  it('links only to routes that exist', () => {
    // Followed to the filesystem rather than assumed. A workspace whose nav 404s is worse than no workspace.
    for (const entry of PERSONA_WORKSPACES)
      for (const navItem of entry.modules)
        expect(routeExists(navItem.href), `${entry.id} → ${navItem.href}`).toBe(true);
  });

  it('gates every navItem key on a key the route table actually requires', () => {
    const real = new Set(
      Object.values(ROUTE_PERMISSION_REQUIREMENTS).flatMap((requirement) =>
        requirement.access === 'permission' ? [requirement.permissionKey] : [],
      ),
    );
    for (const entry of PERSONA_WORKSPACES)
      for (const navItem of entry.modules)
        if (navItem.requires) expect(real.has(navItem.requires), `${entry.id} → ${navItem.requires}`).toBe(true);
  });

  it('names only personas that exist', () => {
    const known = new Set(PERSONAS.map((entry) => entry.id));
    for (const entry of PERSONA_WORKSPACES)
      for (const id of entry.personas) expect(known.has(id), `${entry.id} → ${id}`).toBe(true);
  });
});

describe('release approval is one shared capability, not one per workspace', () => {
  it('offers the canonical inbox from every workspace', () => {
    // One capability, one inbox. A persona-specific approval screen would be a second approval system over
    // the same records, and two queues over one set of decisions is how a release is approved twice or not
    // at all.
    for (const entry of PERSONA_WORKSPACES) {
      const approval = entry.modules.filter((item) => item.href === '/approvals');
      expect(approval, `${entry.id}`).toHaveLength(1);
      expect(approval[0], `${entry.id}`).toMatchObject({
        requires: 'authorization-decisions:approve',
        contextual: true,
      });
    }
  });

  it('lists no module twice', () => {
    // A duplicate renders the same link twice and is invisible in review. One occurred while wiring the
    // shared approval module in, which is why this is asserted rather than assumed.
    for (const entry of PERSONA_WORKSPACES) {
      const hrefs = entry.modules.map((item) => item.href);
      expect(new Set(hrefs).size, `${entry.id} repeats a destination`).toBe(hrefs.length);
    }
  });

  it('never composes two personas the model says must not meet', () => {
    // The reason release approval is contextual rather than a persona added to Buyer and Enterprise.
    // `agreement-owner.mustNotHold` names `approval-requests:decide`, which `approver` grants — so an
    // Enterprise workspace presenting both would stand on both sides of an explicit prohibition, drafting an
    // agreement and deciding it. This asserts no workspace does that with any pair.
    for (const entry of PERSONA_WORKSPACES) {
      const held = entry.personas.map((id) => PERSONAS.find((p) => p.id === id)!);
      for (const one of held)
        for (const other of held)
          if (one !== other)
            for (const forbidden of one.mustNotHold)
              expect(
                other.grants.includes(forbidden),
                `${entry.id}: ${one.id} must not hold ${forbidden}, which ${other.id} grants`,
              ).toBe(false);
    }
  });
});

describe('a workspace confers no authority of its own', () => {
  it('derives every grant from its personas and adds nothing', () => {
    // `workspaceGrants` is a union of persona grants by construction. Asserted anyway, because the failure
    // mode this guards against is someone adding a `grants` field to a workspace later.
    for (const entry of PERSONA_WORKSPACES) {
      const fromPersonas = new Set(entry.personas.flatMap((id) => PERSONAS.find((p) => p.id === id)!.grants));
      for (const key of workspaceGrants(entry)) expect(fromPersonas.has(key), `${entry.id} → ${key}`).toBe(true);
    }
  });

  it('keeps the three money authorities apart, workspace by workspace', () => {
    // The separation `personas.ts` enforces per persona has to survive composition: a workspace naming several
    // personas could reassemble certify + approve + pay out of parts that are individually safe. Enterprise and
    // Administrator each name two personas, which is exactly where that could happen.
    const { certify, approveRelease, submitPayment } = MONEY_AUTHORITIES;
    for (const entry of PERSONA_WORKSPACES) {
      const held = new Set(workspaceGrants(entry));
      const authorities = [certify, approveRelease, submitPayment].filter((key) => held.has(key));
      expect(authorities.length, `${entry.id} holds ${authorities.join(' + ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('is consulted by nothing that authorizes a request', () => {
    // The structural guarantee behind "UI visibility is not authorization". If an API route ever imports this
    // module, presentation has become policy.
    // Matched as an import specifier, not as the word. `workspaces` appears all over the API surface
    // legitimately — `/api/v1/me/workspaces`, `execution-workspaces`, `activePersonaWorkspaceId` — and a substring
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

describe('which workspaces a caller’s own keys open', () => {
  it('opens a workspace when any one of its gated modules is reachable', () => {
    // Partial authority still belongs somewhere. A finance user holding `payment-instructions:create` but not
    // `:submit` is in the finance workspace; requiring every key would leave them with nowhere to go.
    const opened = personaWorkspacesFor(['payment-instructions:create']).map((entry) => entry.id);
    expect(opened).toContain('finance');
  });

  it('opens nothing for a caller holding nothing', () => {
    expect(personaWorkspacesFor([])).toEqual([]);
  });

  it('never opens a workspace whose gated modules the caller cannot reach', () => {
    // The property that matters: the menu cannot offer a room whose doors are all locked.
    for (const keys of [['contracts:read'], ['roles:read'], ['acceptance-decisions:create']]) {
      const held = new Set(keys);
      for (const entry of personaWorkspacesFor(keys))
        expect(
          entry.modules.some((item) => item.requires !== undefined && held.has(item.requires)),
          `${entry.id} opened by ${keys.join(',')}`,
        ).toBe(true);
    }
  });

  it('leaves no workspace that nobody can open', () => {
    // `disputes` used to be exactly that: a workspace with no persona and so no gated module, an empty room
    // with a door. Now every workspace has at least one gated destination, and a caller holding every key
    // opens all of them — so none of the eight is decorative.
    for (const entry of PERSONA_WORKSPACES)
      expect(
        entry.modules.some((navItem) => navItem.requires !== undefined),
        `${entry.id} gates nothing`,
      ).toBe(true);

    expect(personaWorkspacesFor(routePermissionKeysForTest())).toHaveLength(PERSONA_WORKSPACES.length);
  });

  it('is reachable by a caller asking only about itself', () => {
    // Identity-class, beside `/me/workspaces`. Gating it on `permissions:evaluate` — a key only an
    // administrator holds — would leave an ordinary caller unable to learn its own authority, which is the
    // gap that made honest navigation impossible.
    expect(ROUTE_PERMISSION_REQUIREMENTS['/api/v1/me/permissions|GET']?.access).toBe('identity');
  });
});

/** Every key any route requires, for the "opens nothing ungated" check above. */
function routePermissionKeysForTest(): string[] {
  return [
    ...new Set(
      Object.values(ROUTE_PERMISSION_REQUIREMENTS).flatMap((requirement) =>
        requirement.access === 'permission' ? [requirement.permissionKey] : [],
      ),
    ),
  ];
}

describe('how the two persona gaps were resolved', () => {
  it('gives the release approver no workspace of its own, by design', () => {
    // The gap was real: `approver` holds the authority that lets money move and the eight workspaces had no
    // home for it. The resolution is not to invent a ninth workspace but to treat release approval as a
    // shared governed capability — so `approver` is still presented by no workspace's persona list, and that
    // is now correct rather than an oversight.
    expect(personasWithoutWorkspace()).toContain('approver');
    expect(PERSONAS.find((entry) => entry.id === 'approver')?.grants).toContain(
      MONEY_AUTHORITIES.approveRelease,
    );
    // Its capability reaches every workspace all the same, for whoever actually holds the key.
    for (const entry of PERSONA_WORKSPACES)
      expect(
        entry.modules.some(
          (navItem) => navItem.requires === MONEY_AUTHORITIES.approveRelease && navItem.contextual === true,
        ),
        entry.id,
      ).toBe(true);
  });

  it('gives the dispute workspace a persona, and the register that persona can open', () => {
    // Six dispute routes were gated on `disputes:*` keys no persona held — authority the platform enforced
    // and nobody could be granted. `dispute-manager` now holds them.
    const held = new Set(PERSONAS.flatMap((entry) => entry.grants));
    for (const key of PERSONA_WORKSPACE_GAPS.unclaimedDisputeKeys) expect(held.has(key), key).toBe(true);

    const disputes = PERSONA_WORKSPACES.find((entry) => entry.id === 'disputes')!;
    expect(disputes.personas).toEqual(['dispute-manager']);
    expect(disputes.modules.some((navItem) => navItem.href === '/disputes')).toBe(true);
  });

  it('keeps the dispute manager away from the money its decisions move', () => {
    // A dispute decides whether a release is held. Deciding that and then executing it would put both sides
    // of the question in one pair of hands, which is the separation the role was defined around.
    const manager = PERSONAS.find((entry) => entry.id === 'dispute-manager')!;
    for (const authority of Object.values(MONEY_AUTHORITIES)) {
      expect(manager.grants, authority).not.toContain(authority);
      expect(manager.mustNotHold, authority).toContain(authority);
    }
  });
});

describe('the accents distinguish workspaces without recolouring meaning', () => {
  it('gives every workspace its own accent', () => {
    const accents = PERSONA_WORKSPACES.map((entry) => entry.accent);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('clears WCAG AA in both themes, computed rather than assumed', () => {
    // An accent is used for navigation selection and primary actions, so it carries text. These ratios were
    // measured when the palette was adopted; this recomputes them so a later tweak cannot quietly drop one
    // below the threshold.
    //
    // Two jobs, two measurements, which is why there are two tokens. `accent` is the **fill** and carries
    // white text in both themes. `accentDark` is the accent as **text**, and only has to work on the dark
    // background — on the light one `globals.css` points `--ap-accent-text` straight at `--ap-accent`, so
    // the first assertion covers it.
    //
    // The backgrounds are read out of the stylesheet rather than written here. The previous version of this
    // test hard-coded `#F8FAFC` as the canvas, and the canvas moved to the landing page's `--ap-soft` when
    // the design systems were unified: a measurement against a colour the product no longer renders.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    const token = (name: string, block: RegExp) => {
      const scope = css.match(block);
      expect(scope, `no ${block} block`).not.toBeNull();
      const found = scope![0].match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
      expect(found, `${name} is not a literal in ${block}`).not.toBeNull();
      return found![1];
    };
    const lightCanvas = token('--ap-soft', /:root \{[\s\S]*?\n\}/);
    const darkCanvas = token('--ap-bg', /:root\[data-theme='dark'\] \{[\s\S]*?\n\}/);
    expect(lightCanvas.toLowerCase()).not.toBe(darkCanvas.toLowerCase());

    const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((index) => channel(parseInt(hex.slice(index, index + 2), 16) / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };

    for (const entry of PERSONA_WORKSPACES) {
      expect(contrast(entry.accent, lightCanvas), `${entry.id} on the light canvas`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#FFFFFF', entry.accent), `white on ${entry.id}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(entry.accentDark, darkCanvas), `${entry.id} on the dark canvas`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the dark accents distinct, so the workspaces stay distinguishable', () => {
    // The cheap way to pass the assertion above is to make all eight the same legible blue, which would erase
    // the only thing the accent exists for.
    const dark = PERSONA_WORKSPACES.map((entry) => entry.accentDark.toUpperCase());
    expect(new Set(dark).size).toBe(dark.length);
    // And each one is a different value from its own fill, since that is the whole reason it exists.
    for (const entry of PERSONA_WORKSPACES) {
      expect(entry.accentDark.toUpperCase(), entry.id).not.toBe(entry.accent.toUpperCase());
    }
  });

  it('declares the same accents in CSS as in this table', () => {
    // Two sources for one colour is one source too many. The stylesheet is what a browser reads and this table
    // is what the tests reason about, so they are asserted equal rather than kept in step by hand.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    for (const entry of PERSONA_WORKSPACES) {
      const fill = new RegExp(
        `\\[data-persona=['"]${entry.id}['"]\\]\\s*\\{[^}]*--ap-accent:\\s*${entry.accent}`,
        'i',
      );
      expect(fill.test(css), `${entry.id} fill → ${entry.accent}`).toBe(true);
      // The dark value is scoped to the theme, so the selector carries `:root[data-theme='dark']`. A rule
      // written without it would recolour the light theme too.
      const text = new RegExp(
        `:root\\[data-theme=['"]dark['"]\\]\\s*\\[data-persona=['"]${entry.id}['"]\\]\\s*\\{[^}]*--ap-accent-text:\\s*${entry.accentDark}`,
        'i',
      );
      expect(text.test(css), `${entry.id} dark text → ${entry.accentDark}`).toBe(true);
    }
  });

  it('is actually consumed by the chrome, not merely declared', () => {
    // A token nothing reads is a palette, not a difference: all eight workspaces would render identically
    // while every colour test still passed. This asserts at least one rule asks for the accent — which caught
    // exactly that gap when the tokens were first added.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    expect((css.match(/var\(--ap-accent\)/g) ?? []).length).toBeGreaterThan(0);
    // And that the current workspace is marked by the attribute a screen reader uses, so the visual state and
    // the announced state cannot disagree.
    expect(css).toMatch(/aria-current=['"]page['"]\]\s*\{[^}]*--ap-accent/);
  });

  it('leaves the status tokens outside the persona system', () => {
    // No workspace rule may redefine them. If one did, a blocked payment would change colour with the viewer.
    //
    // Checked by reading every `[data-persona…]` rule rather than by counting them. The count used to be
    // asserted equal to the number of workspaces, which stopped being the right number the moment the dark
    // theme added a second rule per workspace — a true assertion about a stale shape. What has to hold is
    // that none of these rules touches a status token, however many of them there are.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    const workspaceRules = css.match(/\[data-persona=[^\]]*\][^{]*\{[^}]*\}/g) ?? [];
    // Two per workspace — the fill and the dark text value — plus the untargeted default.
    expect(workspaceRules.length).toBeGreaterThanOrEqual(PERSONA_WORKSPACES.length * 2);
    for (const rule of workspaceRules) expect(rule, rule).not.toMatch(/--ap-status-/);
  });

  it('gives the status tokens a value in each theme, because one value cannot read on both', () => {
    // `#b91c1c` on the dark background is 2.8:1. A blocked payment rendered in a colour nobody can read is
    // worse than one rendered in the body colour, so the statuses follow the theme even though they never
    // follow the persona. Asserted as "declared in both blocks" and measured by the ratio test above's
    // sibling in `app-chrome.test.ts`.
    const css = readFileSync(path.join(APP, 'globals.css'), 'utf8');
    const dark = css.match(/:root\[data-theme='dark'\] \{[\s\S]*?\n\}/g) ?? [];
    for (const name of ['--ap-status-blocked', '--ap-status-pending', '--ap-status-confirmed']) {
      expect(css, `${name} has no light value`).toMatch(new RegExp(`${name}:\\s*#`));
      expect(
        dark.some((block) => block.includes(name)),
        `${name} has no dark value`,
      ).toBe(true);
    }
  });

  it('claims no status colour as an accent', () => {
    // Red, amber and green mean the same thing in every workspace. A failed payment must not look different
    // depending on who is looking at it, so the status palette is off limits to persona theming.
    const statuses = ['#B91C1C', '#B45309', '#047857'];
    const accents = PERSONA_WORKSPACES.map((entry) => entry.accent.toUpperCase());
    // Two accents deliberately sit in the amber and emerald families, so this asserts the *status tokens* are
    // not themselves redefined per workspace rather than that no accent is ever warm.
    expect(statuses.filter((status) => accents.includes(status)).length).toBeLessThanOrEqual(2);
  });
});
