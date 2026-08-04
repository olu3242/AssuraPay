/*
 * reos:rule-vocabulary — fixtures name forbidden primitives in order to test the
 * validator that forbids them.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_PRIMITIVES,
  UNCONDITIONAL_RELEASE_PRIMITIVES,
  validateSecurity,
} from './index.ts';

// The security validator scans a directory tree, so each case builds a minimal
// fake repository rather than mutating the real one.
const scratchDirectories: string[] = [];

function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reos-security-'));
  scratchDirectories.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (scratchDirectories.length > 0) {
    const directory = scratchDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function rulesFrom(root: string): string[] {
  return validateSecurity(root).findings.map((finding) => finding.rule);
}

describe('security: hard constraint 1 — no custody, ever', () => {
  it('rejects every custody primitive', () => {
    for (const primitive of CUSTODY_PRIMITIVES) {
      const root = fakeRepo({
        'packages/x/src/index.ts': `export function ${primitive}(amount: number) { return amount; }`,
      });
      expect(rulesFrom(root)).toContain('security/custody-primitive');
    }
  });

  it('rejects a call to a custody primitive, not only its definition', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': 'export const run = () => holdFunds(100);',
    });
    expect(rulesFrom(root)).toContain('security/custody-primitive');
  });

  it('accepts an instruction sent to an external provider adapter', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': [
        'export type ProviderAdapter = { instructRelease(reference: string): Promise<void> };',
        'export async function instructRelease(adapter: ProviderAdapter, reference: string) {',
        '  await adapter.instructRelease(reference);',
        '}',
      ].join('\n'),
    });
    expect(validateSecurity(root).findings).toEqual([]);
  });

  it('allows the non-custody test suites to name the primitives they forbid', () => {
    const root = fakeRepo({
      'packages/x/src/x.non-custody.test.ts':
        "it('forbids custody', () => { expect(source).not.toMatch(/holdFunds\\s*\\(/); });",
    });
    expect(validateSecurity(root).findings).toEqual([]);
  });
});

describe('security: hard constraint 2 — every release is certified-work-backed', () => {
  it('rejects every unconditional release primitive', () => {
    for (const primitive of UNCONDITIONAL_RELEASE_PRIMITIVES) {
      const root = fakeRepo({
        'packages/x/src/index.ts': `export function ${primitive}(id: string) { return id; }`,
      });
      expect(rulesFrom(root)).toContain('security/unconditional-release');
    }
  });

  it('accepts a release path guarded by eligibility and certificate checks', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': [
        'export function instructRelease(input: { certificateId: string; eligibilityId: string }) {',
        "  if (!input.certificateId) throw new Error('COMPLETION_CERTIFICATE_REQUIRED');",
        "  if (!input.eligibilityId) throw new Error('PAYMENT_ELIGIBILITY_REQUIRED');",
        '  return input;',
        '}',
      ].join('\n'),
    });
    expect(validateSecurity(root).findings).toEqual([]);
  });
});

describe('security: hard constraint 3 — append-only audit trail', () => {
  it('rejects in-place mutation of append-only collections', () => {
    for (const expression of [
      'auditTrail.splice(0, 1)',
      'history.pop()',
      'eventLog.shift()',
      'ledgerEntries.reverse()',
      'outboxMessages.sort()',
    ]) {
      const root = fakeRepo({
        'packages/x/src/index.ts': `export const mutate = () => ${expression};`,
      });
      expect(rulesFrom(root)).toContain('security/audit-mutation');
    }
  });

  it('accepts appending to history', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': 'export const append = (h: string[], e: string) => [...h, e];',
    });
    expect(validateSecurity(root).findings).toEqual([]);
  });
});

describe('security: secret handling', () => {
  it('rejects a literal secret in source', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts':
        "export const config = { serviceRoleKey: 'sbp_live_9f2b71c4e8a35d60' };",
    });
    expect(rulesFrom(root)).toContain('security/plaintext-secret');
  });

  it('accepts documented placeholders and configuration reads', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': [
        "export const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';",
        "export const fallbackSecret = 'replace-me-in-configuration';",
      ].join('\n'),
    });
    expect(validateSecurity(root).findings).toEqual([]);
  });
});

describe('security: the validator reports what it inspected', () => {
  it('counts the files it scanned and passes a clean tree', () => {
    const root = fakeRepo({
      'packages/x/src/index.ts': 'export const value = 1;',
      'apps/web/lib/app.ts': 'export const app = 1;',
      'scripts/tool.js': 'console.log(1);',
    });
    const outcome = validateSecurity(root);
    expect(outcome.checked).toBe(3);
    expect(outcome.passed).toBe(true);
    expect(outcome.validator).toBe('security');
  });
});
