/*
 * reos:rule-vocabulary — fixtures below contain marker words on purpose.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBacklog,
  buildEngineNodes,
  classifyStatus,
  classifyTestFile,
  detectCycles,
  matchGlob,
  parseCanonicalChain,
  parseCertificationTarget,
  parseEngineCatalog,
  selectNext,
  stableStringify,
  type CapabilityNode,
} from './index.ts';
import type { EngineReconciliation, GitEvidence } from './types.ts';

const NO_GIT_EVIDENCE: GitEvidence = {
  refsContaining: [],
  historicalCommits: [],
  removedFromHead: false,
  reachableFromHead: false,
};

describe('REOS stage 1 — discovery parsing', () => {
  it('parses engine catalog tables across waves, with and without a status column', () => {
    const engines = parseEngineCatalog(
      [
        '## Wave 1 — Trust Foundation (01–10)',
        '',
        '| # | Engine | Primary responsibility | Status |',
        '|---|---|---|---|',
        '| 01 | Identity & Digital Trust | Authentication and sessions | Conditionally implemented |',
        '| 02 | Organization & Multi-Tenant | Workspaces | Deferred |',
        '',
        '## Wave 2 — Agreement Intelligence (11–20)',
        '',
        '| # | Engine | Primary responsibility |',
        '|---|---|---|',
        '| 11 | Contract Authoring | Templates and clauses |',
      ].join('\n'),
    );

    expect(engines).toHaveLength(3);
    expect(engines[0]).toMatchObject({
      id: '01',
      name: 'Identity & Digital Trust',
      wave: 1,
      waveName: 'Trust Foundation',
      declaredStatus: 'Conditionally implemented',
    });
    // Waves 2-6 carry no status column, so declaredStatus must be null.
    expect(engines[2]).toMatchObject({ id: '11', wave: 2, declaredStatus: null });
  });

  it('ignores table header and separator rows', () => {
    const engines = parseEngineCatalog(
      ['| # | Engine | Responsibility |', '|---|---|---|'].join('\n'),
    );
    expect(engines).toEqual([]);
  });

  it('extracts package directory and test-name filter from certify scripts', () => {
    expect(
      parseCertificationTarget(
        'certify:payment-eligibility',
        'vitest run packages/settlement-assurance/src/settlement-assurance.test.ts --testNamePattern=41',
      ),
    ).toEqual({
      script: 'certify:payment-eligibility',
      command:
        'vitest run packages/settlement-assurance/src/settlement-assurance.test.ts --testNamePattern=41',
      packageDirectory: 'packages/settlement-assurance',
      testNamePattern: '41',
    });

    expect(
      parseCertificationTarget('certify:batch1', 'npm run certify && npm run build'),
    ).toMatchObject({ packageDirectory: null, testNamePattern: null });
  });

  it('classifies test files by kind', () => {
    expect(classifyTestFile('packages/a/src/a.test.ts')).toBe('unit');
    expect(classifyTestFile('packages/a/src/a.integration.test.ts')).toBe('integration');
    expect(classifyTestFile('packages/a/src/a.e2e.test.ts')).toBe('e2e');
    expect(classifyTestFile('packages/a/src/a.security.test.ts')).toBe('security');
    expect(classifyTestFile('packages/a/src/a.performance.test.ts')).toBe('performance');
    expect(classifyTestFile('packages/a/src/index.ts')).toBeNull();
  });

  it('reads the canonical chain from CLAUDE.md rather than hardcoding it', () => {
    expect(
      parseCanonicalChain('The canonical chain is `Contract → Milestone → ReleaseRequest`.'),
    ).toEqual(['Contract', 'Milestone', 'ReleaseRequest']);
    expect(parseCanonicalChain('no chain here')).toEqual([]);
    expect(parseCanonicalChain(null)).toEqual([]);
  });
});

describe('REOS stage 2 — forensics classification', () => {
  it('reports implemented only when every probe is satisfied', () => {
    expect(classifyStatus(3, 3, NO_GIT_EVIDENCE).status).toBe('implemented');
  });

  it('reports partial when some evidence exists at HEAD', () => {
    expect(classifyStatus(1, 3, NO_GIT_EVIDENCE).status).toBe('partial');
  });

  it('separates missing from lost from unreachable', () => {
    expect(classifyStatus(0, 2, NO_GIT_EVIDENCE).status).toBe('missing');

    expect(
      classifyStatus(0, 2, {
        ...NO_GIT_EVIDENCE,
        historicalCommits: ['abc1234 add gateway'],
        removedFromHead: true,
      }).status,
    ).toBe('lost');

    expect(
      classifyStatus(0, 2, {
        ...NO_GIT_EVIDENCE,
        refsContaining: ['origin/feat/gateway'],
        reachableFromHead: false,
      }).status,
    ).toBe('unreachable');
  });

  it('prefers unreachable over lost when a ref still carries the work', () => {
    const result = classifyStatus(0, 1, {
      refsContaining: ['origin/feat/gateway'],
      historicalCommits: ['abc1234 add gateway'],
      removedFromHead: true,
      reachableFromHead: false,
    });
    expect(result.status).toBe('unreachable');
    expect(result.rationale).toContain('origin/feat/gateway');
  });
});

describe('REOS stage 4 — dependency resolution rules', () => {
  const node = (
    id: string,
    overrides: Partial<CapabilityNode> = {},
  ): CapabilityNode => ({
    id,
    title: id,
    kind: 'platform',
    status: 'missing',
    priority: 10,
    dependsOn: [],
    requiresLiveInfrastructure: false,
    ...overrides,
  });

  it('never re-selects completed work', () => {
    const backlog = buildBacklog([
      node('done', { status: 'implemented' }),
      node('open'),
    ]);
    expect(backlog.map((entry) => entry.id)).toEqual(['open']);
  });

  it('never selects deferred work', () => {
    const backlog = buildBacklog([node('deferred', { status: 'deferred' })]);
    expect(backlog).toEqual([]);
  });

  it('blocks work whose dependencies are unmet and unblocks it when they land', () => {
    const blocked = buildBacklog([
      node('base', { status: 'missing', priority: 1 }),
      node('dependent', { dependsOn: ['base'], priority: 2 }),
    ]);
    expect(blocked.find((entry) => entry.id === 'dependent')).toMatchObject({
      executable: false,
      blockedBy: ['base'],
    });

    const unblocked = buildBacklog([
      node('base', { status: 'implemented', priority: 1 }),
      node('dependent', { dependsOn: ['base'], priority: 2 }),
    ]);
    expect(unblocked.find((entry) => entry.id === 'dependent')).toMatchObject({
      executable: true,
      blockedBy: [],
    });
  });

  it('treats a dependency on an unknown capability as blocking', () => {
    const backlog = buildBacklog([node('dependent', { dependsOn: ['ghost'] })]);
    expect(backlog[0]).toMatchObject({ executable: false, blockedBy: ['ghost'] });
  });

  it('treats a deferred dependency as satisfied so it cannot stall the queue', () => {
    const backlog = buildBacklog([
      node('skipped', { status: 'deferred' }),
      node('dependent', { dependsOn: ['skipped'] }),
    ]);
    expect(backlog.find((entry) => entry.id === 'dependent')?.executable).toBe(true);
  });

  it('selects the highest-priority executable capability deterministically', () => {
    const backlog = buildBacklog([
      node('low', { priority: 50 }),
      node('high', { priority: 5 }),
      node('blocked', { priority: 1, dependsOn: ['low'] }),
    ]);
    expect(selectNext(backlog)?.id).toBe('high');
  });

  it('deprioritises live-infrastructure work but still offers it when alone', () => {
    const mixed = buildBacklog([
      node('live', { priority: 1, requiresLiveInfrastructure: true }),
      node('offline', { priority: 9 }),
    ]);
    expect(selectNext(mixed)?.id).toBe('offline');

    const onlyLive = buildBacklog([
      node('live', { priority: 1, requiresLiveInfrastructure: true }),
    ]);
    expect(selectNext(onlyLive)?.id).toBe('live');
  });

  it('returns null when nothing is executable', () => {
    expect(selectNext([])).toBeNull();
    const allBlocked = buildBacklog([
      node('base'),
      node('dependent', { dependsOn: ['base'] }),
    ]);
    expect(selectNext(allBlocked.filter((entry) => !entry.executable))).toBeNull();
  });

  it('chains engines in catalog order and skips deferred engines as blockers', () => {
    const engines: EngineReconciliation[] = [
      {
        id: '01',
        name: 'One',
        wave: 1,
        declaredStatus: null,
        observedStatus: 'implemented',
        packageDirectory: 'packages/one',
        certificationScript: 'certify:one',
        divergent: false,
      },
      {
        id: '02',
        name: 'Two',
        wave: 1,
        declaredStatus: 'Deferred',
        observedStatus: 'deferred',
        packageDirectory: null,
        certificationScript: null,
        divergent: false,
      },
      {
        id: '03',
        name: 'Three',
        wave: 1,
        declaredStatus: null,
        observedStatus: 'missing',
        packageDirectory: null,
        certificationScript: null,
        divergent: false,
      },
    ];

    const nodes = buildEngineNodes(engines);
    // Engine 03 depends on 01, not on the deferred 02.
    expect(nodes[2]).toMatchObject({ id: 'engine:03', dependsOn: ['engine:01'] });
  });
});

describe('REOS determinism guarantees', () => {
  it('serialises object keys in a stable order regardless of construction order', () => {
    const first = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const second = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(first).toBe(second);
  });

  it('omits undefined values so optional fields cannot vary the bytes', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('ends artifacts with a trailing newline', () => {
    expect(stableStringify({ a: 1 }).endsWith('\n')).toBe(true);
  });
});

describe('REOS glob matching', () => {
  it('matches within and across path segments', () => {
    expect(matchGlob('packages/*/src/index.ts', 'packages/reos/src/index.ts')).toBe(true);
    expect(matchGlob('packages/*/src/index.ts', 'packages/a/b/src/index.ts')).toBe(false);
    expect(matchGlob('packages/**/*.ts', 'packages/a/b/c.ts')).toBe(true);
    expect(matchGlob('packages/identity/**', 'packages/identity/src/index.ts')).toBe(true);
  });

  it('treats dots literally', () => {
    expect(matchGlob('a/b.ts', 'a/bXts')).toBe(false);
  });
});

describe('REOS dependency cycle detection', () => {
  it('finds no cycle in an acyclic graph', () => {
    expect(
      detectCycles(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', []],
        ]),
      ),
    ).toEqual([]);
  });

  it('reports a cycle including the closing node', () => {
    const cycles = detectCycles(
      new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1]);
  });

  it('detects a self-referencing node', () => {
    expect(detectCycles(new Map([['a', ['a']]]))).toEqual([['a', 'a']]);
  });
});
