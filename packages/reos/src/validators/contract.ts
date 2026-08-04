import path from 'node:path';
import { readTextIfPresent } from '../util/fsx.ts';
import { changedFiles, defaultBranchRef } from '../util/git.ts';
import { declaresRuleVocabulary } from './exemption.ts';
import { artifactDirectory } from '../paths.ts';
import { sortBy } from '../util/serialize.ts';
import type { DiscoverySnapshot, Finding, ValidationOutcome } from '../types.ts';

/*
 * reos:rule-vocabulary — this file defines the marker vocabulary it scans for.
 */

/**
 * Stage 5 — the execution contract.
 *
 * Enforced against the files a session actually changed rather than the whole
 * repository: the contract governs new work, and pre-existing debt is reported
 * separately so it stays visible without blocking every future change.
 */
const PLACEHOLDER_MARKERS = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /\bHACK\b/,
  /\bplaceholder\b/i,
  /\bnot\s+implemented\b/i,
  /\bcoming\s+soon\b/i,
];

const NOT_IMPLEMENTED_THROW = /throw\s+new\s+Error\(\s*['"`][^'"`]*not\s+implemented/i;


/** Resolves the comparison base: the repository's default branch. */
export function resolveBase(repoRoot: string): string | null {
  return defaultBranchRef(repoRoot);
}

function isSourceFile(file: string): boolean {
  return /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file);
}

function owningPackage(file: string, discovery: DiscoverySnapshot): string | null {
  const match = discovery.packages.find((record) =>
    file.startsWith(`${record.directory}/`),
  );
  return match ? match.directory : null;
}

export function validateExecutionContract(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  options: { base?: string | null } = {},
): ValidationOutcome {
  const findings: Finding[] = [];
  const base = options.base === undefined ? resolveBase(repoRoot) : options.base;
  const artifacts = `${artifactDirectory()}/`;
  const changed = changedFiles(repoRoot, base).filter(
    (file) =>
      /\.(tsx?|js|mjs|json|md|sql|ya?ml)$/.test(file) &&
      // REOS artifacts are generated output, not authored implementation, and
      // they quote finding messages verbatim.
      !file.startsWith(artifacts),
  );

  const changedSources = changed.filter(isSourceFile);
  const changedTests = changed.filter((file) => /\.(test|spec)\.tsx?$/.test(file));

  for (const file of changed) {
    const text = readTextIfPresent(path.join(repoRoot, file));
    if (text === null) continue;

    // Markdown legitimately discusses marker conventions, and exempt files
    // declare the markers they are allowed to name.
    if (file.endsWith('.md')) continue;
    if (declaresRuleVocabulary(text)) continue;

    for (const marker of PLACEHOLDER_MARKERS) {
      const match = marker.exec(text);
      if (!match) continue;
      findings.push({
        rule: 'contract/placeholder-marker',
        severity: 'error',
        message: `${file} contains "${match[0]}". The execution contract rejects placeholders and TODOs.`,
        location: file,
      });
    }

    if (NOT_IMPLEMENTED_THROW.test(text)) {
      findings.push({
        rule: 'contract/not-implemented',
        severity: 'error',
        message: `${file} throws a "not implemented" error. Ship a complete implementation or nothing.`,
        location: file,
      });
    }
  }

  // Changed engine source requires tests in the same package.
  const touchedPackages = new Set(
    changedSources
      .map((file) => owningPackage(file, discovery))
      .filter((value): value is string => value !== null),
  );

  for (const directory of [...touchedPackages].sort()) {
    const record = discovery.packages.find((entry) => entry.directory === directory);
    if (!record) continue;

    if (record.testFiles.length === 0) {
      findings.push({
        rule: 'contract/missing-tests',
        severity: 'error',
        message: `${directory} was modified but contains no test files.`,
        location: `${directory}/src`,
      });
      continue;
    }

    const hasChangedTest = changedTests.some((file) =>
      file.startsWith(`${directory}/`),
    );
    if (!hasChangedTest) {
      findings.push({
        rule: 'contract/tests-not-updated',
        severity: 'warning',
        message: `${directory} has modified source but no modified tests in this change.`,
        location: `${directory}/src`,
      });
    }
  }

  // Money-movement changes must carry a non-custody assertion (CLAUDE.md).
  const moneyPackages = ['packages/settlement-assurance', 'packages/settlement-execution'];
  for (const directory of moneyPackages) {
    if (!touchedPackages.has(directory)) continue;
    const guarded = changedTests.some((file) => file.includes('non-custody'));
    if (guarded) continue;
    findings.push({
      rule: 'contract/non-custody-test-required',
      severity: 'error',
      message:
        `${directory} contains money-movement logic and was modified without touching its ` +
        'non-custody test suite.',
      location: `${directory}/src`,
    });
  }

  // New engine classes must be registered somewhere or they are unreachable.
  for (const file of changedSources) {
    const text = readTextIfPresent(path.join(repoRoot, file));
    if (text === null) continue;
    for (const match of text.matchAll(/export\s+class\s+([A-Za-z0-9_]+Engine)\b/g)) {
      if (!discovery.runtime.unregisteredEngines.includes(match[1])) continue;
      findings.push({
        rule: 'contract/missing-registration',
        severity: 'warning',
        message: `${match[1]} is exported from ${file} but not instantiated in any composition root.`,
        location: file,
      });
    }
  }

  return {
    validator: 'execution-contract',
    passed: findings.every((finding) => finding.severity !== 'error'),
    checked: changed.length,
    findings: sortBy(findings, (finding) => `${finding.rule}:${finding.message}`),
  };
}
