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
  it('confines Tailwind to the landing components, so a utility in the app shell would not exist', () => {
    // Rewritten, because the original claim became false while still passing.
    //
    // It asserted "no Tailwind is configured" and looked in the repository root. Tailwind arrived in
    // `apps/web/tailwind.config.js` — a different directory — so the assertion stayed green and
    // stopped being true, which is the exact failure mode this suite exists to prevent elsewhere.
    //
    // The conclusion survives on better evidence. The config is deliberately scoped: `content`
    // covers only `src/components/assurapay`, `important` is the landing's own id, and preflight is
    // off. So a utility class written under `app/` is not merely discouraged — Tailwind never
    // generates it, and the class does nothing. That is what the next assertion enforces.
    const config = readFileSync(path.join(__dirname, '..', 'tailwind.config.js'), 'utf8');
    expect(config).toContain('src/components/assurapay');
    expect(config).toContain("important: '#assurapay-landing'");
    expect(config).toContain('preflight: false');
    // The app shell is outside `content`. If it is ever added, this fails and the assertion below
    // has to be reconsidered deliberately rather than quietly becoming wrong again.
    expect(config).not.toMatch(/content:[^\]]*\bapp\b/);
  });

  it('writes no Tailwind utility class in the app shell, where none would be generated', () => {
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
    // The surface follows the token rather than a literal, so the palette stays one source. Two
    // declarations: the opaque fallback first, then the translucent one, so an engine without
    // `backdrop-filter` gets a readable header rather than a transparent one.
    expect(header).toContain('background: var(--ap-surface)');
    expect(header).toContain('background: var(--ap-header)');
    // The current section is marked with the workspace's own accent, not a second highlight colour.
    expect(globals!.source).toContain("nav a[aria-current='page']");
  });
});

describe('the stylesheet styles things that render', () => {
  const globals = () => files.find((entry) => entry.file === 'globals.css')!.source;

  /** Every class token written in a `className` under `app/`. */
  function classesUsed(): Set<string> {
    const used = new Set<string>();
    for (const entry of files) {
      if (!entry.file.endsWith('.tsx')) continue;
      for (const match of entry.source.matchAll(/className="([^"{]+)"/g)) {
        for (const token of match[1].split(/\s+/)) if (token) used.add(token);
      }
    }
    return used;
  }

  /**
   * Every class token the stylesheet defines a rule for.
   *
   * Whole tokens, not substrings. The first version of the assertion below asked
   * `css.includes('.' + name)`, which is satisfied by any longer name that starts the same way:
   * renaming `.page-shell` to `.page-shell-renamed` left the guard green while the class the
   * application writes went undefined. `.card` would have been "defined" by `.cardboard`.
   *
   * Comments are already stripped by `sources()`, so a prefix named in prose does not count as a
   * rule — which matters here, because the comments in `globals.css` discuss the class names this
   * change deleted.
   */
  function classesDefined(css: string): Set<string> {
    return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]));
  }

  it('defines every class the application actually writes', () => {
    // `.page-shell` was the one that prompted this. `trust-console.tsx` has rendered
    // `<main className="page-shell">` on every trust-foundation route since it was written, and the
    // class was defined nowhere — so those routes silently fell back to the bare `main` rule and were
    // visibly narrower than the rest of the application. A class used and not defined is the same
    // defect as a class defined and not used, seen from the other side.
    const defined = classesDefined(globals());
    const missing = [...classesUsed()].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('styles no class name the application no longer writes', () => {
    // `globals.css` was 2,944 lines, of which roughly 2,200 styled `.console-*`, `.landing-*` and
    // `.hero*` — a trust-console mockup, a marketing page and a carousel, all three replaced by
    // `AssuraPayLanding` and none of them rendered by any component.
    //
    // That was not merely dead weight. Those rules had been flattened onto one tint for every
    // background, border and fill, so the stylesheet read as a unified palette while the product
    // showed two. Deleting them is what made the live surface small enough to see, and this guard is
    // what stops the next replaced surface from leaving its stylesheet behind.
    const used = classesUsed();
    // Composed rather than written as a literal, so the `className="…"` scan cannot see them:
    // `record-view.tsx` builds the tab's class from its selected state.
    const COMPOSED = new Set(['tab', 'tab--current']);
    const orphans = [...classesDefined(globals())].filter(
      (name) => !used.has(name) && !COMPOSED.has(name),
    );
    expect(orphans).toEqual([]);
  });
});

describe('the landing page and the application share one palette', () => {
  /** The one live landing stylesheet. The orphaned `preferred-landing` set was deleted with this change. */
  const LANDING = path.join(__dirname, '..', 'src', 'components', 'assurapay', 'landing.css');

  it('declares the palette once, at the root, and lets the landing inherit it', () => {
    // This is the assertion the previous version of this test said it was standing in for.
    //
    // It used to *record a gap*: the shell declared `--ap-blue: #005ee9` and the live landing
    // declared `--ap-primary: #2563eb`, two independent palettes, and the note said that whoever
    // unified them should replace the record with the derivation. That happened, and the direction
    // matters — the landing page is the design, so its tokens were promoted to `:root` in
    // `globals.css` rather than converted to the shell's.
    //
    // So the test is now: the landing stylesheet declares no colour of its own, and every token it
    // reads is defined globally. That is a stronger claim than "they happen to match", because it
    // cannot drift.
    const landing = readFileSync(LANDING, 'utf8');
    const globals = files.find((entry) => entry.file === 'globals.css')!.source;

    const SCALE = [
      '--ap-bg',
      '--ap-surface',
      '--ap-soft',
      '--ap-text',
      '--ap-muted',
      '--ap-line',
      '--ap-primary',
      '--ap-light-blue',
      '--ap-header',
    ];
    for (const token of SCALE) {
      expect(globals, `${token} is not declared globally`).toMatch(
        new RegExp(`^\\s*${token}:`, 'm'),
      );
      // Declared in the dark block too, or the theme would only half apply.
      const dark = globals.match(/:root\[data-theme='dark'\] \{[\s\S]*?\n\}/g) ?? [];
      expect(dark.some((block) => block.includes(`${token}:`)), `${token} has no dark value`).toBe(true);
      // And *not* re-declared on the landing's own id, which is what made two palettes possible.
      expect(landing, `${token} is still declared on #assurapay-landing`).not.toMatch(
        new RegExp(`#assurapay-landing[^{]*\\{[^}]*${token}:`),
      );
    }
  });

  it('keeps the landing stylesheet scoped so it cannot restyle the application', () => {
    // A plain CSS import is global in Next. Every selector in `landing.css` is prefixed with
    // `#assurapay-landing`, which is the only reason importing it from `app/page.tsx` does not reach
    // every other page. Asserted because one unscoped rule would be invisible until it was not.
    //
    // That matters more now, not less. The tokens are global and the landing inherits them, so an
    // unscoped rule here would restyle the whole application from a file named after one page.
    const landing = readFileSync(LANDING, 'utf8');
    const unscoped = landing
      .split('\n')
      .filter((line) => /^[.#a-zA-Z*\[]/.test(line) && line.includes('{'))
      .filter((line) => !line.startsWith('#assurapay-landing'));
    expect(unscoped, 'landing.css must be scoped under #assurapay-landing').toEqual([]);
  });

  it('applies the theme to the document rather than to one page', () => {
    // The landing page owned light/dark as React state on its own `<div>`, which is why a reader
    // could choose dark there and be handed a white screen on `/settlements`. Applying the design
    // globally means applying the theme, so `data-theme` is written on `<html>` — where
    // `:root[data-theme='dark']` reads it — and mirrored onto the landing's id for the handful of
    // its rules that are gradients rather than tokens.
    const theme = files.find((entry) => entry.file === path.join('components', 'theme.tsx'));
    expect(theme, 'there is no theme controller').toBeDefined();
    expect(theme!.source).toContain('document.documentElement.setAttribute');
    expect(theme!.source).toContain("getElementById('assurapay-landing')");

    // Set before the first paint. React cannot, so a dark reader would see a white flash on every
    // navigation; the bootstrap script in `<head>` is what prevents it.
    const layout = files.find((entry) => entry.file === 'layout.tsx')!.source;
    expect(layout).toContain('THEME_BOOTSTRAP');

    // One storage key, so the choice survives the move between the two surfaces. Read directly:
    // `sources()` walks `.tsx` and `.css`, and the contract is a plain `.ts` module precisely so a
    // server component can read the bootstrap script without crossing the client boundary.
    const contract = readFileSync(
      path.join(__dirname, '..', 'app', 'components', 'theme-contract.ts'),
      'utf8',
    );
    expect(contract).toContain("'assurapay-landing-theme'");
    const landing = readFileSync(LANDING, 'utf8');
    expect(landing, 'the landing still carries its own dark rules').toContain(
      "#assurapay-landing[data-theme='dark']",
    );
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
