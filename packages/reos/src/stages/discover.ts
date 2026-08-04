import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  countLines,
  listDirectories,
  readJsonIfPresent,
  readTextIfPresent,
  walkFiles,
} from '../util/fsx.ts';
import { readGitState } from '../util/git.ts';
import { sortBy } from '../util/serialize.ts';
import { REOS_VERSION } from '../types.ts';
import type {
  AdrRecord,
  ApplicationRecord,
  CertificationTarget,
  DiscoverySnapshot,
  DocumentRecord,
  EngineRecord,
  MigrationRecord,
  PackageRecord,
  RuntimeRegistration,
  TestCounts,
  TestKind,
  WorkflowRecord,
} from '../types.ts';

type PackageJsonShape = {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const EMPTY_TEST_COUNTS = (): TestCounts => ({
  unit: 0,
  integration: 0,
  e2e: 0,
  security: 0,
  performance: 0,
});

export function classifyTestFile(filePath: string): TestKind | null {
  if (!/\.(test|spec)\.tsx?$/.test(filePath)) return null;
  if (/\.integration\.(test|spec)\./.test(filePath)) return 'integration';
  if (/\.e2e\.(test|spec)\./.test(filePath)) return 'e2e';
  if (/\.security\.(test|spec)\./.test(filePath)) return 'security';
  if (/\.performance\.(test|spec)\./.test(filePath)) return 'performance';
  return 'unit';
}

/**
 * Parses the engine catalog tables. Wave 1 carries a Status column and later
 * waves do not, so declaredStatus is optional by design.
 */
export function parseEngineCatalog(markdown: string): EngineRecord[] {
  const engines: EngineRecord[] = [];
  let wave = 0;
  let waveName = '';

  for (const line of markdown.split('\n')) {
    // Matches "## Wave 1 — Trust Foundation (01–10)" with an en dash or hyphen.
    const heading = /^##\s+Wave\s+(\d+)\s*[—-]\s*([^(]+)/.exec(line);
    if (heading) {
      wave = Number(heading[1]);
      waveName = heading[2].trim();
      continue;
    }

    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((value) => value.trim());
    if (cells.length < 3) continue;
    if (!/^\d{1,2}$/.test(cells[0])) continue;

    engines.push({
      id: cells[0].padStart(2, '0'),
      name: cells[1],
      wave,
      waveName,
      responsibility: cells[2],
      declaredStatus: cells.length >= 4 && cells[3].length > 0 ? cells[3] : null,
    });
  }

  return sortBy(engines, (engine) => engine.id);
}

/** Extracts the package directory and test-name filter from a certify script. */
export function parseCertificationTarget(
  script: string,
  command: string,
): CertificationTarget {
  const packageMatch = /(packages\/[a-z0-9-]+)/.exec(command);
  const patternMatch = /--testNamePattern=([^\s]+)/.exec(command);
  return {
    script,
    command,
    packageDirectory: packageMatch ? packageMatch[1] : null,
    testNamePattern: patternMatch ? patternMatch[1] : null,
  };
}

function discoverPackages(repoRoot: string): PackageRecord[] {
  const records: PackageRecord[] = [];

  for (const directoryName of listDirectories(path.join(repoRoot, 'packages'))) {
    const directory = `packages/${directoryName}`;
    const manifest = readJsonIfPresent<PackageJsonShape>(
      path.join(repoRoot, directory, 'package.json'),
    );
    if (!manifest) continue;

    const files = walkFiles(path.join(repoRoot, directory), repoRoot);
    const sourceFiles = files.filter(
      (file) => /\.tsx?$/.test(file) && classifyTestFile(file) === null,
    );
    const testFiles = files.filter((file) => classifyTestFile(file) !== null);

    const tests = EMPTY_TEST_COUNTS();
    for (const file of testFiles) {
      const kind = classifyTestFile(file);
      if (kind) tests[kind] += 1;
    }

    const exportedClasses = new Set<string>();
    let sourceLines = 0;
    for (const file of sourceFiles) {
      const text = readTextIfPresent(path.join(repoRoot, file));
      if (text === null) continue;
      sourceLines += countLines(path.join(repoRoot, file));
      for (const match of text.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)) {
        exportedClasses.add(match[1]);
      }
    }

    const dependencies = Object.keys(manifest.dependencies ?? {});
    records.push({
      name: manifest.name ?? directoryName,
      directory,
      main: manifest.main ?? null,
      moduleType: manifest.type ?? null,
      workspaceDependencies: dependencies
        .filter((dependency) => dependency.startsWith('@assurapay/'))
        .sort(),
      externalDependencies: dependencies
        .filter((dependency) => !dependency.startsWith('@assurapay/'))
        .sort(),
      sourceFiles: sourceFiles.length,
      sourceLines,
      exportedClasses: [...exportedClasses].sort(),
      testFiles: testFiles.sort(),
      tests,
    });
  }

  return sortBy(records, (record) => record.directory);
}

function discoverApplications(repoRoot: string): ApplicationRecord[] {
  const records: ApplicationRecord[] = [];

  for (const directoryName of listDirectories(path.join(repoRoot, 'apps'))) {
    const directory = `apps/${directoryName}`;
    const manifest = readJsonIfPresent<PackageJsonShape>(
      path.join(repoRoot, directory, 'package.json'),
    );
    if (!manifest) continue;

    const dependencies = Object.keys(manifest.dependencies ?? {});
    const routes = walkFiles(path.join(repoRoot, directory, 'app'), repoRoot).filter(
      (file) => /\/page\.tsx?$/.test(file),
    );

    records.push({
      name: manifest.name ?? directoryName,
      directory,
      framework: dependencies.includes('next') ? 'next' : 'unknown',
      routes: routes.length,
      workspaceDependencies: dependencies
        .filter((dependency) => dependency.startsWith('@assurapay/'))
        .sort(),
    });
  }

  return sortBy(records, (record) => record.directory);
}

/**
 * A composition root is any file under an application's `lib` directory that
 * instantiates engines. Registration is observable as `new XEngine(`.
 */
function discoverRuntime(
  repoRoot: string,
  applications: ApplicationRecord[],
  packages: PackageRecord[],
) {
  const registrations: RuntimeRegistration[] = [];

  for (const application of applications) {
    const libraryFiles = walkFiles(
      path.join(repoRoot, application.directory, 'lib'),
      repoRoot,
    ).filter((file) => /\.tsx?$/.test(file));

    for (const file of libraryFiles) {
      const text = readTextIfPresent(path.join(repoRoot, file));
      if (text === null) continue;
      const registered = new Set<string>();
      for (const match of text.matchAll(/new\s+([A-Za-z0-9_]*(?:Engine|Service|Provider))\s*\(/g)) {
        registered.add(match[1]);
      }
      if (registered.size === 0) continue;
      registrations.push({
        compositionRoot: file,
        registeredEngines: [...registered].sort(),
      });
    }
  }

  const exportedCounts = new Map<string, number>();
  for (const record of packages) {
    for (const exported of record.exportedClasses) {
      exportedCounts.set(exported, (exportedCounts.get(exported) ?? 0) + 1);
    }
  }

  const registeredEverywhere = new Set(
    registrations.flatMap((registration) => registration.registeredEngines),
  );
  const exportedEngines = [...exportedCounts.keys()].sort();

  return {
    registrations: sortBy(registrations, (record) => record.compositionRoot),
    exportedEngines,
    unregisteredEngines: exportedEngines.filter(
      (name) => !registeredEverywhere.has(name),
    ),
    duplicatedEngines: exportedEngines.filter(
      (name) => (exportedCounts.get(name) ?? 0) > 1,
    ),
  };
}

function discoverDocumentation(repoRoot: string): DocumentRecord[] {
  const files = walkFiles(path.join(repoRoot, 'docs'), repoRoot).filter((file) =>
    file.endsWith('.md'),
  );

  return files.map((file) => {
    const text = readTextIfPresent(path.join(repoRoot, file)) ?? '';
    const heading = /^#\s+(.+)$/m.exec(text);
    const segments = file.split('/');
    return {
      path: file,
      title: heading ? heading[1].trim() : path.basename(file, '.md'),
      category: segments.length > 2 ? segments[1] : 'root',
    };
  });
}

function discoverAdrs(repoRoot: string, documents: DocumentRecord[]): AdrRecord[] {
  const records: AdrRecord[] = [];

  for (const document of documents) {
    if (!/adr/i.test(document.path)) continue;
    const text = readTextIfPresent(path.join(repoRoot, document.path)) ?? '';
    // Accepts "## ADR-001 — Title" and "## ADR 1: Title".
    for (const match of text.matchAll(/^#{2,3}\s+(ADR[\s-]?\d+)\s*[—:-]?\s*(.*)$/gim)) {
      records.push({
        path: document.path,
        identifier: match[1].replace(/\s+/g, '-').toUpperCase(),
        title: match[2].trim() || document.title,
      });
    }
  }

  return sortBy(records, (record) => `${record.path}:${record.identifier}`);
}

function discoverMigrations(repoRoot: string): MigrationRecord[] {
  const files = walkFiles(path.join(repoRoot, 'supabase/migrations'), repoRoot).filter(
    (file) => file.endsWith('.sql'),
  );

  return files.map((file) => {
    const text = readTextIfPresent(path.join(repoRoot, file)) ?? '';
    const base = path.basename(file, '.sql');
    const separator = base.indexOf('_');
    return {
      id: separator > 0 ? base.slice(0, separator) : base,
      name: separator > 0 ? base.slice(separator + 1) : base,
      path: file,
      declaresRowLevelSecurity: /enable\s+row\s+level\s+security/i.test(text),
      declaresPolicies: [...text.matchAll(/create\s+policy/gi)].length,
    };
  });
}

function discoverWorkflows(repoRoot: string): WorkflowRecord[] {
  const files = walkFiles(path.join(repoRoot, '.github/workflows'), repoRoot).filter(
    (file) => /\.ya?ml$/.test(file),
  );

  return files.map((file) => {
    const text = readTextIfPresent(path.join(repoRoot, file)) ?? '';
    const lines = text.split('\n');
    const nameMatch = /^name:\s*(.+)$/m.exec(text);
    const nodeMatch = /node-version:\s*['"]?([\d.]+)['"]?/.exec(text);

    const triggers: string[] = [];
    const jobs: string[] = [];
    let section: 'on' | 'jobs' | null = null;

    for (const line of lines) {
      if (/^on:\s*$/.test(line)) {
        section = 'on';
        continue;
      }
      if (/^jobs:\s*$/.test(line)) {
        section = 'jobs';
        continue;
      }
      if (/^\S/.test(line)) {
        section = null;
        continue;
      }
      const entry = /^ {2}([A-Za-z_][\w-]*):/.exec(line);
      if (!entry) continue;
      if (section === 'on') triggers.push(entry[1]);
      if (section === 'jobs') jobs.push(entry[1]);
    }

    return {
      path: file,
      name: nameMatch ? nameMatch[1].trim() : path.basename(file),
      triggers: triggers.sort(),
      jobs: jobs.sort(),
      nodeVersion: nodeMatch ? nodeMatch[1] : null,
    };
  });
}

/** Stage 1 — deterministic snapshot of everything REOS can observe. */
export function discover(repoRoot: string): DiscoverySnapshot {
  const rootManifest =
    readJsonIfPresent<PackageJsonShape>(path.join(repoRoot, 'package.json')) ?? {};

  const packages = discoverPackages(repoRoot);
  const applications = discoverApplications(repoRoot);
  const documentation = discoverDocumentation(repoRoot);

  const catalogPath = path.join(repoRoot, 'docs/ENGINE_CATALOG.md');
  const engines = existsSync(catalogPath)
    ? parseEngineCatalog(readTextIfPresent(catalogPath) ?? '')
    : [];

  const certificationTargets = sortBy(
    Object.entries(rootManifest.scripts ?? {})
      .filter(([script]) => script.startsWith('certify:'))
      .map(([script, command]) => parseCertificationTarget(script, command)),
    (target) => target.script,
  );

  const migrations = discoverMigrations(repoRoot);

  const byKind = EMPTY_TEST_COUNTS();
  let testFileTotal = 0;
  for (const record of packages) {
    for (const kind of Object.keys(byKind) as TestKind[]) {
      byKind[kind] += record.tests[kind];
    }
    testFileTotal += record.testFiles.length;
  }

  return {
    reosVersion: REOS_VERSION,
    stage: 'discover',
    repository: {
      name: rootManifest.name ?? 'unknown',
      version: rootManifest.version ?? '0.0.0',
      packageManager: rootManifest.packageManager ?? null,
      git: readGitState(repoRoot),
    },
    packages,
    applications,
    engines,
    certificationTargets,
    runtime: discoverRuntime(repoRoot, applications, packages),
    documentation,
    adrs: discoverAdrs(repoRoot, documentation),
    migrations,
    tests: { files: testFileTotal, byKind },
    workflows: discoverWorkflows(repoRoot),
    totals: {
      packages: packages.length,
      applications: applications.length,
      engines: engines.length,
      documents: documentation.length,
      migrations: migrations.length,
      testFiles: testFileTotal,
    },
  };
}
