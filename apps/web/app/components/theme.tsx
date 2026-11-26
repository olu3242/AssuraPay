'use client';
import { useCallback, useEffect, useState } from 'react';
import { THEME_STORAGE_KEY, type Theme } from './theme-contract';

/**
 * Light and dark, for the whole document.
 *
 * ## Why this moved out of the landing page
 *
 * The theme used to be React state inside `AssuraPayLanding`, written onto that component's own
 * `<div>`. It worked, and it was the only part of the design system the rest of the application could
 * not have: a reader could choose dark on the landing page, follow a link to `/settlements`, and be
 * handed a white screen. Applying the landing's design globally means applying its theme, so the
 * state belongs to the document.
 *
 * `data-theme` is written on `<html>`, which is what `:root[data-theme='dark']` in `globals.css`
 * reads. It is also **mirrored onto `#assurapay-landing`**, for two reasons that are both about not
 * rewriting working code: that stylesheet's remaining dark rules are written as
 * `#assurapay-landing[data-theme='dark']` for the few gradients and accent colours that are not
 * expressible as tokens, and `browser-landing-interactions.spec.ts` asserts the attribute is there.
 *
 * The storage key, the two values and the pre-paint bootstrap script live in `theme-contract.ts`,
 * which carries no React and no client boundary, so `layout.tsx` can read the script without becoming
 * a client component.
 */

function read(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    // Storage can be unavailable in private browsing. Light is the readable default.
    return 'light';
  }
}

/** Written to the document, so a component that cares about the theme reads one place. */
function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('assurapay-landing')?.setAttribute('data-theme', theme);
}

/**
 * The document's theme, and the one way to change it.
 *
 * Starts at `'light'` rather than at the stored value because the server renders this component too
 * and `localStorage` does not exist there: reading it during render would hydrate against markup the
 * server could not have produced. The effect corrects it on mount, which is invisible because
 * `THEME_BOOTSTRAP` has already set the attribute the stylesheet reads — the state catches up with
 * the document rather than the document waiting for the state.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const current = read();
    setTheme(current);
    apply(current);

    // A second tab, or the landing page's own toggle in a previous session. `storage` fires only in
    // other documents, which is exactly the case React state cannot see.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = event.newValue === 'dark' ? 'dark' : 'light';
      setTheme(next);
      apply(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === 'light' ? 'dark' : 'light';
      apply(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // The theme still works for this page load without persistence.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}

/**
 * The control, in the application header.
 *
 * The same affordance the landing page has carried since it was redesigned, with the same labels, so
 * the two headers are one header in two places rather than two controls that drift.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="app-theme-toggle"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      data-testid="theme-toggle"
    >
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}
