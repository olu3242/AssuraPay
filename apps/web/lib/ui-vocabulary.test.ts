import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The interface speaks the user's language, and shows no figure it did not read.
 *
 * Two defects this guards, both of which had shipped and neither of which any existing test could
 * see, because a page that renders the wrong words type-checks perfectly.
 *
 * **Engine vocabulary.** Ten pages rendered the engine catalogue: five cards each labelled
 * `Engine 16`, `Engine 17` and so on, with an internal capability name and a line about workspace
 * scoping and versioning. That tells a customer which part of the codebase they are looking at,
 * which is of no use to them, and made the product read as a list of features rather than software.
 * The catalogue still exists in `docs/ENGINE_CATALOG.md`, which is where it belongs.
 *
 * **Invented figures.** `/workflow-intelligence` displayed execution health 82, progress 74%, SLA
 * adherence 91%, three bottlenecks, and a panel reading "Approval delay risk: 34%" and "Settlement
 * readiness: 68%" — all constants in the file, identical for every visitor and every workspace,
 * under a caption claiming they were advisory output awaiting human review. The landing page had
 * already recorded removing exactly this kind of fabrication; this page still did it, for figures of
 * the sort a delivery lead acts on.
 *
 * The second assertion is necessarily heuristic — it cannot tell a real percentage from an invented
 * one — so it works the only way it honestly can: a literal percentage or score in page source is
 * refused outright, because a figure about the customer's own execution has to come from the
 * customer's own data, and a server component has no authenticated caller to read it with.
 */

const APP = path.join(__dirname, '..', 'app');

function pageSources(): Array<{ file: string; source: string }> {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
    });

  return walk(APP).map((file) => ({
    file: path.relative(APP, file),
    // Comments are stripped: these files explain the vocabulary they removed, and a guard that
    // matched its own documentation would push whoever hit it into deleting the explanation.
    source: readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'),
  }));
}

const pages = pageSources();

describe('the interface does not expose the engine catalogue', () => {
  it('reads the pages at all, so this cannot pass vacuously', () => {
    expect(pages.length).toBeGreaterThan(20);
    expect(pages.map((page) => page.file)).toContain('page.tsx');
  });

  it('renders no engine number', () => {
    // `Engine {16 + i}` was the exact shape, so both the interpolated and literal forms are refused.
    const offenders = pages.filter((page) => /Engine\s*\{|Engine\s+\d/.test(page.source));
    expect(offenders.map((page) => page.file)).toEqual([]);
  });

  it('does not name the engine catalogue or its numbering in anything rendered', () => {
    const offenders = pages.filter((page) =>
      /\b\d{2}-engine\b|\bengine catalog/i.test(page.source),
    );
    expect(offenders.map((page) => page.file)).toEqual([]);
  });

  it('does not describe screens in terms of the storage model', () => {
    // "Workspace scoped, versioned, gated and auditable" was on fifty cards. It is true, and it is
    // a statement about the database rather than about anything the reader can do.
    const offenders = pages.filter((page) => /workspace scoped/i.test(page.source));
    expect(offenders.map((page) => page.file)).toEqual([]);
  });
});

describe('the interface shows no figure it did not read', () => {
  it('renders no hard-coded percentage', () => {
    const offenders = pages.filter((page) => /['"`]\s*\d{1,3}%/.test(page.source));
    expect(
      offenders.map((page) => page.file),
      'a percentage in page source cannot have come from the customer’s data',
    ).toEqual([]);
  });

  it('renders no hard-coded risk or readiness score', () => {
    const offenders = pages.filter((page) =>
      /(risk|readiness|adherence|health)\s*[:=]\s*['"`]?\s*\d/i.test(page.source),
    );
    expect(offenders.map((page) => page.file)).toEqual([]);
  });
});
