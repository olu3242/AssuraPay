import { describe, expect, it } from 'vitest';
import {
  buildExecutionManifest,
  discover,
  loadRegistry,
  resolveDependencies,
  resolveRepoRoot,
  runForensics,
  stableStringify,
  validateArchitecture,
  validateDependencies,
  validateSecurity,
} from './index.ts';

// These stage functions are pure with respect to the filesystem: they read the
// repository and return values without writing artifacts, so the suite can run
// the real pipeline against the real repository without mutating it.
const repoRoot = resolveRepoRoot();
const registry = loadRegistry(repoRoot);
const discovery = discover(repoRoot);

describe('integration: stage 1 discovers the real repository', () => {
  it('finds the workspace packages, the web application and the engine catalog', () => {
    expect(discovery.repository.name).toBe('assurapay');
    expect(discovery.packages.length).toBeGreaterThanOrEqual(20);
    expect(discovery.applications.map((app) => app.name)).toContain('@assurapay/web');
    expect(discovery.engines).toHaveLength(60);
    expect(discovery.engines.at(-1)?.id).toBe('60');
  });

  it('covers all six waves', () => {
    expect([...new Set(discovery.engines.map((engine) => engine.wave))].sort()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('inventories migrations and identifies the row-level-security migration', () => {
    expect(discovery.migrations.length).toBeGreaterThanOrEqual(20);
    expect(
      discovery.migrations.some((migration) => migration.declaresRowLevelSecurity),
    ).toBe(true);
  });

  it('inventories CI workflows', () => {
    expect(discovery.workflows.map((workflow) => workflow.path)).toContain(
      '.github/workflows/ci.yml',
    );
  });

  it('discovers every certify script as a certification target', () => {
    expect(discovery.certificationTargets.length).toBeGreaterThan(50);
    expect(
      discovery.certificationTargets.some(
        (target) => target.script === 'certify:non-custody',
      ),
    ).toBe(true);
  });

  it('produces identical bytes when run twice against unchanged state', () => {
    expect(stableStringify(discover(repoRoot))).toBe(stableStringify(discovery));
  });
});

describe('integration: stage 2 investigates capabilities against git', () => {
  const forensics = runForensics(repoRoot, discovery, registry);

  it('classifies every registered capability', () => {
    expect(forensics.capabilities).toHaveLength(registry.capabilities.length);
    for (const capability of forensics.capabilities) {
      expect(capability.totalProbes).toBeGreaterThan(0);
      expect(capability.rationale.length).toBeGreaterThan(0);
    }
  });

  it('records the head commit it investigated', () => {
    expect(forensics.head).toBe(discovery.repository.git.head);
  });

  it('finds REOS itself implemented, since its own evidence is present', () => {
    const reos = forensics.capabilities.find(
      (capability) => capability.id === 'reos.execution-os',
    );
    expect(reos?.status).toBe('implemented');
  });
});

describe('integration: stage 3 reconciles the engine catalog', () => {
  const forensics = runForensics(repoRoot, discovery, registry);
  const manifest = buildExecutionManifest(repoRoot, discovery, forensics, registry);

  it('reconciles all 60 engines and maps them to packages where they exist', () => {
    expect(manifest.engines).toHaveLength(60);
    // Engines 01-05 and 11-60 map to packages; 06-10 are deferred trust engines.
    const mapped = manifest.engines.filter((engine) => engine.packageDirectory !== null);
    expect(mapped.length).toBe(55);
  });

  it('reads the canonical chain from CLAUDE.md', () => {
    expect(manifest.architecture.canonicalChain[0]).toBe('Contract');
    expect(manifest.architecture.canonicalChain).toContain('CompletionCertificate');
  });

  it('flags the certify batch numbering as colliding with catalog engine numbers', () => {
    const collisions = manifest.reconciliationFindings.filter(
      (finding) => finding.rule === 'catalog/certification-numbering-collision',
    );
    // certify:execution..certify:payment-triggers use 06-10 for governance-core,
    // while catalog engines 06-10 are the deferred trust engines.
    expect(collisions.length).toBe(5);
  });

  it('flags packages that ship engines outside the catalog', () => {
    const unmapped = manifest.reconciliationFindings
      .filter((finding) => finding.rule === 'catalog/unmapped-engine-package')
      .map((finding) => finding.location);
    expect(unmapped).toContain('packages/agent-runtime/src/index.ts');
    expect(unmapped).toContain('packages/workflow-intelligence/src/index.ts');
  });

  it('builds a dependency graph covering platform capabilities and engines', () => {
    expect(manifest.dependencyGraph.length).toBe(
      registry.capabilities.length + manifest.engines.length,
    );
  });
});

describe('integration: stage 4 resolves a next capability from the real manifest', () => {
  const forensics = runForensics(repoRoot, discovery, registry);
  const manifest = buildExecutionManifest(repoRoot, discovery, forensics, registry);
  const resolution = resolveDependencies(manifest);

  it('selects an executable capability and explains every rejection', () => {
    expect(resolution.selected).not.toBeNull();
    expect(resolution.selected?.executable).toBe(true);
    for (const rejection of resolution.rejected) {
      expect(rejection.reason.length).toBeGreaterThan(0);
    }
  });

  it('never selects a capability that is already implemented', () => {
    expect(resolution.completed).not.toContain(resolution.selected?.id);
  });

  it('lists the live-infrastructure capabilities separately', () => {
    expect(resolution.awaitingInfrastructure).toContain(
      'persistence.rls-certification',
    );
  });

  it('resolves deterministically across repeated runs', () => {
    expect(stableStringify(resolveDependencies(manifest))).toBe(
      stableStringify(resolution),
    );
  });
});

describe('integration: validators run clean against the repository', () => {
  it('passes architecture validation', () => {
    const outcome = validateArchitecture(repoRoot, discovery);
    expect(
      outcome.findings.filter((finding) => finding.severity === 'error'),
    ).toEqual([]);
    expect(outcome.passed).toBe(true);
  });

  it('passes dependency validation with no undeclared imports', () => {
    const outcome = validateDependencies(repoRoot, discovery);
    expect(
      outcome.findings.filter((finding) => finding.severity === 'error'),
    ).toEqual([]);
  });

  it('passes security validation, proving no custody primitive exists', () => {
    const outcome = validateSecurity(repoRoot);
    expect(
      outcome.findings.filter((finding) => finding.severity === 'error'),
    ).toEqual([]);
    expect(outcome.checked).toBeGreaterThan(50);
  });
});
