import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSION_REQUIREMENTS, routePermissionKeys } from './route-permissions';
import {
  MONEY_AUTHORITIES,
  PERSONAS,
  inventedPermissionKeys,
  personaGrantKeys,
  routesDeniedTo,
  routesReachableBy,
} from './personas';

/**
 * The persona certification matrix, as assertions rather than a document.
 *
 * RC1 asks for ten personas and forbids inventing permissions. AssuraPay has no role catalogue — authority is
 * grants over `resource:action` keys — so `personas.ts` declares personas as compositions of keys the route table
 * already requires, and this suite is what stops that declaration drifting into fiction.
 */
describe('the persona catalogue names only permissions that exist', () => {
  it('invents nothing', () => {
    // The assertion the whole module rests on. A persona granted a key no route requires would certify a
    // boundary nothing enforces — the failure would be invisible in a browser test, because the route it was
    // supposed to guard would simply never appear.
    expect(
      inventedPermissionKeys(),
      'persona grants naming permission keys no route requires — either the key is a typo or the route is missing',
    ).toEqual([]);
  });

  it('covers the ten personas RC1 names', () => {
    expect(PERSONAS).toHaveLength(10);
    expect(PERSONAS.map((entry) => entry.id)).toEqual([
      'organization-administrator',
      'workspace-administrator',
      'agreement-owner',
      'execution-lead',
      'reviewer',
      'approver',
      'finance',
      'supplier',
      'customer',
      'auditor',
    ]);
    // Not vacuous: a catalogue of ten empty personas would satisfy the count.
    for (const entry of PERSONAS) {
      expect(entry.grants.length, `${entry.id} grants nothing`).toBeGreaterThan(0);
      expect(entry.mustNotHold.length, `${entry.id} prohibits nothing`).toBeGreaterThan(0);
      expect(entry.rationale.length, `${entry.id} has no stated rationale`).toBeGreaterThan(40);
    }
  });

  it('never grants what it prohibits', () => {
    // `mustNotHold` is a claim about a separation. A persona holding a key it also prohibits is a contradiction
    // that would read, to anything consuming this table, as a granted permission.
    const contradictions = PERSONAS.flatMap((entry) =>
      entry.grants.filter((key) => entry.mustNotHold.includes(key)).map((key) => `${entry.id}:${key}`),
    );
    expect(contradictions).toEqual([]);
  });
});

describe('money movement stays separated', () => {
  // Imported, not restated. Keeping local copies here is what made the first run of this suite fail against a
  // key the catalogue had already corrected.
  const { certify: CERTIFY, approveRelease: APPROVE_RELEASE, submitPayment: SUBMIT_PAYMENT } = MONEY_AUTHORITIES;

  it('gives no persona more than one of certify, approve-release and submit-payment', () => {
    // CLAUDE.md's second hard constraint in the persona model: one principal holding all three could
    // manufacture certified work and pay itself for it.
    for (const entry of PERSONAS) {
      const held = [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT].filter((key) => entry.grants.includes(key));
      expect(held.length, `${entry.id} holds ${held.join(' and ')}`).toBeLessThanOrEqual(1);
    }
  });

  it('states the prohibition on every persona that could plausibly be given it', () => {
    // Silence is not separation. Every persona must say which of the three it may not hold, so that adding one
    // later fails here rather than passing unnoticed.
    for (const entry of PERSONAS) {
      const named = [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT].filter(
        (key) => entry.grants.includes(key) || entry.mustNotHold.includes(key),
      );
      expect(named.length, `${entry.id} says nothing about the three money authorities`).toBe(3);
    }
  });

  it('keeps the three keys real', () => {
    const real = new Set(routePermissionKeys());
    for (const key of [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT]) expect(real.has(key), key).toBe(true);
  });
});

describe('the matrix is derived from the route table, not restated', () => {
  it('reaches some routes and is denied most of them', () => {
    const gated = Object.values(ROUTE_PERMISSION_REQUIREMENTS).filter(
      (requirement) => requirement.access === 'permission',
    ).length;

    for (const entry of PERSONAS) {
      const reachable = routesReachableBy(entry);
      const denied = routesDeniedTo(entry);
      expect(reachable.length, `${entry.id} reaches nothing`).toBeGreaterThan(0);
      // Deny-by-default, visible as a number: no persona is close to holding the platform.
      expect(denied.length, `${entry.id} is denied nothing`).toBeGreaterThan(0);
      expect(reachable.length + denied.length).toBe(gated);
      expect(reachable.some((route) => denied.includes(route))).toBe(false);
    }
  });

  it('gives no single persona the whole platform', () => {
    const gated = Object.values(ROUTE_PERMISSION_REQUIREMENTS).filter(
      (requirement) => requirement.access === 'permission',
    ).length;
    for (const entry of PERSONAS)
      expect(routesReachableBy(entry).length, `${entry.id}`).toBeLessThan(gated / 2);
  });

  it('claims fewer keys than the platform defines, so the catalogue is a subset by construction', () => {
    expect(personaGrantKeys().length).toBeLessThan(routePermissionKeys().length);
  });
});
