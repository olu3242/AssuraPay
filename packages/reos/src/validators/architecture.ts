import path from 'node:path';
import { readTextIfPresent, walkFiles } from '../util/fsx.ts';
import { sortBy } from '../util/serialize.ts';
import type { DiscoverySnapshot, Finding, ValidationOutcome } from '../types.ts';

/**
 * Engines 01–05 live in bounded workspace packages. CLAUDE.md forbids them from
 * reaching into later waves, and forbids extending AssuraPayService with
 * trust-engine logic.
 */
export const TRUST_FOUNDATION_PACKAGES = [
  'packages/identity',
  'packages/organizations',
  'packages/permissions',
  'packages/parties',
  'packages/legal',
];

/** Infrastructure a trust package may depend on without crossing a boundary. */
const TRUST_ALLOWED_DEPENDENCIES = new Set([
  '@assurapay/shared',
  '@assurapay/database',
]);

const TRUST_PACKAGE_NAMES = new Set([
  '@assurapay/identity',
  '@assurapay/organizations',
  '@assurapay/permissions',
  '@assurapay/parties',
  '@assurapay/legal',
]);

function collectImports(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/from\s+['"](@assurapay\/[^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(/import\s*\(\s*['"](@assurapay\/[^'"]+)['"]\s*\)/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** Validates package boundaries, alias wiring and the trust-foundation rules. */
export function validateArchitecture(
  repoRoot: string,
  discovery: DiscoverySnapshot,
): ValidationOutcome {
  const findings: Finding[] = [];
  let checked = 0;

  const tsconfig = readTextIfPresent(path.join(repoRoot, 'tsconfig.json')) ?? '';
  const vitestConfig =
    readTextIfPresent(path.join(repoRoot, 'vitest.config.ts')) ?? '';

  for (const record of discovery.packages) {
    checked += 1;
    const expectedName = `@assurapay/${path.basename(record.directory)}`;

    if (record.name !== expectedName) {
      findings.push({
        rule: 'architecture/package-name',
        severity: 'error',
        message: `${record.directory} declares name "${record.name}"; convention requires "${expectedName}".`,
        location: `${record.directory}/package.json`,
      });
    }

    if (record.main !== 'src/index.ts') {
      findings.push({
        rule: 'architecture/package-entrypoint',
        severity: 'error',
        message: `${record.directory} declares main "${record.main}"; convention requires "src/index.ts".`,
        location: `${record.directory}/package.json`,
      });
    }

    // A package unreachable through the alias map cannot be imported by name.
    if (!tsconfig.includes(`"${record.name}"`)) {
      findings.push({
        rule: 'architecture/tsconfig-alias-drift',
        severity: 'error',
        message: `${record.name} has no path mapping in tsconfig.json.`,
        location: 'tsconfig.json',
      });
    }
    if (!vitestConfig.includes(`'${record.name}'`)) {
      findings.push({
        rule: 'architecture/vitest-alias-drift',
        severity: 'error',
        message: `${record.name} has no resolve alias in vitest.config.ts.`,
        location: 'vitest.config.ts',
      });
    }
  }

  for (const record of discovery.packages) {
    // Every source file, not just the barrel: a package that grows a second
    // module would otherwise carry unchecked imports across the boundary.
    const sources = walkFiles(path.join(repoRoot, record.directory), repoRoot).filter(
      (file) => /\.tsx?$/.test(file),
    );

    for (const file of sources) {
      const text = readTextIfPresent(path.join(repoRoot, file));
      if (text === null) continue;
      checked += 1;

      for (const specifier of collectImports(text)) {
        // Deep imports bypass the package's public surface.
        if (specifier.split('/').length > 2) {
          findings.push({
            rule: 'architecture/deep-import',
            severity: 'error',
            message: `${file} imports "${specifier}"; only the package root is a supported entrypoint.`,
            location: file,
          });
        }

        if (
          TRUST_FOUNDATION_PACKAGES.includes(record.directory) &&
          !TRUST_ALLOWED_DEPENDENCIES.has(specifier)
        ) {
          findings.push({
            rule: 'architecture/trust-boundary',
            severity: 'error',
            message:
              `${file} is in a trust-foundation package (engines 01–05) and imports "${specifier}". ` +
              'Trust packages may only depend on @assurapay/shared and @assurapay/database.',
            location: file,
          });
        }
      }
    }
  }

  // CLAUDE.md: "Do not extend AssuraPayService with new trust-engine logic."
  const domainIndex = readTextIfPresent(
    path.join(repoRoot, 'packages/domain/src/index.ts'),
  );
  if (domainIndex !== null) {
    checked += 1;
    for (const specifier of collectImports(domainIndex)) {
      if (!TRUST_PACKAGE_NAMES.has(specifier)) continue;
      findings.push({
        rule: 'architecture/assurapay-service-boundary',
        severity: 'error',
        message:
          `packages/domain imports "${specifier}". AssuraPayService must not absorb trust-engine logic; ` +
          'compose trust engines at the application composition root instead.',
        location: 'packages/domain/src/index.ts',
      });
    }
  }

  return {
    validator: 'architecture',
    passed: findings.every((finding) => finding.severity !== 'error'),
    checked,
    findings: sortBy(findings, (finding) => `${finding.rule}:${finding.message}`),
  };
}
