import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  deriveLifecycle,
  evaluateGovernance,
  fingerprint,
  proposeBaseline,
  summariseLifecycle,
} from './index.ts';
import type {
  CertificationReport,
  ExecutionManifest,
  Finding,
  GovernancePolicy,
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
