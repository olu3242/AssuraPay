import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './util/fsx.ts';
import { stableStringify, writeArtifact, writeJsonArtifact } from './util/serialize.ts';
import { LEDGER_DIRECTORY, absolute } from './paths.ts';
import type {
  CapabilityLifecycle,
  CapabilityProbeCount,
  CertificationReport,
  ExecutionManifest,
  LedgerEntry,
  LedgerLifecycleContradiction,
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

/**
 * Capabilities whose **most recent** ledger entry records a passing full
 * certification while the repository can see none of their declared evidence.
 *
 * The two facts contradict each other. Zero satisfied probes out of a non-zero
 * declared set is what makes a capability derive `missing` or `planned` — the
 * states meaning "this does not exist yet". A passing certification is a record
 * that the repository's whole gate ran green over work reported *for this
 * capability*. Both cannot be true, and when they disagree it is the probe that
 * is wrong, because certification measured the repository while the probe
 * measured a name — and a name can point at a file that was never written.
 *
 * This function exists because that happened, undetected, for thirteen
 * consecutive executions. `persistence.domain-store-durability` declared probes
 * naming `packages/database/src/domain-store.ts`, `PostgresDomainStore` and
 * `DOMAIN_AGGREGATE_OWNERSHIP` — none of which has ever existed here, as git
 * confirms: no commit ever created or deleted any of them. They described a
 * design superseded before it was built. So no probe could ever be satisfied,
 * the lifecycle stayed `planned`, `repo:next` selected the same capability every
 * time as the highest-priority unstarted work, and thirteen ledger entries
 * recorded `passed: true` beside it while thirteen batches shipped.
 *
 * Two deliberate choices about what is compared, each avoiding a trap:
 *
 *   * the **current** probe count rather than the lifecycle frozen in the entry.
 *     Comparing an entry against itself would make certification depend on a
 *     ledger entry that can only be written after certification passes, which is
 *     a deadlock: the gate could never go green again once it went red. Judging
 *     the recorded claim against the live measurement means redrawing the
 *     evidence fixes it on the next run, which is the point;
 *   * the **latest** entry per capability. The historical entries for this very
 *     defect are contradictory, and they are also history — CLAUDE.md's third
 *     hard constraint is that it is never mutated in place, so they stay exactly
 *     as recorded. What must hold is the live claim.
 */
export function ledgerLifecycleContradictions(
  entries: LedgerEntry[],
  current: CapabilityProbeCount[],
): LedgerLifecycleContradiction[] {
  const unseen = new Map(
    current
      .filter((probe) => probe.totalProbes > 0 && probe.satisfiedProbes === 0)
      .map((probe) => [probe.id, probe]),
  );

  const latest = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    if (!entry.capabilityId) continue;
    const incumbent = latest.get(entry.capabilityId);
    // `listLedgerEntries` sorts by `recordedAt`, but this must not depend on the
    // caller having done so.
    if (!incumbent || entry.recordedAt >= incumbent.recordedAt)
      latest.set(entry.capabilityId, entry);
  }

  return [...latest.values()]
    .filter(
      (entry) =>
        entry.certification.passed && unseen.has(entry.capabilityId as string),
    )
    .map((entry) => ({
      capabilityId: entry.capabilityId as string,
      entryId: entry.entryId,
      lifecycle: entry.lifecycle,
      recordedAt: entry.recordedAt,
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
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
