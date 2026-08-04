import { runCommand } from './exec.ts';
import type { GitState } from '../types.ts';

/** Runs git and returns trimmed stdout, or null when the command fails. */
export function git(args: string[], cwd: string): string | null {
  const result = runCommand('git', args, { cwd, timeoutMs: 120_000 });
  return result.ok ? result.stdout.trim() : null;
}

/**
 * Runs git preserving stdout exactly. Porcelain status records begin with a
 * significant space (` M file`), which a trimming read would strip from the
 * first line only — corrupting one path and no others.
 */
export function gitRaw(args: string[], cwd: string): string | null {
  const result = runCommand('git', args, { cwd, timeoutMs: 120_000 });
  return result.ok ? result.stdout : null;
}

function lines(value: string | null): string[] {
  if (!value) return [];
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Parses `git status --porcelain` paths.
 *
 * Each record is `XY<space>path`, so the path starts at index 3. The leading
 * status characters must not be trimmed first: ` M file` would become `M file`
 * and a fixed slice would then eat the first character of the filename.
 * Renames arrive as `old -> new`; the destination is the current path.
 */
export function parsePorcelainPaths(porcelain: string | null): string[] {
  if (!porcelain) return [];

  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const raw = line.slice(3);
      const arrow = raw.indexOf(' -> ');
      const candidate = arrow === -1 ? raw : raw.slice(arrow + 4);
      // git quotes paths containing unusual characters.
      return candidate.replace(/^"(.*)"$/, '$1').trim();
    })
    .filter((candidate) => candidate.length > 0);
}

export function repositoryRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
}

export function readGitState(cwd: string): GitState {
  const dirtyFiles = parsePorcelainPaths(
    gitRaw(['status', '--porcelain', '--untracked-files=all'], cwd),
  ).sort();

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
  const working = parsePorcelainPaths(
    gitRaw(['status', '--porcelain', '--untracked-files=all'], cwd),
  );
  const committed = base
    ? lines(git(['diff', '--name-only', `${base}...HEAD`], cwd))
    : [];
  return [...new Set([...working, ...committed])].sort();
}
