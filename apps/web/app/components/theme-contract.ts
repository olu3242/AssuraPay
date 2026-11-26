/**
 * The theme's contract: the storage key, the two values, and the script that applies one before the
 * first paint.
 *
 * Separate from `theme.tsx` because that file is `'use client'` and `layout.tsx` is a server
 * component. The bootstrap script is a string, not a component, and a server component should not
 * have to cross a client boundary to read a string.
 *
 * ## The storage key keeps its old name
 *
 * `assurapay-landing-theme` is no longer only the landing's — it is the document's. Renaming it would
 * read better and would silently discard the choice of every reader who already has one, which is a
 * worse trade than a key whose name is a little historical.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'assurapay-landing-theme';

/**
 * Runs in `<head>`, before the body renders.
 *
 * React cannot set `data-theme` before the first paint, so without this a reader who chose dark sees
 * a white flash on every navigation — on a slow connection, for long enough to read. Deliberately
 * tiny, dependency-free, and wrapped in `try`: `localStorage` throws in private browsing, and a
 * failed theme must leave the page light rather than blank.
 *
 * It sets `<html>` only. `#assurapay-landing` does not exist yet when this runs; the landing's own
 * effect mirrors the attribute onto it.
 */
export const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var d=s==='dark'||(!s&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;
