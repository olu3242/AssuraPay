import { runCommand } from './exec.ts';
import type { GitState } from '../types.ts';

/** Runs git and returns trimmed stdout, or null when the command fails. */
export function git(args: string[], cwd: string): string | null {
  const result = runCommand('git', args, { cwd, timeoutMs: 120_000 });
  return result.ok ? result.stdout.trim() : null;
}

function lines(value: string | null): string[] {
  if (!value) return [];
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function repositoryRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
}

export function readGitState(cwd: string): GitState {
  const porcelain = git(['status', '--porcelain'], cwd) ?? '';
  const dirtyFiles = lines(porcelain)
    .map((line) => line.slice(3).trim())
    .sort();

  const head = git(['rev-parse', 'HEAD'], cwd) ?? 'unknown';

  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown',
    head,
    headShort: head === 'unknown' ? 'unknown' : head.slice(0, 7),
    clean: dirtyFiles.length === 0,
    dirtyFiles,
    upstream:
      git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd) ??
      null,
    remotes: lines(git(['remote'], cwd)).sort(),
    branches: lines(
      git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], cwd),
    ).sort(),
    tags: lines(git(['tag'], cwd)).sort(),
    reflogAvailable: (git(['reflog', '--max-count=1'], cwd) ?? '').length > 0,
  };
}

/** Refs whose tree contains `symbol`, using git grep against each ref. */
export function refsContainingSymbol(
  symbol: string,
  refs: string[],
  cwd: string,
): string[] {
  const found: string[] = [];
  for (const ref of refs) {
    const result = runCommand(
      'git',
      ['grep', '--fixed-strings', '--files-with-matches', symbol, ref, '--', '*.ts', '*.tsx', '*.sql'],
      { cwd, timeoutMs: 60_000 },
    );
    if (result.ok && result.stdout.trim().length > 0) found.push(ref);
  }
  return found.sort();
}

/** Commits that added or removed `symbol` anywhere in history (pickaxe search). */
export function commitsTouchingSymbol(
  symbol: string,
  cwd: string,
  limit = 5,
): string[] {
  const output = git(
    [
      'log',
      '--all',
      '--oneline',
      `--max-count=${limit}`,
      `-S${symbol}`,
      '--',
      '*.ts',
      '*.tsx',
      '*.sql',
    ],
    cwd,
  );
  return lines(output);
}

/** True when `ref` is already merged into HEAD. */
export function isMergedIntoHead(ref: string, cwd: string): boolean {
  const result = runCommand('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
    cwd,
    timeoutMs: 60_000,
  });
  return result.exitCode === 0;
}

/** Files changed in the working tree plus any commits ahead of `base`. */
export function changedFiles(cwd: string, base: string | null): string[] {
  // --untracked-files=all lists new files individually; the default collapses a
  // new directory to a single entry, which would under-count a new package.
  const working = lines(
    git(['status', '--porcelain', '--untracked-files=all'], cwd),
  ).map((line) => line.slice(3).trim());
  const committed = base
    ? lines(git(['diff', '--name-only', `${base}...HEAD`], cwd))
    : [];
  return [...new Set([...working, ...committed])].sort();
}
