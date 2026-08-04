import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * JSON.stringify with recursively sorted object keys.
 *
 * Determinism for stages 1–4 depends on two things: every collection is sorted
 * explicitly by the stage that builds it, and object key order cannot leak
 * construction order into the bytes on disk. This handles the second.
 */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = sortKeys(source[key]);
  }
  return sorted;
}

export function writeArtifact(absolutePath: string, contents: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

export function writeJsonArtifact(absolutePath: string, value: unknown): void {
  writeArtifact(absolutePath, stableStringify(value));
}

/** Sorts a copy of `items` by a string key, so callers never mutate inputs. */
export function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}

export function markdownTable(headers: string[], rows: string[][]): string {
  const divider = headers.map(() => '---');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** Escapes pipes so free text cannot break a Markdown table row. */
export function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
