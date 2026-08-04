#!/usr/bin/env node
/**
 * REOS command surface.
 *
 * Executed directly by Node using native TypeScript type stripping, which needs
 * Node >= 22.18. There is deliberately no build step and no runtime dependency:
 * the execution operating system must work in a freshly cloned repository.
 */
import { GOVERNANCE_POLICY, absolute, artifactPaths, resolveRepoRoot } from '../src/paths.ts';
import {
  readArtifact,
  runCertify,
  runDependencies,
  runDiscover,
  runForensicsStage,
  runGovernance,
  runManifest,
  runPipeline,
  runPlanning,
  runReport,
} from '../src/pipeline.ts';
import { loadGovernancePolicy, proposeBaseline } from '../src/governance.ts';
import { writeJsonArtifact } from '../src/util/serialize.ts';
import { REOS_VERSION } from '../src/types.ts';
import type { CertificationReport } from '../src/types.ts';

const COMMANDS = [
  'discover',
  'forensics',
  'manifest',
  'dependencies',
  'certify',
  'report',
  'next',
  'pipeline',
  'governance',
] as const;

type Command = (typeof COMMANDS)[number];

function requireSupportedNode(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) return;
  process.stderr.write(
    `REOS requires Node >= 22.18 for native TypeScript execution; found ${process.versions.node}.\n`,
  );
  process.exit(1);
}

function parseListFlag(argv: string[], flag: string): string[] | undefined {
  const entry = argv.find((value) => value.startsWith(`${flag}=`));
  if (!entry) return undefined;
  return entry
    .slice(flag.length + 1)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseValueFlag(argv: string[], flag: string): string | undefined {
  const entry = argv.find((value) => value.startsWith(`${flag}=`));
  return entry ? entry.slice(flag.length + 1) : undefined;
}

function usage(): string {
  return [
    `REOS ${REOS_VERSION} — Repository Execution Operating System`,
    '',
    'Usage: reos <command> [options]',
    '',
    'Commands:',
    '  discover        Stage 1 — snapshot repository state',
    '  forensics       Stage 2 — investigate capability presence across git',
    '  manifest        Stage 3 — regenerate the execution manifest',
    '  dependencies    Stage 4 — resolve the next executable capability',
    '  certify         Stage 6 — run every certification gate',
    '  report          Stage 7 — write the execution report',
    '  next            Stages 1–4, then print the selected capability',
    '  pipeline        Stages 1–7 end to end',
    '  governance      Evaluate the staged reconciliation policy',
    '',
    'Options:',
    '  --capability=<id>    Capability implemented in this session (report)',
    '  --only=<ids>         Run only these certification steps',
    '  --skip=<ids>         Skip these certification steps',
    '  --accept-baseline    Record current findings as pre-existing (governance)',
    '',
  ].join('\n');
}

function printSelection(repoRoot: string): number {
  const { manifest, resolution } = runPlanning(repoRoot);
  const selected = resolution.selected;

  const lines = [
    '',
    `REOS ${REOS_VERSION} — next executable capability`,
    '',
    `Repository : ${manifest.identity.repository} @ ${manifest.identity.head.slice(0, 7)}`,
    `Branch     : ${manifest.identity.branch}${manifest.identity.clean ? '' : ' (dirty)'}`,
    `Backlog    : ${manifest.executionBacklog.length} open, ${resolution.executable.length} executable, ${resolution.blocked.length} blocked`,
    '',
  ];

  if (!selected) {
    lines.push(
      'No executable capability. Every backlog item is blocked, deferred or complete.',
      '',
    );
    process.stdout.write(lines.join('\n'));
    return 0;
  }

  lines.push(
    'Selected:',
    `  ${selected.id}`,
    '',
    'Reason:',
    `  ${resolution.selectionReason ?? 'Highest-priority executable capability'}`,
    '',
    'Title:',
    `  ${selected.title}`,
    '',
    'Lifecycle:',
    `  ${selected.status} → ${selected.lifecycle}`,
    '',
    'Depends On:',
    ...(selected.dependsOn.length > 0
      ? selected.dependsOn.map(
          (id) => `  ${id}${selected.blockedBy.includes(id) ? '  [UNMET]' : ''}`,
        )
      : ['  (nothing)']),
    '',
    `Blocks (${selected.blocks.length} transitively):`,
    ...(selected.blocks.length > 0
      ? selected.blocks.slice(0, 10).map((id) => `  ${id}`)
      : ['  (nothing)']),
    ...(selected.blocks.length > 10
      ? [`  … and ${selected.blocks.length - 10} more`]
      : []),
    '',
    selected.scope.estimated ? 'Estimated Scope:' : 'Declared Evidence Scope:',
    `  ${selected.scope.files} file(s)`,
    `  ${selected.scope.tests} test suite(s)`,
    '',
  );

  if (selected.requiresLiveInfrastructure) {
    lines.push(
      'Warning:',
      '  Requires live infrastructure — credentials must be configured.',
      '',
    );
  }

  lines.push(
    'Next steps:',
    '  1. Read docs/governance/reos/EXECUTION_CONTRACT.md',
    `  2. Implement ${selected.id} in full — interfaces, registration, telemetry, tests, docs`,
    '  3. pnpm repo:certify',
    `  4. pnpm repo:report --capability=${selected.id}`,
    '',
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function main(): number {
  requireSupportedNode();

  const argv = process.argv.slice(2);
  const requested: string | undefined = argv[0];

  const isCommand = (value: string): value is Command =>
    (COMMANDS as readonly string[]).includes(value);

  if (!requested || requested === '--help' || requested === '-h') {
    process.stdout.write(usage());
    return 0;
  }

  if (!isCommand(requested)) {
    process.stderr.write(`Unknown command: ${requested}\n\n`);
    process.stdout.write(usage());
    return 1;
  }

  const command: Command = requested;

  const repoRoot = resolveRepoRoot();
  const certifyOptions = {
    only: parseListFlag(argv, '--only'),
    skip: parseListFlag(argv, '--skip'),
  };

  switch (command) {
    case 'discover': {
      const snapshot = runDiscover(repoRoot);
      process.stdout.write(
        `discover: ${snapshot.totals.packages} packages, ${snapshot.totals.applications} apps, ` +
          `${snapshot.totals.engines} engines, ${snapshot.totals.testFiles} test files, ` +
          `${snapshot.totals.migrations} migrations → ${artifactPaths().discovery}\n`,
      );
      return 0;
    }

    case 'forensics': {
      const discovery = runDiscover(repoRoot);
      const forensics = runForensicsStage(repoRoot, discovery);
      const summary = Object.entries(forensics.summary)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${status}`)
        .join(', ');
      process.stdout.write(`forensics: ${summary} → ${artifactPaths().forensics}\n`);
      return 0;
    }

    case 'manifest': {
      const discovery = runDiscover(repoRoot);
      const forensics = runForensicsStage(repoRoot, discovery);
      const manifest = runManifest(repoRoot, discovery, forensics);
      process.stdout.write(
        `manifest: ${manifest.engines.length} engines reconciled, ` +
          `${manifest.reconciliationFindings.length} reconciliation finding(s), ` +
          `${manifest.executionBacklog.length} backlog item(s) → ${artifactPaths().manifestJson}\n`,
      );
      return 0;
    }

    case 'dependencies': {
      const { manifest } = runPlanning(repoRoot);
      process.stdout.write(
        `dependencies: ${manifest.executionBacklog.length} backlog item(s) → ${artifactPaths().dependenciesJson}\n`,
      );
      return printSelection(repoRoot) === 0 ? 0 : 1;
    }

    case 'certify': {
      // Planning first: the governance gate needs a manifest to judge.
      const planning = runPlanning(repoRoot);
      const report = runCertify(repoRoot, planning.discovery, {
        ...certifyOptions,
        manifest: planning.manifest,
      });
      for (const step of report.steps) {
        const mark = step.skipped ? 'skip' : step.passed ? 'pass' : 'FAIL';
        process.stdout.write(`  [${mark}] ${step.id}\n`);
      }
      process.stdout.write(
        `certify: ${report.passed ? 'PASSED' : 'FAILED'} — ` +
          `${report.totals.passed}/${report.totals.executed} steps → ${artifactPaths().certificationJson}\n`,
      );
      return report.passed ? 0 : 1;
    }

    case 'report': {
      const { discovery, manifest, resolution } = runPlanning(repoRoot);
      // Reuse the certification from an earlier `repo:certify` when present.
      const certification = readArtifact<CertificationReport>(
        repoRoot,
        artifactPaths().certificationJson,
      );
      const report = runReport(
        repoRoot,
        discovery,
        manifest,
        resolution,
        certification,
        parseValueFlag(argv, '--capability') ?? null,
      );
      process.stdout.write(
        `report: ${report.filesModified.length} file(s) modified, certification ` +
          `${report.certification.available ? (report.certification.passed ? 'passed' : 'failed') : 'not run'} ` +
          `→ ${artifactPaths().reportMarkdown}\n`,
      );
      return 0;
    }

    case 'next':
      return printSelection(repoRoot);

    case 'governance': {
      const { manifest } = runPlanning(repoRoot);

      if (argv.includes('--accept-baseline')) {
        const policy = loadGovernancePolicy(repoRoot);
        const baseline = proposeBaseline(manifest);
        writeJsonArtifact(absolute(repoRoot, GOVERNANCE_POLICY), {
          ...policy,
          baseline,
        });
        process.stdout.write(
          `governance: recorded ${baseline.length} finding(s) as baselined in ${GOVERNANCE_POLICY}\n`,
        );
        return 0;
      }

      const evaluation = runGovernance(repoRoot, manifest);
      process.stdout.write(
        `governance: phase ${evaluation.phase} — ${evaluation.baselined} baselined, ` +
          `${evaluation.introduced.length} introduced, ${evaluation.resolved.length} stale baseline entry/-ies\n`,
      );
      for (const finding of evaluation.findings) {
        if (finding.severity === 'info') continue;
        process.stdout.write(`  [${finding.severity}] ${finding.rule} — ${finding.message}\n`);
      }
      return evaluation.passed ? 0 : 1;
    }

    case 'pipeline': {
      const result = runPipeline(repoRoot, {
        capability: parseValueFlag(argv, '--capability') ?? null,
        certify: certifyOptions,
      });
      process.stdout.write(
        `pipeline: certification ${result.certification?.passed ? 'PASSED' : 'FAILED'}, ` +
          `${result.manifest.executionBacklog.length} backlog item(s) remaining\n`,
      );
      return result.certification?.passed ? 0 : 1;
    }

    default:
      process.stdout.write(usage());
      return 1;
  }
}

process.exit(main());
