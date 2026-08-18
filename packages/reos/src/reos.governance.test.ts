import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  deriveLifecycle,
  evaluateGovernance,
  fingerprint,
  ledgerLifecycleContradictions,
  listLedgerEntries,
  proposeBaseline,
  summariseLifecycle,
} from './index.ts';
import type {
  CapabilityProbeCount,
  CertificationReport,
  ExecutionManifest,
  Finding,
  GovernancePolicy,
  LedgerEntry,
} from './types.ts';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  rule: 'catalog/status-divergence',
  severity: 'warning',
  message: 'Engine 08 diverges.',
  subject: 'engine:08',
  ...overrides,
});

/** Only the fields the governance evaluator reads. */
function manifestWith(findings: Finding[]): ExecutionManifest {
  return { reconciliationFindings: findings } as unknown as ExecutionManifest;
}

const policy = (overrides: Partial<GovernancePolicy> = {}): GovernancePolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});

describe('governance fingerprints', () => {
  it('keys on rule and subject so message wording can change freely', () => {
    const before = finding({ message: 'original wording' });
    const after = finding({ message: 'completely rewritten wording' });
    expect(fingerprint(before)).toBe(fingerprint(after));
    expect(fingerprint(before)).toBe('catalog/status-divergence:engine:08');
  });

  it('falls back to location, then message, when no subject is declared', () => {
    expect(fingerprint({ ...finding({ subject: undefined }), location: 'a.md' })).toBe(
      'catalog/status-divergence:a.md',
    );
    expect(
      fingerprint({ ...finding({ subject: undefined }), location: undefined }),
    ).toBe('catalog/status-divergence:Engine 08 diverges.');
  });

  it('proposes a deduplicated, sorted baseline', () => {
    const manifest = manifestWith([
      finding({ subject: 'engine:08' }),
      finding({ subject: 'engine:01' }),
      finding({ subject: 'engine:08' }),
    ]);
    expect(proposeBaseline(manifest)).toEqual([
      'catalog/status-divergence:engine:01',
      'catalog/status-divergence:engine:08',
    ]);
  });
});

describe('governance phase 1 — report only', () => {
  it('never fails, and downgrades errors to warnings', () => {
    const evaluation = evaluateGovernance(
      manifestWith([finding({ severity: 'error' })]),
      policy({ phase: 1 }),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.findings[0].severity).toBe('warning');
  });
});

describe('governance phase 2 — new violations fail', () => {
  it('fails on a finding absent from the baseline', () => {
    const evaluation = evaluateGovernance(
      manifestWith([finding({ subject: 'engine:99' })]),
      policy({ phase: 2, baseline: ['catalog/status-divergence:engine:08'] }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.introduced).toEqual(['catalog/status-divergence:engine:99']);
  });

  it('passes when every finding is baselined, marking them as pre-existing', () => {
    const evaluation = evaluateGovernance(
      manifestWith([finding()]),
      policy({ phase: 2, baseline: ['catalog/status-divergence:engine:08'] }),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.baselined).toBe(1);
    expect(evaluation.findings[0].severity).toBe('warning');
    expect(evaluation.findings[0].message).toContain('baselined pre-existing');
  });

  it('escalates a baselined error only when it reappears with a new subject', () => {
    const baseline = ['runtime/duplicate-abstraction:OldEngine'];
    const evaluation = evaluateGovernance(
      manifestWith([
        finding({ rule: 'runtime/duplicate-abstraction', subject: 'OldEngine', severity: 'error' }),
        finding({ rule: 'runtime/duplicate-abstraction', subject: 'NewEngine', severity: 'error' }),
      ]),
      policy({ phase: 2, baseline }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.introduced).toEqual(['runtime/duplicate-abstraction:NewEngine']);
  });

  it('reports a stale baseline entry once its violation is fixed', () => {
    const evaluation = evaluateGovernance(
      manifestWith([]),
      policy({ phase: 2, baseline: ['catalog/status-divergence:engine:08'] }),
    );
    expect(evaluation.resolved).toEqual(['catalog/status-divergence:engine:08']);
    expect(
      evaluation.findings.some((entry) => entry.rule === 'governance/stale-baseline'),
    ).toBe(true);
    // A stale entry is a warning: fixing a violation must never fail the build.
    expect(evaluation.passed).toBe(true);
  });
});

describe('governance phase 3 — everything fails', () => {
  it('ignores the baseline entirely', () => {
    const evaluation = evaluateGovernance(
      manifestWith([finding()]),
      policy({ phase: 3, baseline: ['catalog/status-divergence:engine:08'] }),
    );
    expect(evaluation.passed).toBe(false);
  });
});

describe('governance rule exemptions', () => {
  it('demotes an exempt rule to info at every phase, with the reason attached', () => {
    for (const phase of [1, 2, 3] as const) {
      const evaluation = evaluateGovernance(
        manifestWith([finding({ severity: 'error' })]),
        policy({
          phase,
          exemptRules: { 'catalog/status-divergence': 'catalog rewrite scheduled' },
        }),
      );
      expect(evaluation.passed).toBe(true);
      expect(evaluation.findings[0].severity).toBe('info');
      expect(evaluation.findings[0].message).toContain('catalog rewrite scheduled');
    }
  });
});

describe('capability lifecycle derivation', () => {
  const greenCertification = {
    passed: true,
    steps: [
      { id: 'test:unit', passed: true, skipped: false },
      { id: 'test:integration', passed: true, skipped: false },
      { id: 'test:e2e', passed: true, skipped: false },
    ],
  } as unknown as CertificationReport;

  const redCertification = {
    passed: false,
    steps: [
      { id: 'test:unit', passed: true, skipped: false },
      { id: 'test:integration', passed: true, skipped: false },
      { id: 'test:e2e', passed: true, skipped: false },
      { id: 'build', passed: false, skipped: false },
    ],
  } as unknown as CertificationReport;

  const base = {
    executable: false,
    onDefaultBranch: false,
    certification: null,
    certifyScript: 'certify:identity',
  };

  it('separates missing from planned by whether work can start', () => {
    expect(deriveLifecycle({ ...base, status: 'missing' })).toBe('missing');
    expect(deriveLifecycle({ ...base, status: 'missing', executable: true })).toBe(
      'planned',
    );
  });

  it('treats recoverable work as planned once it is unblocked', () => {
    // `lost` and `unreachable` are absent at HEAD; status carries recoverability.
    expect(deriveLifecycle({ ...base, status: 'lost', executable: true })).toBe('planned');
    expect(
      deriveLifecycle({ ...base, status: 'unreachable', executable: true }),
    ).toBe('planned');
  });

  it('maps partial evidence to implementing', () => {
    expect(deriveLifecycle({ ...base, status: 'partial' })).toBe('implementing');
  });

  it('stops at implemented when no certification has run', () => {
    expect(deriveLifecycle({ ...base, status: 'implemented' })).toBe('implemented');
  });

  it('reaches validated when its own gates pass but the full run is red', () => {
    expect(
      deriveLifecycle({
        ...base,
        status: 'implemented',
        certification: redCertification,
      }),
    ).toBe('validated');
  });

  it('reaches certified on a green run, and released once it is on the default branch', () => {
    expect(
      deriveLifecycle({
        ...base,
        status: 'implemented',
        certification: greenCertification,
      }),
    ).toBe('certified');

    expect(
      deriveLifecycle({
        ...base,
        status: 'implemented',
        certification: greenCertification,
        onDefaultBranch: true,
      }),
    ).toBe('released');
  });

  it('keeps deferred work out of the progression entirely', () => {
    expect(
      deriveLifecycle({
        ...base,
        status: 'deferred',
        certification: greenCertification,
        onDefaultBranch: true,
      }),
    ).toBe('deferred');
  });

  it('summarises states with every bucket present', () => {
    const summary = summariseLifecycle(['missing', 'planned', 'planned']);
    expect(summary.planned).toBe(2);
    expect(summary.missing).toBe(1);
    expect(summary.released).toBe(0);
  });
});

describe('the ledger and the lifecycle cannot disagree about whether work exists', () => {
  /**
   * This suite exists because they disagreed for thirteen consecutive executions and nothing noticed.
   *
   * `persistence.domain-store-durability` declared evidence probes naming
   * `packages/database/src/domain-store.ts`, `PostgresDomainStore` and `DOMAIN_AGGREGATE_OWNERSHIP`. None of
   * them has ever existed here — git records no commit creating or deleting any one — because they described a
   * single-store design the accepted batch decision superseded before it was built. No probe could ever be
   * satisfied, so the derived lifecycle stayed `planned`, which is the state meaning "no evidence at HEAD", and
   * `repo:next` selected the same capability as the highest-priority unstarted work every single time.
   *
   * Meanwhile thirteen of its fourteen ledger entries recorded `certification.passed: true` — the repository's
   * full eleven-step gate, green, over the work being reported. Two records of the same repository, flatly
   * contradicting each other, both written by the same tool on the same run.
   */
  const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry =>
    ({
      entryId: 'abc123abc123-persistence.example',
      recordedAt: '2026-08-18T09:00:00.000Z',
      capabilityId: 'persistence.example',
      lifecycle: 'planned',
      branch: 'feat/example',
      commit: 'abc123abc123abc123abc123abc123abc123abcd',
      manifestDigest: 'deadbeefcafe',
      validation: [],
      certification: { available: true, passed: true, failedSteps: [] },
      supersedes: [],
      ...overrides,
    }) as LedgerEntry;

  /** What forensics measured for that capability on this run. */
  const unseen = [{ id: 'persistence.example', satisfiedProbes: 0, totalProbes: 4 }];
  const seen = [{ id: 'persistence.example', satisfiedProbes: 4, totalProbes: 4 }];

  it('flags a passing certification recorded against evidence the repository cannot see', () => {
    expect(ledgerLifecycleContradictions([entry()], unseen)).toEqual([
      {
        capabilityId: 'persistence.example',
        entryId: 'abc123abc123-persistence.example',
        lifecycle: 'planned',
        recordedAt: '2026-08-18T09:00:00.000Z',
      },
    ]);
    expect(ledgerLifecycleContradictions([entry({ lifecycle: 'missing' })], unseen)).toHaveLength(1);
  });

  it('accepts the states that are not contradictions', () => {
    // A green run over work the probes can see. The ordinary case, and the one the redrawn evidence produces:
    // note the recorded lifecycle is still the stale `planned`, and this passes anyway — because the live
    // measurement is what decides, which is what stops the gate deadlocking on its own history.
    expect(ledgerLifecycleContradictions([entry()], seen)).toEqual([]);
    // Work started with the gate still red — nothing satisfied and nothing claimed. The two agree.
    expect(
      ledgerLifecycleContradictions(
        [entry({ certification: { available: false, passed: false, failedSteps: ['test:unit'] } })],
        unseen,
      ),
    ).toEqual([]);
    // An execution with no capability attributed to it makes no claim about one.
    expect(ledgerLifecycleContradictions([entry({ capabilityId: null })], unseen)).toEqual([]);
    // A capability declaring no evidence at all is a different defect, and not this one's business: zero of
    // zero probes is not a contradiction, it is an empty claim.
    expect(
      ledgerLifecycleContradictions([entry()], [
        { id: 'persistence.example', satisfiedProbes: 0, totalProbes: 0 },
      ]),
    ).toEqual([]);
  });

  it('judges the latest entry per capability, leaving history untouched', () => {
    // The historical entries for this very defect are contradictory and they are also history — CLAUDE.md's
    // third hard constraint is that it is never mutated in place. So the claim is about the live state: what a
    // capability is being reported as *now*. An older contradictory entry superseded by a consistent one is a
    // defect that was fixed, which is what the ledger is for.
    const contradictions = ledgerLifecycleContradictions(
      [
        entry({ recordedAt: '2026-08-11T10:00:00.000Z', entryId: 'old-persistence.example' }),
        entry({
          recordedAt: '2026-08-18T22:00:00.000Z',
          entryId: 'new-persistence.example',
          certification: { available: true, passed: false, failedSteps: ['build'] },
        }),
      ],
      unseen,
    );
    expect(contradictions).toEqual([]);

    // And the reverse: a consistent history followed by a contradictory entry is caught, whatever the input
    // order — the function sorts rather than trusting the caller to have done it.
    const regressed = ledgerLifecycleContradictions(
      [
        entry({ recordedAt: '2026-08-18T22:00:00.000Z', entryId: 'new' }),
        entry({
          recordedAt: '2026-08-11T10:00:00.000Z',
          entryId: 'old',
          certification: { available: true, passed: false, failedSteps: ['build'] },
        }),
      ],
      unseen,
    );
    expect(regressed.map((row) => row.entryId)).toEqual(['new']);
  });

  it('holds over the repository\u2019s own ledger', () => {
    // The assertion that would have caught the original defect, and the one that stops it recurring. Not
    // vacuous: the suite above proves the same function flags the shape this asserts the absence of.
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const entries = listLedgerEntries(repoRoot);
    expect(entries.length).toBeGreaterThan(0);

    const manifest = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'docs/governance/reos/generated/execution-manifest.json'),
        'utf8',
      ),
    ) as { platformCapabilities: CapabilityProbeCount[] };
    expect(manifest.platformCapabilities.length).toBeGreaterThan(0);

    expect(
      ledgerLifecycleContradictions(entries, manifest.platformCapabilities),
      'a capability is being reported as certified while the repository derives that its evidence does not ' +
        'exist \u2014 redraw its evidence probes at the artifacts that exist, or explain the gap in its notes',
    ).toEqual([]);
  });
});
