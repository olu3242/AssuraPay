import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './util/fsx.ts';
import { stableStringify, writeArtifact, writeJsonArtifact } from './util/serialize.ts';
import { LEDGER_DIRECTORY, absolute } from './paths.ts';
import type {
  CapabilityLifecycle,
  CertificationReport,
  ExecutionManifest,
  LedgerEntry,
  ValidationOutcome,
} from './types.ts';

/**
 * The execution ledger is append-only, in the same spirit as CLAUDE.md hard
 * constraint 3: one immutable file per execution, never rewritten. `INDEX.md` is
 * the one derived file, regenerated from the entries on every append.
 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 12);
}

/**
 * Entry identity is the commit plus the capability, so re-running `repo:report`
 * for the same execution updates nothing and appends nothing.
 */
export function ledgerEntryId(commit: string, capabilityId: string | null): string {
  return `${commit.slice(0, 12)}-${capabilityId ?? 'no-capability'}`.replace(
    /[^a-zA-Z0-9.-]/g,
    '_',
  );
}

export function listLedgerEntries(repoRoot: string): LedgerEntry[] {
  const directory = absolute(repoRoot, LEDGER_DIRECTORY);
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson<LedgerEntry>(path.join(directory, name)))
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export function buildLedgerEntry(input: {
  manifest: ExecutionManifest;
  validation: ValidationOutcome[];
  certification: CertificationReport | null;
  capabilityId: string | null;
  lifecycle: CapabilityLifecycle | null;
  branch: string;
  commit: string;
  recordedAt?: string;
}): LedgerEntry {
  const failedSteps = (input.certification?.steps ?? [])
    .filter((step) => !step.passed && !step.skipped)
    .map((step) => step.id);

  return {
    entryId: ledgerEntryId(input.commit, input.capabilityId),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    capabilityId: input.capabilityId,
    lifecycle: input.lifecycle,
    branch: input.branch,
    commit: input.commit,
    manifestDigest: input.manifest.manifestDigest,
    validation: input.validation.map((outcome) => ({
      validator: outcome.validator,
      passed: outcome.passed,
      errors: outcome.findings.filter((finding) => finding.severity === 'error').length,
      warnings: outcome.findings.filter((finding) => finding.severity === 'warning')
        .length,
    })),
    certification: {
      available: input.certification !== null,
      passed: input.certification?.passed ?? false,
      failedSteps,
    },
    supersedes: input.manifest.implementedCapabilities.filter(
      (id) => id !== input.capabilityId,
    ),
  };
}

/**
 * Appends an entry unless one already exists for this commit and capability.
 * Returns the entry id in both cases so the caller can reference it.
 */
export function appendLedgerEntry(repoRoot: string, entry: LedgerEntry): {
  entryId: string;
  appended: boolean;
} {
  const file = absolute(repoRoot, `${LEDGER_DIRECTORY}/${entry.entryId}.json`);

  if (existsSync(file)) {
    // Append-only: an existing execution record is never rewritten.
    renderLedgerIndex(repoRoot);
    return { entryId: entry.entryId, appended: false };
  }

  writeJsonArtifact(file, entry);
  renderLedgerIndex(repoRoot);
  return { entryId: entry.entryId, appended: true };
}

export function renderLedgerIndex(repoRoot: string): void {
  const entries = listLedgerEntries(repoRoot);

  const rows = entries.map((entry) => {
    const validationSummary = entry.validation.every((outcome) => outcome.passed)
      ? 'pass'
      : 'fail';
    return `| ${entry.recordedAt} | \`${entry.capabilityId ?? '—'}\` | ${
      entry.lifecycle ?? '—'
    } | \`${entry.branch}\` | \`${entry.commit.slice(0, 7)}\` | ${validationSummary} | ${
      entry.certification.passed ? 'pass' : 'fail'
    } | \`${entry.manifestDigest}\` |`;
  });

  const contents = [
    '# Execution Ledger',
    '',
    '> Append-only history of REOS executions. Generated index — the `*.json`',
    '> entries beside it are the records and are never rewritten.',
    '',
    `${entries.length} execution(s) recorded.`,
    '',
    '| Recorded at | Capability | Lifecycle | Branch | Commit | Validation | Certification | Manifest |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');

  writeArtifact(absolute(repoRoot, `${LEDGER_DIRECTORY}/INDEX.md`), contents);
}
