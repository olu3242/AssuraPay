import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AssuraPay',
  description: 'Execution assurance and conditional payment platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
