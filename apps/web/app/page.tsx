import type { Metadata } from 'next';
import PreferredLanding from '../src/components/preferred-landing/PreferredLanding';
import '../src/components/preferred-landing/landing.css';

export const metadata: Metadata = {
  title: 'AssuraPay | Clear Agreements. Confident Payments.',
  description:
    'Turn invoices, proposals and contracts into structured agreements with milestones, evidence-backed completion, authorized approvals and controlled payment workflows.',
};

export default function Home() {
  return <PreferredLanding />;
}
