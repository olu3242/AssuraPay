import path from 'node:path';
import { readTextIfPresent } from '../util/fsx.ts';
import { cell, markdownTable, sortBy } from '../util/serialize.ts';
import {
  buildBacklog,
  buildEngineNodes,
  buildPlatformNodes,
  computeBlocks,
  engineNodeId,
  lifecycleByNode,
  type CapabilityNode,
} from '../backlog.ts';
import { summariseLifecycle } from '../lifecycle.ts';
import { defaultBranchRef, pathExistsAtRef } from '../util/git.ts';
import { digestOf } from '../ledger.ts';
import { REOS_VERSION } from '../types.ts';
import type {
  CapabilityLifecycle,
  CapabilityRegistry,
  CapabilityStatus,
  CertificationReport,
  DiscoverySnapshot,
  EngineReconciliation,
  ExecutionManifest,
  Finding,
  ForensicsReport,
} from '../types.ts';

/**
 * Reads the canonical aggregate chain from CLAUDE.md so it cannot drift.
 *
 * Anchored on the phrase that introduces it. CLAUDE.md contains more than one
 * backticked arrow-chain — the capability lifecycle is also written that way — so
 * matching the first arrow found would pick up whichever appears earliest.
 */
export function parseCanonicalChain(claudeMd: string | null): string[] {
  if (!claudeMd) return [];

  const anchored = /canonical chain is\s*`([^`]*→[^`]*)`/i.exec(claudeMd);
  const match = anchored ?? /`([^`]*→[^`]*)`/.exec(claudeMd);
  if (!match) return [];

  return match[1]
    .split('→')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function normaliseDeclaredStatus(declared: string | null): CapabilityStatus | null {
  if (!declared) return null;
  const value = declared.toLowerCase();
  if (value.includes('deferred')) return 'deferred';
  if (value.includes('conditionally implemented')) return 'partial';
  if (value.includes('foundation only')) return 'partial';
  if (value.includes('implemented')) return 'implemented';
  return null;
}

/**
 * Observed engine status is derived from repository evidence only: does a
 * package exist, does it carry tests, and is it wired to a certification
 * script. The catalog's declared status is treated as a claim to be checked.
 */
export function reconcileEngines(
  discovery: DiscoverySnapshot,
  registry: CapabilityRegistry,
): EngineReconciliation[] {
  const packagesByDirectory = new Map(
    discovery.packages.map((record) => [record.directory, record]),
  );

  return discovery.engines.map((engine) => {
    const packageDirectory = registry.enginePackages[engine.id] ?? null;
    const record = packageDirectory
      ? packagesByDirectory.get(packageDirectory)
      : undefined;

    // Prefer a script numerically bound to this engine. Fall back to an
    // unnumbered script for the same package (engines 01–05 are certified that
    // way) only when no numbered script claims the engine.
    const certificationTarget =
      discovery.certificationTargets.find(
        (target) =>
          target.packageDirectory === packageDirectory &&
          target.testNamePattern === engine.id,
      ) ??
      discovery.certificationTargets.find(
        (target) =>
          target.packageDirectory === packageDirectory &&
          target.testNamePattern === null &&
          !discovery.certificationTargets.some(
            (other) =>
              other.packageDirectory === packageDirectory &&
              other.testNamePattern !== null,
          ),
      );

    const declared = normaliseDeclaredStatus(engine.declaredStatus);

    let observedStatus: CapabilityStatus;
    if (!packageDirectory) {
      observedStatus = declared === 'deferred' ? 'deferred' : 'missing';
    } else if (!record) {
      observedStatus = 'missing';
    } else if (record.testFiles.length === 0) {
      observedStatus = 'partial';
    } else if (!certificationTarget) {
      observedStatus = 'partial';
    } else {
      observedStatus = 'implemented';
    }

    return {
      id: engine.id,
      name: engine.name,
      wave: engine.wave,
      declaredStatus: engine.declaredStatus,
      observedStatus,
      // Replaced with the derived value once the dependency graph exists.
      lifecycle: 'missing' as CapabilityLifecycle,
      packageDirectory,
      certificationScript: certificationTarget?.script ?? null,
      divergent: declared !== null && declared !== observedStatus,
    };
  });
}

/**
 * Reconciliation findings are the point of the manifest: they name every place
 * the repository disagrees with its own documentation.
 */
export function buildReconciliationFindings(
  discovery: DiscoverySnapshot,
  registry: CapabilityRegistry,
  engines: EngineReconciliation[],
): Finding[] {
  const findings: Finding[] = [];
  const mappedPackages = new Set(
    Object.values(registry.enginePackages).filter(
      (value): value is string => value !== null,
    ),
  );

  // The certify:* scripts use a batch numbering that can collide with catalog
  // engine numbers. A collision means one number denotes two different things.
  for (const target of discovery.certificationTargets) {
    if (!target.testNamePattern || !/^\d{1,2}$/.test(target.testNamePattern)) continue;
    const engineId = target.testNamePattern.padStart(2, '0');
    const engine = engines.find((candidate) => candidate.id === engineId);
    if (!engine) continue;

    const expected = registry.enginePackages[engineId] ?? null;
    if (target.packageDirectory === expected) continue;

    findings.push({
      rule: 'catalog/certification-numbering-collision',
      severity: 'warning',
      message:
        `${target.script} certifies ${target.packageDirectory} using batch number ${target.testNamePattern}, ` +
        `but catalog engine ${engineId} (${engine.name}) maps to ` +
        `${expected ?? 'no implementation package'}. The certify:* batch numbering and the ` +
        'catalog engine numbering are two different identifier spaces using the same numbers.',
      location: 'package.json',
      subject: target.script,
      evidence: [target.command],
    });
  }

  // Packages that ship engine classes but sit outside the 60-engine catalog.
  for (const record of discovery.packages) {
    if (mappedPackages.has(record.directory)) continue;
    const engineClasses = record.exportedClasses.filter((name) =>
      name.endsWith('Engine'),
    );
    if (engineClasses.length === 0) continue;
    findings.push({
      rule: 'catalog/unmapped-engine-package',
      severity: 'warning',
      message:
        `${record.directory} exports ${engineClasses.length} engine class(es) but is not mapped to any ` +
        'catalog engine, so its scope is not represented in docs/ENGINE_CATALOG.md.',
      location: `${record.directory}/src/index.ts`,
      subject: record.directory,
      evidence: engineClasses.slice(0, 8),
    });
  }

  for (const engine of engines) {
    if (!engine.divergent) continue;
    findings.push({
      rule: 'catalog/status-divergence',
      severity: 'warning',
      message:
        `Engine ${engine.id} (${engine.name}) is declared "${engine.declaredStatus}" ` +
        `but repository evidence shows "${engine.observedStatus}".`,
      location: 'docs/ENGINE_CATALOG.md',
      subject: `engine:${engine.id}`,
    });
  }

  for (const name of discovery.runtime.duplicatedEngines) {
    const owners = discovery.packages
      .filter((record) => record.exportedClasses.includes(name))
      .map((record) => record.directory);
    findings.push({
      rule: 'runtime/duplicate-abstraction',
      severity: 'error',
      message: `${name} is exported by ${owners.length} packages, which duplicates an abstraction.`,
      subject: name,
      evidence: owners,
    });
  }

  if (discovery.runtime.unregisteredEngines.length > 0) {
    findings.push({
      rule: 'runtime/unregistered-engine',
      severity: 'warning',
      message:
        `${discovery.runtime.unregisteredEngines.length} exported engine class(es) are not instantiated in any ` +
        'composition root, so they are unreachable at runtime.',
      subject: 'runtime',
      evidence: discovery.runtime.unregisteredEngines.slice(0, 12),
    });
  }

  return sortBy(findings, (finding) => `${finding.rule}:${finding.message}`);
}

/** Stage 3 — the authoritative execution input for future agents. */
export function buildExecutionManifest(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  forensics: ForensicsReport,
  registry: CapabilityRegistry,
  certification: CertificationReport | null = null,
): ExecutionManifest {
  const engines = reconcileEngines(discovery, registry);

  const waves = [...new Set(discovery.engines.map((engine) => engine.wave))]
    .sort((left, right) => left - right)
    .map((wave) => ({
      wave,
      name:
        discovery.engines.find((engine) => engine.wave === wave)?.waveName ??
        `Wave ${wave}`,
      engines: discovery.engines
        .filter((engine) => engine.wave === wave)
        .map((engine) => engine.id)
        .sort(),
    }));

  // Which engine packages already exist on the default branch. One git probe per
  // distinct package, so the cost is bounded by package count, not engine count.
  const defaultRef = defaultBranchRef(repoRoot);
  const releasedPackages = new Set<string>();
  if (defaultRef) {
    const candidates = new Set(
      engines
        .map((engine) => engine.packageDirectory)
        .filter((value): value is string => value !== null),
    );
    for (const directory of candidates) {
      if (pathExistsAtRef(defaultRef, `${directory}/package.json`, repoRoot)) {
        releasedPackages.add(directory);
      }
    }
  }

  const nodes: CapabilityNode[] = [
    ...buildPlatformNodes(registry, forensics.capabilities),
    ...buildEngineNodes(engines, releasedPackages),
  ];

  const scripted = discovery.certificationTargets.map((target) => target.script);
  const unscripted = discovery.packages
    .filter(
      (record) =>
        !discovery.certificationTargets.some(
          (target) => target.packageDirectory === record.directory,
        ),
    )
    .map((record) => record.directory);

  const lifecycles = lifecycleByNode(nodes, certification);
  const blocks = computeBlocks(nodes);

  // Engine lifecycle is derived from the same graph the backlog uses, so the two
  // can never disagree about how far an engine has progressed.
  const reconciledEngines: EngineReconciliation[] = engines.map((engine) => ({
    ...engine,
    lifecycle: lifecycles.get(engineNodeId(engine.id)) ?? 'missing',
  }));

  const manifest: Omit<ExecutionManifest, 'manifestDigest'> = {
    reosVersion: REOS_VERSION,
    stage: 'manifest',
    identity: {
      repository: discovery.repository.name,
      version: discovery.repository.version,
      branch: discovery.repository.git.branch,
      head: discovery.repository.git.head,
      clean: discovery.repository.git.clean,
    },
    architecture: {
      waves,
      canonicalChain: parseCanonicalChain(
        readTextIfPresent(path.join(repoRoot, 'CLAUDE.md')),
      ),
      packageCount: discovery.packages.length,
      applicationCount: discovery.applications.length,
    },
    packages: discovery.packages,
    applications: discovery.applications,
    engines: reconciledEngines,
    runtime: discovery.runtime,
    platformCapabilities: forensics.capabilities,
    implementedCapabilities: nodes
      .filter((node) => node.status === 'implemented')
      .map((node) => node.id)
      .sort(),
    missingCapabilities: nodes
      .filter((node) => node.status === 'missing' || node.status === 'lost')
      .map((node) => node.id)
      .sort(),
    lifecycleSummary: summariseLifecycle([...lifecycles.values()]),
    certification: {
      targets: discovery.certificationTargets.length,
      scripted,
      unscripted,
    },
    dependencyGraph: sortBy(
      nodes.map((node) => ({
        id: node.id,
        dependsOn: node.dependsOn,
        blocks: blocks.get(node.id) ?? [],
        status: node.status,
        lifecycle: lifecycles.get(node.id) ?? 'missing',
      })),
      (node) => node.id,
    ),
    executionBacklog: buildBacklog(nodes, certification),
    reconciliationFindings: buildReconciliationFindings(
      discovery,
      registry,
      reconciledEngines,
    ),
  };

  // The digest covers the manifest without itself, so it identifies content
  // rather than depending on its own value.
  return { ...manifest, manifestDigest: digestOf(manifest) };
}

export function renderExecutionManifest(manifest: ExecutionManifest): string {
  const engineRows = manifest.engines.map((engine) => [
    engine.id,
    cell(engine.name),
    String(engine.wave),
    cell(engine.declaredStatus),
    engine.observedStatus,
    engine.lifecycle,
    cell(engine.packageDirectory),
    engine.divergent ? '**yes**' : 'no',
  ]);

  const lifecycleById = new Map(
    manifest.dependencyGraph.map((node) => [node.id, node.lifecycle]),
  );

  const capabilityRows = manifest.platformCapabilities.map((capability) => [
    cell(capability.id),
    cell(capability.title),
    capability.status,
    cell(lifecycleById.get(capability.id)),
    `${capability.satisfiedProbes}/${capability.totalProbes}`,
    cell(capability.rationale),
  ]);

  const backlogRows = manifest.executionBacklog
    .slice(0, 25)
    .map((entry) => [
      cell(entry.id),
      cell(entry.title),
      entry.lifecycle,
      String(entry.priority),
      entry.executable ? 'yes' : 'no',
      entry.blockedBy.length > 0 ? cell(entry.blockedBy.join(', ')) : '—',
      entry.blocks.length > 0 ? String(entry.blocks.length) : '—',
    ]);

  const findingRows = manifest.reconciliationFindings.map((finding) => [
    finding.severity,
    cell(finding.rule),
    cell(finding.message),
  ]);

  return [
    '# Repository Execution Manifest',
    '',
    '> Generated by `pnpm repo:manifest`. Do not edit by hand — REOS overwrites this file.',
    '> The machine-readable twin at `execution-manifest.json` is the authoritative execution input.',
    '',
    '## Identity',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Repository', cell(manifest.identity.repository)],
        ['Version', cell(manifest.identity.version)],
        ['Branch', cell(manifest.identity.branch)],
        ['HEAD', cell(manifest.identity.head)],
        ['Worktree clean', manifest.identity.clean ? 'yes' : 'no'],
        ['Manifest digest', cell(manifest.manifestDigest)],
        ['REOS version', cell(manifest.reosVersion)],
      ],
    ),
    '',
    '## Architecture',
    '',
    `- Packages: ${manifest.architecture.packageCount}`,
    `- Applications: ${manifest.architecture.applicationCount}`,
    `- Waves: ${manifest.architecture.waves.length}`,
    `- Canonical chain: ${manifest.architecture.canonicalChain.join(' → ') || '—'}`,
    '',
    '## Lifecycle summary',
    '',
    markdownTable(
      ['Lifecycle', 'Count'],
      Object.entries(manifest.lifecycleSummary)
        .filter(([, count]) => count > 0)
        .map(([state, count]) => [state, String(count)]),
    ),
    '',
    '## Engine reconciliation',
    '',
    'Declared status comes from `docs/ENGINE_CATALOG.md`. Observed status is derived',
    'from repository evidence: package presence, test files, and certification wiring.',
    '',
    markdownTable(
      ['#', 'Engine', 'Wave', 'Declared', 'Observed', 'Lifecycle', 'Package', 'Divergent'],
      engineRows,
    ),
    '',
    '## Platform capabilities',
    '',
    markdownTable(
      ['Capability', 'Title', 'Status', 'Lifecycle', 'Probes', 'Rationale'],
      capabilityRows,
    ),
    '',
    '## Reconciliation findings',
    '',
    findingRows.length > 0
      ? markdownTable(['Severity', 'Rule', 'Finding'], findingRows)
      : 'No reconciliation findings.',
    '',
    '## Execution backlog',
    '',
    `${manifest.executionBacklog.length} open item(s). Highest-priority first.`,
    '',
    backlogRows.length > 0
      ? markdownTable(
          ['Capability', 'Title', 'Lifecycle', 'Priority', 'Executable', 'Blocked by', 'Blocks'],
          backlogRows,
        )
      : 'Backlog empty.',
    '',
    '## Certification coverage',
    '',
    `- Certification scripts: ${manifest.certification.targets}`,
    `- Packages without a certification script: ${
      manifest.certification.unscripted.join(', ') || 'none'
    }`,
    '',
  ].join('\n');
}
