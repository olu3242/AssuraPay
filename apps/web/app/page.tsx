import type { Metadata } from 'next';
import AssuraPayLanding from '../src/components/assurapay/AssuraPayLanding';
import '../src/components/assurapay/landing.css';

export const metadata: Metadata = {
  title: 'AssuraPay | Clear Agreements. Confident Payments.',
  description:
    'Turn invoices, proposals and contracts into structured agreements with milestones, evidence-backed completion, authorized approvals and controlled payment workflows.',
};

export default function Home() {
  return <AssuraPayLanding />;
}
