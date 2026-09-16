'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AppNavigation() {
  const pathname = usePathname();
  if (pathname === '/') return null;
  return (
    <header className="app-navigation">
      <Link href="/" className="app-brand" aria-label="AssuraPay home">
        <img src="/images/assurapay-symbol.png" width="40" height="55" alt="" />
        <strong>AssuraPay</strong>
      </Link>
      <nav aria-label="Application">
        <Link href="/start">Account & workspace</Link>
        <Link href="/contracts">Agreements</Link>
        <Link href="/performance">Performance</Link>
        <Link href="/execution">Execution</Link>
        <Link href="/settlements">Settlements</Link>
        <Link href="/workflow-intelligence">Workflow</Link>
      </nav>
    </header>
  );
}
