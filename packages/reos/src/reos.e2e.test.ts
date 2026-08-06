import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifactPaths, resolveRepoRoot } from './index.ts';
import type { DependencyResolution, DiscoverySnapshot, ExecutionManifest } from './types.ts';

const repoRoot = resolveRepoRoot();
const cli = path.join(repoRoot, 'packages/reos/bin/reos.ts');

// Artifacts are redirected so the end-to-end run never rewrites the committed
// set under docs/governance/reos/generated.
const artifactRoot = mkdtempSync(path.join(tmpdir(), 'reos-e2e-'));

function runCli(args: string[], artifactDirectory = artifactRoot) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, REOS_ARTIFACT_DIR: artifactDirectory },
  });
}

function readArtifact<T>(relativePath: string, root = artifactRoot): T {
  return JSON.parse(readFileSync(path.join(root, path.basename(relativePath)), 'utf8')) as T;
}

afterAll(() => {
  rmSync(artifactRoot, { recursive: true, force: true });
});

describe('e2e: the REOS command surface', () => {
  it('prints usage and exits zero with no arguments', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Repository Execution Operating System');
    for (const command of [
      'discover',
      'forensics',
      'manifest',
      'dependencies',
      'certify',
      'report',
      'next',
      'pipeline',
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it('exits non-zero on an unknown command', () => {
    expect(runCli(['not-a-command']).status).toBe(1);
  });
});

describe('e2e: stages 1 to 4 run end to end through the CLI', () => {
  it('discover writes a snapshot of the repository', () => {
    const result = runCli(['discover']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('packages');

    const snapshot = readArtifact<DiscoverySnapshot>(artifactPaths().discovery);
    expect(snapshot.stage).toBe('discover');
    expect(snapshot.totals.engines).toBe(60);
    expect(snapshot.repository.git.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('manifest writes both the JSON input and the Markdown record', () => {
    const result = runCli(['manifest']);
    expect(result.status).toBe(0);

    const manifest = readArtifact<ExecutionManifest>(artifactPaths().manifestJson);
    expect(manifest.stage).toBe('manifest');
    expect(manifest.engines).toHaveLength(60);

    const markdown = readFileSync(
      path.join(artifactRoot, 'EXECUTION_MANIFEST.md'),
      'utf8',
    );
    expect(markdown).toContain('# Repository Execution Manifest');
    expect(markdown).toContain('Engine reconciliation');
  });

  it('dependencies selects a capability and records the rejections', () => {
    const result = runCli(['dependencies']);
    expect(result.status).toBe(0);

    const resolution = readArtifact<DependencyResolution>(
      artifactPaths().dependenciesJson,
    );
    expect(resolution.stage).toBe('dependencies');
    // Selected is null once every registry capability is implemented — a finished backlog,
    // not a broken resolver. Either way the stage must succeed and record its reasoning.
    if (resolution.selected !== null)
      expect(resolution.executable.length).toBeGreaterThan(0);
    expect(Array.isArray(resolution.rejected)).toBe(true);
  });

  it('next names the selected capability, or says the backlog is empty', () => {
    const result = runCli(['next']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('next executable capability');
    // With nothing left to build, `next` must say so and still exit zero. Failing here would
    // mean the pipeline reports an error for the state it is designed to reach.
    expect(result.stdout).toMatch(/Selected|No executable capability|nothing/i);
  });
});

describe('e2e: stages 1 to 4 are byte-for-byte deterministic', () => {
  it('produces identical artifacts across two independent CLI runs', () => {
    const first = mkdtempSync(path.join(tmpdir(), 'reos-det-a-'));
    const second = mkdtempSync(path.join(tmpdir(), 'reos-det-b-'));

    try {
      expect(runCli(['dependencies'], first).status).toBe(0);
      expect(runCli(['dependencies'], second).status).toBe(0);

      for (const artifact of [
        'discovery.json',
        'forensics.json',
        'execution-manifest.json',
        'EXECUTION_MANIFEST.md',
        'dependency-resolution.json',
        'DEPENDENCY_RESOLUTION.md',
      ]) {
        const left = readFileSync(path.join(first, artifact), 'utf8');
        const right = readFileSync(path.join(second, artifact), 'utf8');
        expect(right, `${artifact} differed between runs`).toBe(left);
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('e2e: certification gates report structurally', () => {
  it('runs the in-process validators and writes a certification report', () => {
    const result = runCli([
      'certify',
      '--only=architecture,dependencies,security,contract',
    ]);

    expect(result.stdout).toContain('[pass] architecture');
    expect(result.stdout).toContain('[skip] build');

    const report = readArtifact<{
      stage: string;
      steps: { id: string; skipped: boolean; passed: boolean }[];
      totals: { executed: number };
    }>(artifactPaths().certificationJson);

    expect(report.stage).toBe('certify');
    expect(report.totals.executed).toBe(4);
    expect(report.steps.find((step) => step.id === 'build')?.skipped).toBe(true);
    expect(report.steps.find((step) => step.id === 'security')?.passed).toBe(true);

    expect(existsSync(path.join(artifactRoot, 'CERTIFICATION_REPORT.md'))).toBe(true);
  });
});
