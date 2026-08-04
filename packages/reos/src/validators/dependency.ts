import path from 'node:path';
import { readJsonIfPresent, readTextIfPresent, walkFiles } from '../util/fsx.ts';
import { sortBy } from '../util/serialize.ts';
import type { DiscoverySnapshot, Finding, ValidationOutcome } from '../types.ts';

type ManifestShape = { dependencies?: Record<string, string> };

function collectWorkspaceImports(repoRoot: string, directory: string): Set<string> {
  const imports = new Set<string>();
  for (const file of walkFiles(path.join(repoRoot, directory), repoRoot)) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readTextIfPresent(path.join(repoRoot, file));
    if (text === null) continue;
    for (const match of text.matchAll(/from\s+['"](@assurapay\/[^'"/]+)['"]/g)) {
      imports.add(match[1]);
    }
  }
  return imports;
}

/** Depth-first cycle detection over the declared workspace dependency graph. */
export function detectCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (node: string, trail: string[]) => {
    const current = state.get(node);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = trail.indexOf(node);
      cycles.push([...trail.slice(start), node]);
      return;
    }

    state.set(node, 'visiting');
    for (const next of graph.get(node) ?? []) {
      visit(next, [...trail, node]);
    }
    state.set(node, 'done');
  };

  for (const node of [...graph.keys()].sort()) visit(node, []);
  return cycles;
}

/**
 * Validates that declared dependencies and real imports agree, that the graph is
 * acyclic, and that every engine package is reachable from an application.
 */
export function validateDependencies(
  repoRoot: string,
  discovery: DiscoverySnapshot,
): ValidationOutcome {
  const findings: Finding[] = [];
  let checked = 0;

  const graph = new Map<string, string[]>();
  const units = [
    ...discovery.packages.map((record) => ({
      name: record.name,
      directory: record.directory,
      declared: record.workspaceDependencies,
    })),
    ...discovery.applications.map((record) => ({
      name: record.name,
      directory: record.directory,
      declared: record.workspaceDependencies,
    })),
  ];

  for (const unit of units) {
    checked += 1;
    graph.set(unit.name, [...unit.declared].sort());

    const imported = collectWorkspaceImports(repoRoot, unit.directory);
    const declared = new Set(unit.declared);

    for (const specifier of [...imported].sort()) {
      if (specifier === unit.name) continue;
      if (declared.has(specifier)) continue;
      findings.push({
        rule: 'dependency/undeclared-import',
        severity: 'error',
        message: `${unit.directory} imports ${specifier} without declaring it in package.json.`,
        location: `${unit.directory}/package.json`,
      });
    }

    for (const specifier of [...declared].sort()) {
      if (imported.has(specifier)) continue;
      findings.push({
        rule: 'dependency/unused-declaration',
        severity: 'warning',
        message: `${unit.directory} declares ${specifier} but never imports it.`,
        location: `${unit.directory}/package.json`,
      });
    }

    // The workspace protocol keeps local packages from resolving to a registry.
    const manifest = readJsonIfPresent<ManifestShape>(
      path.join(repoRoot, unit.directory, 'package.json'),
    );
    for (const [specifier, range] of Object.entries(manifest?.dependencies ?? {})) {
      if (!specifier.startsWith('@assurapay/')) continue;
      if (range.startsWith('workspace:')) continue;
      findings.push({
        rule: 'dependency/workspace-protocol',
        severity: 'error',
        message: `${unit.directory} declares ${specifier}@${range}; workspace packages must use "workspace:*".`,
        location: `${unit.directory}/package.json`,
      });
    }
  }

  for (const cycle of detectCycles(graph)) {
    findings.push({
      rule: 'dependency/cycle',
      severity: 'error',
      message: `Dependency cycle: ${cycle.join(' → ')}.`,
      evidence: cycle,
    });
  }

  // An engine package no application depends on cannot be reached at runtime.
  const dependents = new Set(units.flatMap((unit) => unit.declared));
  for (const record of discovery.packages) {
    const shipsEngines = record.exportedClasses.some((name) =>
      name.endsWith('Engine'),
    );
    if (!shipsEngines || dependents.has(record.name)) continue;
    findings.push({
      rule: 'dependency/orphaned-engine-package',
      severity: 'warning',
      message:
        `${record.directory} exports engine classes but no package or application depends on it, ` +
        'so nothing can reach it at runtime.',
      location: `${record.directory}/package.json`,
    });
  }

  return {
    validator: 'dependencies',
    passed: findings.every((finding) => finding.severity !== 'error'),
    checked,
    findings: sortBy(findings, (finding) => `${finding.rule}:${finding.message}`),
  };
}
