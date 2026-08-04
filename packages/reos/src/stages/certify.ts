import { existsSync } from 'node:fs';
import path from 'node:path';
import { outputTail, runCommand } from '../util/exec.ts';
import { cell, markdownTable } from '../util/serialize.ts';
import { validateArchitecture } from '../validators/architecture.ts';
import { validateDependencies } from '../validators/dependency.ts';
import { validateSecurity } from '../validators/security.ts';
import { validateExecutionContract } from '../validators/contract.ts';
import {
  evaluateGovernance,
  loadGovernancePolicy,
  toValidationOutcome,
} from '../governance.ts';
import { REOS_VERSION } from '../types.ts';
import type {
  CertificationReport,
  CertificationStep,
  DiscoverySnapshot,
  ExecutionManifest,
  ValidationOutcome,
} from '../types.ts';

/**
 * The certification pipeline, in dependency order. Command steps reuse the
 * repository's existing scripts rather than reimplementing them; validator
 * steps run in-process because they only read the source tree.
 */
export const CERTIFICATION_STEPS = [
  { id: 'lint', description: 'ESLint across the workspace', script: 'lint' },
  { id: 'typecheck', description: 'TypeScript project typecheck', script: 'typecheck' },
  { id: 'test:unit', description: 'Unit tests', script: 'test:unit' },
  { id: 'test:integration', description: 'Integration tests', script: 'test:integration' },
  { id: 'test:e2e', description: 'End-to-end tests', script: 'test:e2e' },
  { id: 'architecture', description: 'Architecture validation', validator: 'architecture' },
  { id: 'dependencies', description: 'Dependency validation', validator: 'dependencies' },
  { id: 'security', description: 'Security validation', validator: 'security' },
  { id: 'contract', description: 'Execution contract validation', validator: 'contract' },
  { id: 'governance', description: 'Reconciliation governance policy', validator: 'governance' },
  { id: 'build', description: 'Production build', script: 'build' },
] as const;

export type CertifyOptions = {
  /** Package manager used to invoke repository scripts. */
  packageManager?: string;
  /** Run only these step ids. */
  only?: string[];
  /** Skip these step ids. */
  skip?: string[];
  /**
   * Manifest to evaluate the governance policy against. Without it the
   * governance step is skipped, because it has nothing to judge.
   */
  manifest?: ExecutionManifest | null;
};

function detectPackageManager(repoRoot: string): string {
  if (existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function runValidator(
  name: string,
  repoRoot: string,
  discovery: DiscoverySnapshot,
  manifest: ExecutionManifest | null,
): ValidationOutcome | null {
  switch (name) {
    case 'architecture':
      return validateArchitecture(repoRoot, discovery);
    case 'dependencies':
      return validateDependencies(repoRoot, discovery);
    case 'security':
      return validateSecurity(repoRoot);
    case 'contract':
      return validateExecutionContract(repoRoot, discovery);
    case 'governance':
      // Nothing to judge without a manifest; the caller decides to skip.
      if (!manifest) return null;
      return toValidationOutcome(
        evaluateGovernance(manifest, loadGovernancePolicy(repoRoot)),
      );
    default:
      throw new Error(`Unknown REOS validator: ${name}`);
  }
}

/** Stage 6 — runs every certification gate and collects a structured report. */
export function certify(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  options: CertifyOptions = {},
): CertificationReport {
  const packageManager = options.packageManager ?? detectPackageManager(repoRoot);
  const steps: CertificationStep[] = [];

  for (const definition of CERTIFICATION_STEPS) {
    const selected = !options.only || options.only.includes(definition.id);
    const skipped = options.skip?.includes(definition.id) ?? false;

    if (!selected || skipped) {
      steps.push({
        id: definition.id,
        description: definition.description,
        kind: 'validator' in definition ? 'validator' : 'command',
        passed: true,
        skipped: true,
        exitCode: null,
        durationMs: 0,
        findings: [],
        outputTail: [],
      });
      continue;
    }

    const startedAt = Date.now();

    if ('validator' in definition) {
      const outcome = runValidator(
        definition.validator,
        repoRoot,
        discovery,
        options.manifest ?? null,
      );

      if (outcome === null) {
        steps.push({
          id: definition.id,
          description: definition.description,
          kind: 'validator',
          passed: true,
          skipped: true,
          exitCode: null,
          durationMs: 0,
          findings: [],
          outputTail: ['skipped: no execution manifest supplied'],
        });
        continue;
      }

      steps.push({
        id: definition.id,
        description: definition.description,
        kind: 'validator',
        passed: outcome.passed,
        skipped: false,
        exitCode: outcome.passed ? 0 : 1,
        durationMs: Date.now() - startedAt,
        findings: outcome.findings,
        outputTail: [
          `${outcome.validator}: ${outcome.checked} unit(s) checked, ${outcome.findings.length} finding(s)`,
        ],
      });
      continue;
    }

    const result = runCommand(packageManager, ['run', definition.script], {
      cwd: repoRoot,
    });
    steps.push({
      id: definition.id,
      description: definition.description,
      kind: 'command',
      command: `${packageManager} run ${definition.script}`,
      passed: result.ok,
      skipped: false,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      findings: [],
      outputTail: outputTail(result),
    });
  }

  const executed = steps.filter((step) => !step.skipped);

  return {
    reosVersion: REOS_VERSION,
    stage: 'certify',
    head: discovery.repository.git.head,
    branch: discovery.repository.git.branch,
    generatedAt: new Date().toISOString(),
    passed: executed.every((step) => step.passed),
    steps,
    totals: {
      executed: executed.length,
      passed: executed.filter((step) => step.passed).length,
      failed: executed.filter((step) => !step.passed).length,
      skipped: steps.filter((step) => step.skipped).length,
    },
  };
}

export function renderCertificationReport(report: CertificationReport): string {
  const rows = report.steps.map((step) => [
    cell(step.id),
    cell(step.description),
    step.skipped ? 'skipped' : step.passed ? 'pass' : '**fail**',
    step.skipped ? '—' : `${step.durationMs} ms`,
    step.findings.length > 0 ? String(step.findings.length) : '—',
  ]);

  const failures = report.steps.filter((step) => !step.passed && !step.skipped);

  const failureSections = failures.flatMap((step) => [
    `### ${step.id}`,
    '',
    step.command ? `Command: \`${step.command}\` (exit ${step.exitCode})` : '',
    '',
    ...(step.findings.length > 0
      ? step.findings.map(
          (finding) =>
            `- **${finding.severity}** \`${finding.rule}\` — ${finding.message}`,
        )
      : ['```', ...step.outputTail, '```']),
    '',
  ]);

  return [
    '# Certification Report',
    '',
    '> Generated by `pnpm repo:certify`. Do not edit by hand.',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Branch', cell(report.branch)],
        ['HEAD', cell(report.head)],
        ['Generated at', cell(report.generatedAt)],
        ['Result', report.passed ? '**PASSED**' : '**FAILED**'],
        [
          'Steps',
          `${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped`,
        ],
      ],
    ),
    '',
    '## Steps',
    '',
    markdownTable(['Step', 'Description', 'Result', 'Duration', 'Findings'], rows),
    '',
    ...(failures.length > 0 ? ['## Failures', '', ...failureSections] : []),
  ].join('\n');
}
