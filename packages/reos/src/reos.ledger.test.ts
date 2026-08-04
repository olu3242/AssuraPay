import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEDGER_DIRECTORY,
  appendLedgerEntry,
  buildLedgerEntry,
  digestOf,
  ledgerEntryId,
  listLedgerEntries,
} from './index.ts';
import type {
  CertificationReport,
  ExecutionManifest,
  ValidationOutcome,
} from './types.ts';

const roots: string[] = [];

function scratchRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reos-ledger-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const manifest = {
  manifestDigest: 'abc123def456',
  implementedCapabilities: ['reos.execution-os', 'trust.identity-assertions'],
} as unknown as ExecutionManifest;

const validation: ValidationOutcome[] = [
  {
    validator: 'architecture',
    passed: true,
    checked: 22,
    findings: [],
  },
  {
    validator: 'security',
    passed: false,
    checked: 200,
    findings: [
      { rule: 'security/custody-primitive', severity: 'error', message: 'x' },
      { rule: 'security/audit-mutation', severity: 'warning', message: 'y' },
    ],
  },
];

const certification = {
  passed: false,
  steps: [
    { id: 'lint', passed: true, skipped: false },
    { id: 'build', passed: false, skipped: false },
    { id: 'governance', passed: true, skipped: true },
  ],
} as unknown as CertificationReport;

function entry(overrides: Partial<Parameters<typeof buildLedgerEntry>[0]> = {}) {
  return buildLedgerEntry({
    manifest,
    validation,
    certification,
    capabilityId: 'trust.identity-assertions',
    lifecycle: 'certified',
    branch: 'claude/feature',
    commit: 'a'.repeat(40),
    recordedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  });
}

describe('ledger entry identity', () => {
  it('derives a filesystem-safe id from commit and capability', () => {
    expect(ledgerEntryId('a'.repeat(40), 'trust.identity-assertions')).toBe(
      'aaaaaaaaaaaa-trust.identity-assertions',
    );
  });

  it('handles an execution with no declared capability', () => {
    expect(ledgerEntryId('b'.repeat(40), null)).toBe('bbbbbbbbbbbb-no-capability');
  });

  it('replaces characters that are unsafe in a filename', () => {
    expect(ledgerEntryId('c'.repeat(40), 'engine:08')).toBe('cccccccccccc-engine_08');
  });
});

describe('ledger entry contents', () => {
  it('records the validation summary rather than every finding', () => {
    const record = entry();
    expect(record.validation).toEqual([
      { validator: 'architecture', passed: true, errors: 0, warnings: 0 },
      { validator: 'security', passed: false, errors: 1, warnings: 1 },
    ]);
  });

  it('records certification availability and the failing steps, ignoring skips', () => {
    expect(entry().certification).toEqual({
      available: true,
      passed: false,
      failedSteps: ['build'],
    });
  });

  it('marks certification unavailable when none was supplied', () => {
    expect(entry({ certification: null }).certification).toEqual({
      available: false,
      passed: false,
      failedSteps: [],
    });
  });

  it('ties the execution to the manifest it read', () => {
    expect(entry().manifestDigest).toBe('abc123def456');
  });

  it('lists other completed capabilities as superseded, excluding itself', () => {
    expect(entry().supersedes).toEqual(['reos.execution-os']);
  });
});

describe('ledger append-only guarantee', () => {
  it('writes an entry and indexes it', () => {
    const root = scratchRepo();
    const result = appendLedgerEntry(root, entry());

    expect(result.appended).toBe(true);
    expect(listLedgerEntries(root)).toHaveLength(1);

    const index = readFileSync(
      path.join(root, LEDGER_DIRECTORY, 'INDEX.md'),
      'utf8',
    );
    expect(index).toContain('1 execution(s) recorded.');
    expect(index).toContain('trust.identity-assertions');
  });

  it('never rewrites an existing entry for the same commit and capability', () => {
    const root = scratchRepo();
    appendLedgerEntry(root, entry());

    const file = path.join(
      root,
      LEDGER_DIRECTORY,
      'aaaaaaaaaaaa-trust.identity-assertions.json',
    );
    const original = readFileSync(file, 'utf8');

    // A second report for the same execution, with a different outcome.
    const second = appendLedgerEntry(
      root,
      entry({ recordedAt: '2026-09-01T00:00:00.000Z', lifecycle: 'released' }),
    );

    expect(second.appended).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(listLedgerEntries(root)).toHaveLength(1);
  });

  it('appends a separate entry for a different commit', () => {
    const root = scratchRepo();
    appendLedgerEntry(root, entry());
    appendLedgerEntry(root, entry({ commit: 'd'.repeat(40) }));
    expect(listLedgerEntries(root)).toHaveLength(2);
  });

  it('appends a separate entry for a different capability at the same commit', () => {
    const root = scratchRepo();
    appendLedgerEntry(root, entry());
    appendLedgerEntry(root, entry({ capabilityId: 'reos.execution-os' }));
    expect(listLedgerEntries(root)).toHaveLength(2);
  });

  it('returns entries in recorded order', () => {
    const root = scratchRepo();
    appendLedgerEntry(
      root,
      entry({ commit: 'f'.repeat(40), recordedAt: '2026-08-05T00:00:00.000Z' }),
    );
    appendLedgerEntry(
      root,
      entry({ commit: 'e'.repeat(40), recordedAt: '2026-08-01T00:00:00.000Z' }),
    );

    expect(listLedgerEntries(root).map((record) => record.recordedAt)).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z',
    ]);
  });

  it('reads an empty ledger without failing', () => {
    expect(listLedgerEntries(scratchRepo())).toEqual([]);
  });

  it('ignores non-entry files beside the records', () => {
    const root = scratchRepo();
    appendLedgerEntry(root, entry());
    writeFileSync(path.join(root, LEDGER_DIRECTORY, 'NOTES.md'), 'scratch', 'utf8');
    expect(listLedgerEntries(root)).toHaveLength(1);
  });
});

describe('manifest digest', () => {
  it('is stable for equivalent content regardless of key order', () => {
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(
      digestOf({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('changes when content changes', () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });

  it('is short enough to read in a table', () => {
    expect(digestOf({ a: 1 })).toHaveLength(12);
  });
});
