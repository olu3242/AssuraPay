import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The application chrome, as assertions.
 *
 * Written against an information-architecture audit which asked for app-wide alignment with the
 * landing page. Most of what it specified was already true or was not true of this codebase at all,
 * and the parts worth keeping are here as guards rather than as a document that goes stale.
 *
 * Three of these exist because the audit was *right* about a symptom and wrong about the cause:
 *
 * - **One header.** The audit asked for a new `components/layout/AppHeader.tsx`. One already renders
 *   on every route from `layout.tsx`, so a second would have been two headers in one application —
 *   and the one that lost would have been the one nobody updated.
 * - **No Tailwind.** It specified the header surface as `backdrop-blur-md bg-white/80
 *   dark:bg-slate-900/80`. This application has no Tailwind: no config, no dependency. Those class
 *   names would have been inert strings, which is worse than wrong because the diff looks finished.
 * - **One token source.** It specified Emerald `#10B981` and Blue `#0066FF` as global tokens. The
 *   brand tokens are `--ap-blue #005ee9` and `--ap-green #169c50`, and `landing.css` *derives* from
 *   them (`--blue: var(--ap-blue)`), so overwriting them would have restyled the landing page and
 *   caused the divergence the audit set out to fix.
 *
 * And one exists because the audit asked for something this product must not say. See the last block.
 */

const APP = path.join(__dirname, '..', 'app');

function sources(): Array<{ file: string; source: string }> {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : full.endsWith('.tsx') || full.endsWith('.css')
          ? [full]
          : [];
    });
  return walk(APP).map((file) => ({
    file: path.relative(APP, file),
    // Comments stripped, for the reason `ui-vocabulary.test.ts` gives: these files explain the
    // things they are not allowed to do, and a guard matching its own documentation would push
    // whoever hit it into deleting the explanation.
    source: readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'),
  }));
}

const files = sources();

/** Pages that are sign-in or sign-up flows, plus the landing page, which carry their own chrome. */
const EXEMPT_PAGES = new Set([
  'page.tsx',
  path.join('start', 'page.tsx'),
  path.join('auth', '[mode]', 'page.tsx'),
  path.join('onboarding', '[mode]', 'page.tsx'),
]);

describe('there is one header, and it is the one that renders', () => {
  it('reads the application at all, so nothing here passes vacuously', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((entry) => entry.file)).toContain(path.join('components', 'app-navigation.tsx'));
  });

  it('renders exactly one navigation header component', () => {
    // A second header is the duplicate-framework outcome the working agreement forbids. Counted by
    // the `<header>` element rather than by filename, so naming one `AppHeader` would not evade it.
    const headers = files.filter(
      (entry) => entry.file.endsWith('.tsx') && /<header[\s>]/.test(entry.source),
    );
    expect(headers.map((entry) => entry.file)).toEqual([
      path.join('components', 'app-navigation.tsx'),
    ]);
  });

  it('keeps page-level navigation out of pages the header already covers', () => {
    // `/execution` and `/settlements` each carried a `<nav>` listing three of the header's seven
    // destinations. Two navigations on one screen disagree the moment either changes.
    const offenders = files.filter(
      (entry) =>
        entry.file.endsWith('page.tsx') && !EXEMPT_PAGES.has(entry.file) && /<nav[\s>]/.test(entry.source),
    );
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });
});

describe('the chrome is styled in tokens, because there is no Tailwind', () => {
  it('has no Tailwind configured, which is why utility classes must not be written', () => {
    // Asserted rather than assumed: if Tailwind is ever adopted, this fails and the next assertion
    // can be reconsidered deliberately instead of silently becoming wrong.
    const root = path.join(__dirname, '..', '..', '..');
    const configured = readdirSync(root).some((entry) => entry.startsWith('tailwind.config'));
    expect(configured).toBe(false);
  });

  it('writes no Tailwind utility class in the application', () => {
    // The specific shapes the audit asked for, plus the families they belong to. A class that does
    // nothing is worse than a wrong one: the diff reads as finished and the browser disagrees.
    const utilities =
      /\b(?:backdrop-blur-(?:sm|md|lg|xl)|bg-white\/\d{1,3}|dark:bg-slate-\d{2,3}(?:\/\d{1,3})?|border-slate-\d{2,3}|text-slate-\d{2,3})\b/;
    const offenders = files.filter((entry) => utilities.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });

  it('gives the header a sticky, translucent surface built on the brand tokens', () => {
    const globals = files.find((entry) => entry.file === 'globals.css');
    expect(globals).toBeDefined();
    const header = globals!.source.slice(globals!.source.indexOf('.app-navigation {'));
    expect(header).toContain('position: sticky');
    expect(header).toContain('backdrop-filter');
    // The surface follows the token rather than a literal, so the palette stays one source.
    expect(header).toContain('var(--ap-white)');
    // The current section is marked with the workspace's own accent, not a second highlight colour.
    expect(globals!.source).toContain("nav a[aria-current='page']");
  });
});

describe('the landing page and the application share one palette', () => {
  it('derives the landing tokens from the brand tokens rather than restating them', () => {
    // The audit's premise was that the landing page and the subpages had diverged. They had not, at
    // the level that matters: `landing.css` is a semantic layer over `--ap-*`. This is the assertion
    // that keeps it that way — and that would have failed had the audit's hexes been applied.
    const landing = readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'preferred-landing', 'landing.css'),
      'utf8',
    );
    for (const derivation of [
      '--blue: var(--ap-blue)',
      '--navy: var(--ap-navy)',
      '--pale: var(--ap-pale)',
      '--success: var(--ap-green)',
    ]) {
      expect(landing, `landing.css must derive ${derivation}`).toContain(derivation);
    }
  });

  it('keeps the landing stylesheet scoped so it cannot restyle the application', () => {
    // A plain CSS import is global in Next. Every selector in `landing.css` is prefixed with
    // `#preferred-landing`, which is the only reason importing it from `app/page.tsx` does not
    // reach every other page. Asserted because one unscoped rule would be invisible until it was not.
    const landing = readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'preferred-landing', 'landing.css'),
      'utf8',
    );
    const unscoped = landing
      .split('\n')
      .filter((line) => /^[.#a-zA-Z*\[]/.test(line) && line.includes('{'))
      .filter((line) => !line.startsWith('#preferred-landing'));
    expect(unscoped).toEqual([]);
  });

  it('keeps the per-persona accents, which one flat palette would have erased', () => {
    const globals = files.find((entry) => entry.file === 'globals.css')!.source;
    const accents = [...globals.matchAll(/--ap-accent:\s*([^;]+);/g)].map((match) => match[1].trim());
    // One default plus the workspace accents that make the personas visually distinct.
    expect(new Set(accents).size).toBeGreaterThan(4);
  });
});

describe('the interface claims no certification and no custody', () => {
  it('names no compliance certification or payment rail the platform does not hold', () => {
    // The audit asked for "SOC2, ACH/Stripe Connect, and bank-grade encryption badges" on payout
    // confirmation modals. Declined, and guarded:
    //
    // A SOC 2 badge is a claim about an audit that has been performed. Rendering one the platform
    // has not passed is a fabricated certification, which is the same class of defect as the
    // invented settlement-readiness figure deleted from `/workflow-intelligence`.
    //
    // ACH and Stripe Connect are also the wrong rails to advertise: this platform is naira-first
    // and settles through a certified Nigerian Financial Provider's own APIs.
    const forbidden = /\b(?:SOC\s?2|SOC-2|ACH\b|Stripe Connect|PCI[- ]DSS|ISO\s?27001|bank-grade)\b/i;
    const offenders = files.filter((entry) => forbidden.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });

  it('describes no escrow the platform holds', () => {
    // The audit asked for an "escrow strip" and "escrow locks". CLAUDE.md's first hard constraint is
    // that no code path holds, pools or has signing authority over end-user funds — so the interface
    // must not tell a customer their money is in an AssuraPay escrow. A certified provider holds and
    // settles it; AssuraPay instructs.
    //
    // The word is allowed only where it names the provider's own facility, which is why the pattern
    // targets possession rather than the term itself.
    const possessive =
      /(?:our|assurapay(?:'s|’s)?|platform)\s+escrow|escrow\s+(?:balance|lock|locks|account\s+we)/i;
    const offenders = files.filter((entry) => possessive.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });
});

describe('every page opens with a category label', () => {
  it('gives each page an eyebrow pill rather than a bare heading', () => {
    // The audit's one unambiguously correct item. `/execution` and `/settlements` opened on a flat
    // `<h1>`; the rest already used the pill. Sign-in flows and the landing page are exempt by name
    // rather than by pattern, so adding a page cannot quietly join the exemption.
    const offenders = files.filter(
      (entry) =>
        entry.file.endsWith('page.tsx') &&
        !EXEMPT_PAGES.has(entry.file) &&
        !entry.source.includes('eyebrow') &&
        // A page that delegates its whole body to a component inherits that component's header.
        !/return\s*(?:\(\s*)?<[A-Z]/.test(entry.source),
    );
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });
});
