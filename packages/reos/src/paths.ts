import path from 'node:path';
import { existsSync } from 'node:fs';
import { repositoryRoot } from './util/git.ts';

/** Directory holding hand-written REOS governance documents. */
export const GOVERNANCE_DIRECTORY = 'docs/governance/reos';

/** Directory holding REOS-generated artifacts. Committed: agents read them. */
export const ARTIFACT_DIRECTORY = 'docs/governance/reos/generated';

/**
 * Artifact locations. `REOS_ARTIFACT_DIR` redirects them, which lets a session
 * generate artifacts without touching the committed set — used for dry runs and
 * for proving determinism by diffing two generations.
 */
export function artifactPaths(directory: string = artifactDirectory()) {
  return {
    discovery: `${directory}/discovery.json`,
    forensics: `${directory}/forensics.json`,
    manifestJson: `${directory}/execution-manifest.json`,
    manifestMarkdown: `${directory}/EXECUTION_MANIFEST.md`,
    dependenciesJson: `${directory}/dependency-resolution.json`,
    dependenciesMarkdown: `${directory}/DEPENDENCY_RESOLUTION.md`,
    certificationJson: `${directory}/certification.json`,
    certificationMarkdown: `${directory}/CERTIFICATION_REPORT.md`,
    reportJson: `${directory}/execution-report.json`,
    reportMarkdown: `${directory}/EXECUTION_REPORT.md`,
  };
}

export function artifactDirectory(): string {
  return process.env.REOS_ARTIFACT_DIR ?? ARTIFACT_DIRECTORY;
}

/** Default artifact locations, for documentation and status messages. */
export const ARTIFACTS = artifactPaths(ARTIFACT_DIRECTORY);

export const CAPABILITY_REGISTRY = `${GOVERNANCE_DIRECTORY}/capability-registry.json`;

export const GOVERNANCE_POLICY = `${GOVERNANCE_DIRECTORY}/governance-policy.json`;

/** Append-only execution history. Never redirected by REOS_ARTIFACT_DIR. */
export const LEDGER_DIRECTORY = 'docs/governance/execution-ledger';

/**
 * Resolves the repository root from `cwd`, preferring git and falling back to a
 * search for the workspace marker so REOS still works in an exported tree.
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const fromGit = repositoryRoot(cwd);
  if (existsSync(path.join(fromGit, 'pnpm-workspace.yaml'))) return fromGit;

  let current = path.resolve(cwd);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fromGit;
}

/** Resolves against the repository root, honouring absolute overrides. */
export function absolute(repoRoot: string, relativePath: string): string {
  return path.resolve(repoRoot, relativePath);
}
