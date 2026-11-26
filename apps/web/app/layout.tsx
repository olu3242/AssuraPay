import type { Metadata } from 'next';
import './globals.css';
import { AppNavigation } from './components/app-navigation';
import { THEME_BOOTSTRAP } from './components/theme-contract';

export const metadata: Metadata = {
  title: 'AssuraPay',
  description: 'Execution assurance and conditional payment platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` on `<html>` alone, and only for the attribute below. The bootstrap
    // script sets `data-theme` before React hydrates, so the client's `<html>` legitimately differs
    // from the server's markup — which is the point of running it early. Scoped to this one element
    // so a genuine mismatch anywhere inside still reports.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before the first paint, so a reader who chose dark never sees a white flash. See
            `theme-contract.ts` for why this is a script rather than React state. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body><AppNavigation />{children}</body>
    </html>
  );
}
