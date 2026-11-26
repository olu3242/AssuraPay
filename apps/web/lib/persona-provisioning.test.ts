import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOGUE,
  SEGREGATION_CATALOGUE,
  segregationConflicts,
} from '@assurapay/permissions';
// A plain ESM module rather than TypeScript, because `scripts/provision-persona-tester.mjs` runs under
// bare Node and cannot import a `.ts` file. One table, read from both sides: the provisioner acts on it
// and this suite checks it.
import { FOUNDING_ROLE, PERSONA_TEST_WORKSPACES } from '../../../scripts/persona-test-roles.mjs';
import { PERSONA_WORKSPACES } from './persona-workspaces';
import { MONEY_AUTHORITIES, PERSONAS, type PersonaId } from './personas';

/**
 * The persona test provisioning table, as assertions.
 *
 * `scripts/provision-persona-tester.mjs` creates one workspace per persona and assigns that persona's
 * catalogue roles in it. The table it reads is a hand-written mapping, which is exactly the kind of
 * thing that is right when it is written and wrong a month later — so it is checked here against the
 * four catalogues that actually decide: the workspace views, the persona grants, the role definitions
 * and the segregation rules.
 *
 * The assertion this suite exists for is the last block. **No workspace the provisioner creates may
 * hold two segregated duties.** If one did, the provisioner would be building the principal CLAUDE.md's
 * second hard constraint forbids — one who can certify work and pay themselves for it — and would find
 * out only when the API refused it, against whoever's database it was pointed at.
 */

type Entry = {
  workspace: string;
  label: string;
  personas: PersonaId[];
  roles: string[];
  why: string;
};

const ENTRIES = PERSONA_TEST_WORKSPACES as readonly Entry[];
const ROLES = new Map(PERMISSION_CATALOGUE.map((role) => [role.role, role]));

/** Every key the account would hold in one workspace: the founding role plus that entry's roles. */
function keysIn(entry: Entry): string[] {
  return [FOUNDING_ROLE as string, ...entry.roles].flatMap(
    (role) => ROLES.get(role)?.permissionKeys ?? [],
  );
}

describe('the provisioner names things that exist', () => {
  it('reads the table at all, so nothing here passes vacuously', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
    expect(ROLES.size).toBeGreaterThan(5);
    expect(SEGREGATION_CATALOGUE.length).toBeGreaterThan(0);
  });

  it('names only roles the permission catalogue defines', () => {
    // A typo here is a provisioning run that dies half way through, having already created workspaces.
    const unknown = ENTRIES.flatMap((entry) =>
      entry.roles.filter((role) => !ROLES.has(role)).map((role) => `${entry.workspace} → ${role}`),
    );
    expect(unknown).toEqual([]);
    expect(ROLES.has(FOUNDING_ROLE as string)).toBe(true);
  });

  it('founds with the one bootstrappable role, because founding is what grants it', () => {
    // `POST /v1/workspaces/{id}/found` grants this and nothing else, so the table must not list it
    // again per workspace — and must not expect some other role to arrive by founding.
    expect(ROLES.get(FOUNDING_ROLE as string)?.bootstrappable).toBe(true);
    const bootstrappable = PERMISSION_CATALOGUE.filter((role) => role.bootstrappable);
    expect(bootstrappable.map((role) => role.role)).toEqual([FOUNDING_ROLE]);
    for (const entry of ENTRIES) {
      expect(entry.roles, `${entry.workspace} re-lists the founding role`).not.toContain(FOUNDING_ROLE);
    }
  });

  it('names only personas the catalogue defines, and covers every one of them', () => {
    const known = new Set(PERSONAS.map((persona) => persona.id));
    const named = new Set<PersonaId>();
    for (const entry of ENTRIES) {
      for (const persona of entry.personas) {
        expect(known, `${entry.workspace} names ${persona}`).toContain(persona);
        named.add(persona);
      }
    }
    // Every persona is reachable, which is the point of the exercise: a tester who cannot act as one
    // of the eleven cannot test it.
    expect([...known].filter((persona) => !named.has(persona))).toEqual([]);
  });

  it('uses the workspace view ids wherever a view exists, and says so where one does not', () => {
    // `/workspace/<id>` is a static route generated from `PERSONA_WORKSPACES`, so an id that is not one
    // of those renders a 404 rather than that persona's console.
    const views = new Set(PERSONA_WORKSPACES.map((workspace) => workspace.id));
    const withoutView = ENTRIES.filter((entry) => !views.has(entry.workspace as never));
    // Exactly one: the approver, whose authority is real and whose console does not exist. The entry
    // says so in its own `why`, so whoever reads the provisioning output is not surprised by the 404.
    expect(withoutView.map((entry) => entry.workspace)).toEqual(['approver']);
    expect(withoutView[0]!.why).toContain('404');
    // And every view the application offers is provisioned, or it could not be opened at all.
    expect(
      [...views].filter((view) => !ENTRIES.some((entry) => entry.workspace === view)),
    ).toEqual([]);
  });

  it('gives a reason per workspace rather than an unexplained bundle', () => {
    for (const entry of ENTRIES) {
      expect(entry.why.length, `${entry.workspace} has no rationale`).toBeGreaterThan(80);
    }
  });
});

describe('no provisioned workspace reunites two segregated duties', () => {
  it('breaches no segregation rule in any workspace', () => {
    // The assertion this file exists for. Computed with the platform's own `segregationConflicts`
    // rather than by re-reading the rules here, so this cannot drift from what `grantRole` enforces.
    const breaches = ENTRIES.flatMap((entry) =>
      segregationConflicts(keysIn(entry)).map(
        (rule) => `${entry.workspace}: ${rule.ruleKey}`,
      ),
    );
    expect(breaches).toEqual([]);
  });

  it('is not vacuous — the same check catches a bundle that would breach one', () => {
    // Falsification, inline. If `segregationConflicts` silently returned nothing, the assertion above
    // would pass for any table at all, including the one a request for a real superuser would produce.
    const everyKey = PERMISSION_CATALOGUE.flatMap((role) => role.permissionKeys);
    expect(segregationConflicts(everyKey).length).toBeGreaterThan(0);
  });

  it('holds at most one money authority per workspace', () => {
    // The separation `personas.ts` draws, restated over the provisioned bundles. `certification-requests:issue`
    // attests that work is done, `authorization-decisions:approve` authorises money to move against that
    // attestation, and `payment-instructions:submit` moves it. One principal holding all three can
    // manufacture certified work and pay themselves for it.
    for (const entry of ENTRIES) {
      const keys = new Set(keysIn(entry));
      const held = Object.values(MONEY_AUTHORITIES).filter((key) => keys.has(key));
      expect(held.length, `${entry.workspace} holds ${held.join(' and ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the founding role free of all three, so founding never creates a payer', () => {
    // Every workspace the provisioner creates is founded by the same account, so if the founding role
    // carried a money key the tester would hold it everywhere and the per-workspace separation above
    // would be decoration.
    const founding = new Set(ROLES.get(FOUNDING_ROLE as string)!.permissionKeys);
    for (const key of Object.values(MONEY_AUTHORITIES)) {
      expect(founding, `the founding role holds ${key}`).not.toContain(key);
    }
  });

  it('spreads the three authorities across different workspaces, so each is still testable', () => {
    // The cheap way to satisfy every assertion above is to grant nobody anything. Each money authority
    // has to be reachable in exactly one workspace — separated, not absent.
    for (const key of Object.values(MONEY_AUTHORITIES)) {
      const holders = ENTRIES.filter((entry) => keysIn(entry).includes(key));
      expect(holders.length, `${key} is held in ${holders.length} workspaces`).toBe(1);
    }
  });
});
