import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'out',
  'coverage',
  'dist',
]);

/**
 * Recursively lists files below `root`, returning repository-relative POSIX
 * paths in sorted order. Sorting is what makes discovery deterministic across
 * filesystems, which order directory entries differently.
 */
export function walkFiles(root: string, repoRoot: string): string[] {
  if (!existsSync(root)) return [];
  const collected: string[] = [];

  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        visit(absolute);
      } else if (entry.isFile()) {
        collected.push(toRelative(absolute, repoRoot));
      }
    }
  };

  if (statSync(root).isFile()) return [toRelative(root, repoRoot)];
  visit(root);
  return collected.sort();
}

export function toRelative(absolute: string, repoRoot: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

export function listDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function readText(absolute: string): string {
  return readFileSync(absolute, 'utf8');
}

export function readTextIfPresent(absolute: string): string | null {
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

export function readJson<T>(absolute: string): T {
  return JSON.parse(readFileSync(absolute, 'utf8')) as T;
}

export function readJsonIfPresent<T>(absolute: string): T | null {
  return existsSync(absolute) ? readJson<T>(absolute) : null;
}

export function countLines(absolute: string): number {
  const text = readFileSync(absolute, 'utf8');
  if (text.length === 0) return 0;
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Minimal glob matcher supporting `*` (within a segment) and `**` (across
 * segments). REOS deliberately avoids a glob dependency: evidence patterns are
 * checked into the repository and must resolve identically everywhere.
 */
export function matchGlob(pattern: string, candidate: string): boolean {
  const expression = pattern
    .split('/')
    .map((segment) => {
      if (segment === '**') return '(?:.+)';
      return segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    })
    .join('/')
    .replace(/\(\?:\.\+\)\//g, '(?:.+/)?');

  return new RegExp(`^${expression}$`).test(candidate);
}

export function matchAny(patterns: string[], candidate: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, candidate));
}
