import path from 'node:path';
import { readTextIfPresent, walkFiles } from '../util/fsx.ts';
import { git } from '../util/git.ts';
import { sortBy } from '../util/serialize.ts';
import { declaresRuleVocabulary } from './exemption.ts';
import type { Finding, ValidationOutcome } from '../types.ts';

/*
 * reos:rule-vocabulary — this file names forbidden primitives in order to forbid them.
 */

/**
 * CLAUDE.md hard constraint 1 — "No custody, ever."
 *
 * This list mirrors the per-package non-custody suites in
 * packages/settlement-assurance and packages/settlement-execution. Those tests
 * guard one file each; this validator guards the whole repository, so a new
 * package cannot introduce a custody primitive without a test to catch it.
 */
export const CUSTODY_PRIMITIVES = [
  'holdFunds',
  'takeCustody',
  'debitAccount',
  'creditAccount',
  'transferFunds',
  'poolFunds',
  'sweepFunds',
  'commingleFunds',
];

/**
 * CLAUDE.md hard constraint 2 — "Every release is certified-work-backed."
 * No unconditional release path may exist.
 */
export const UNCONDITIONAL_RELEASE_PRIMITIVES = [
  'forceRelease',
  'releaseNow',
  'releaseWithoutCertificate',
  'skipCertificate',
  'bypassEligibility',
  'overrideHold',
];

/** CLAUDE.md hard constraint 3 — append-only history, never mutated in place. */
const HISTORY_MUTATION_SOURCE =
  '\\b(audit\\w*|history\\w*|event\\w*|ledger\\w*|outbox\\w*)\\.(splice|pop|shift|reverse|sort)\\s*\\(';

const SECRET_LITERAL_SOURCE =
  '\\b(secret|apiKey|privateKey|serviceRoleKey|accessToken|password)\\w*\\s*[:=]\\s*[\'"]([^\'"]{12,})[\'"]';

/**
 * Builds a fresh global regex per scan. A shared `/g` literal carries its
 * `lastIndex` between `matchAll` calls, which silently skips matches in every
 * file after the first.
 */
function globalPattern(source: string, flags = 'g'): RegExp {
  return new RegExp(source, flags);
}

const SECRET_PLACEHOLDERS = /^(replace-me|changeme|example|sandbox|test|placeholder)/i;

const SEARCH_ROOTS = ['packages', 'apps', 'scripts'];

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}

/**
 * Production source only.
 *
 * Test files are excluded deliberately: the repository's convention is that a
 * non-custody suite names each forbidden primitive in order to assert its
 * absence, so scanning tests would flag the very suites that enforce the
 * constraint. Tests also never reach a deployed runtime.
 */
function sourceFiles(repoRoot: string): string[] {
  return SEARCH_ROOTS.flatMap((root) =>
    walkFiles(path.join(repoRoot, root), repoRoot),
  ).filter((file) => /\.(tsx?|js|mjs)$/.test(file) && !isTestFile(file));
}

/** Validates the non-custody, certified-release and audit-immutability rules. */
export function validateSecurity(repoRoot: string): ValidationOutcome {
  const findings: Finding[] = [];
  const files = sourceFiles(repoRoot);

  for (const file of files) {
    const text = readTextIfPresent(path.join(repoRoot, file));
    if (text === null) continue;

    for (const primitive of CUSTODY_PRIMITIVES) {
      if (!new RegExp(`\\b${primitive}\\s*\\(`).test(text)) continue;
      findings.push({
        rule: 'security/custody-primitive',
        severity: 'error',
        message:
          `${file} defines or calls "${primitive}()". Money movement must go through the certified ` +
          "Financial Provider's own API via a Provider Adapter; AssuraPay never takes custody.",
        location: file,
      });
    }

    for (const primitive of UNCONDITIONAL_RELEASE_PRIMITIVES) {
      if (!new RegExp(`\\b${primitive}\\s*\\(`).test(text)) continue;
      findings.push({
        rule: 'security/unconditional-release',
        severity: 'error',
        message:
          `${file} exposes "${primitive}()", which implies a release path that bypasses the ` +
          'Completion Certificate, Payment Eligibility and authority approval chain.',
        location: file,
      });
    }

    for (const match of text.matchAll(globalPattern(HISTORY_MUTATION_SOURCE))) {
      findings.push({
        rule: 'security/audit-mutation',
        severity: 'error',
        message:
          `${file} calls ${match[1]}.${match[2]}(), which mutates an append-only collection in place. ` +
          'Audit history must only ever be appended to.',
        location: file,
      });
    }

    // A file defining the secret-shaped pattern necessarily contains it.
    const secretScannable = !declaresRuleVocabulary(text);
    for (const match of secretScannable
      ? text.matchAll(globalPattern(SECRET_LITERAL_SOURCE, 'gi'))
      : []) {
      if (SECRET_PLACEHOLDERS.test(match[2])) continue;
      findings.push({
        rule: 'security/plaintext-secret',
        severity: 'error',
        message: `${file} assigns a literal value to "${match[1]}"; secrets must come from configuration.`,
        location: file,
      });
    }
  }

  // A tracked .env leaks real credentials into history permanently.
  const trackedEnv = git(['ls-files', '.env', '**/.env'], repoRoot);
  if (trackedEnv && trackedEnv.trim().length > 0) {
    for (const file of trackedEnv.split('\n').filter((line) => line.trim())) {
      findings.push({
        rule: 'security/committed-env',
        severity: 'error',
        message: `${file.trim()} is tracked by git. Environment files must stay untracked.`,
        location: file.trim(),
      });
    }
  }

  return {
    validator: 'security',
    passed: findings.every((finding) => finding.severity !== 'error'),
    checked: files.length,
    findings: sortBy(findings, (finding) => `${finding.rule}:${finding.message}`),
  };
}
