import {
  Briefcase,
  HardHat,
  Code2,
  Globe2,
  type LucideIcon,
} from 'lucide-react';

export type MilestoneStatus = 'completed' | 'in_progress' | 'pending';
export interface Template {
  id: string;
  title: string;
  badge: string;
  icon: LucideIcon;
  description: string;
  payoutTrigger: string;
  escrowHolds: string;
  complianceLevel: string;
  sampleMilestones: Array<{
    title: string;
    amount: string;
    status: MilestoneStatus;
  }>;
  gradient: string;
  accentColor: string;
}

export const templates: Template[] = [
  {
    id: 'sow',
    title: 'Professional Services SOW',
    badge: 'Deliverable payouts',
    icon: Briefcase,
    description:
      'Give consulting engagements and agency projects a clear scope, shared milestones, and an agreed definition of done.',
    payoutTrigger: 'Client acceptance and verified deliverables',
    escrowHolds: 'Milestone funding with a licensed provider, where available',
    complianceLevel: 'Evidence-backed acceptance',
    sampleMilestones: [
      {
        title: 'Discovery & architecture brief',
        amount: '$4,500',
        status: 'completed',
      },
      {
        title: 'Frontend & API integration',
        amount: '$8,000',
        status: 'in_progress',
      },
      {
        title: 'Handover & acceptance sign-off',
        amount: '$5,000',
        status: 'pending',
      },
    ],
    gradient: 'from-blue-600/10 via-indigo-600/5 to-transparent',
    accentColor:
      'text-blue-600 border-blue-500/30 bg-blue-50/50 dark:text-blue-400 dark:bg-blue-950/30',
  },
  {
    id: 'construction',
    title: 'Construction & Renovations',
    badge: 'Staged inspections',
    icon: HardHat,
    description:
      'Connect progress claims to site evidence, inspection records, and the people authorized to accept each stage.',
    payoutTrigger: 'Inspector certification and authorized acceptance',
    escrowHolds: 'Agreed retainage and provider-held staged funding',
    complianceLevel: 'Inspection checkpoints',
    sampleMilestones: [
      {
        title: 'Foundation & structural framing',
        amount: '$18,500',
        status: 'completed',
      },
      {
        title: 'Electrical & MEP inspection',
        amount: '$12,000',
        status: 'completed',
      },
      {
        title: 'Final walkthrough & sign-off',
        amount: '$15,000',
        status: 'in_progress',
      },
    ],
    gradient: 'from-amber-600/10 via-orange-600/5 to-transparent',
    accentColor:
      'text-amber-700 border-amber-500/30 bg-amber-50/50 dark:text-amber-400 dark:bg-amber-950/30',
  },
  {
    id: 'dev',
    title: 'Digital Deliverables & Software',
    badge: 'PR merges & QA',
    icon: Code2,
    description:
      'Define acceptance around code reviews, passing checks, and deployment evidence. A merged PR supplies evidence; an authorized person approves release.',
    payoutTrigger: 'PR evidence, QA acceptance, and release authorization',
    escrowHolds: 'An agreed QA holdback before provider execution',
    complianceLevel: 'Human-authorized release',
    sampleMilestones: [
      {
        title: 'Database schema & authentication',
        amount: '$3,200',
        status: 'completed',
      },
      {
        title: 'Application deployed to staging',
        amount: '$6,500',
        status: 'completed',
      },
      {
        title: 'Security review & code handover',
        amount: '$4,800',
        status: 'in_progress',
      },
    ],
    gradient: 'from-emerald-600/10 via-teal-600/5 to-transparent',
    accentColor:
      'text-emerald-700 border-emerald-500/30 bg-emerald-50/50 dark:text-emerald-400 dark:bg-emerald-950/30',
  },
  {
    id: 'crossborder',
    title: 'Cross-Border Procurement',
    badge: 'Delivery checkpoints',
    icon: Globe2,
    description:
      'Put purchase terms, shipping documents, and delivery acceptance in one shared record before a payment instruction is approved.',
    payoutTrigger: 'Shipping documents and verified delivery acceptance',
    escrowHolds: 'Currency and settlement terms agreed with your provider',
    complianceLevel: 'Provider compliance checks required',
    sampleMilestones: [
      {
        title: 'Production order & deposit checkpoint',
        amount: '$25,000',
        status: 'completed',
      },
      {
        title: 'Freight & customs documentation',
        amount: '$15,000',
        status: 'in_progress',
      },
      {
        title: 'Warehouse delivery & acceptance',
        amount: '$10,000',
        status: 'pending',
      },
    ],
    gradient: 'from-violet-600/10 via-purple-600/5 to-transparent',
    accentColor:
      'text-violet-700 border-violet-500/30 bg-violet-50/50 dark:text-violet-400 dark:bg-violet-950/30',
  },
];

export function templateText(template: Template) {
  return `${template.title}\nBuyer: Northstar Studio\nSeller: Meridian Partners\n${template.sampleMilestones.map((m, i) => `Milestone ${i + 1}: ${m.title} | ${m.amount}`).join('\n')}`;
}

export interface AgreementDraft {
  title: string;
  buyer: string;
  seller: string;
  total: string;
  milestones: Array<{ title: string; amount: string }>;
}

/** Deliberately local and deterministic: this preview makes no AI or server request. */
export function parseAgreementText(text: string): AgreementDraft {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const party = (name: string) =>
    lines
      .find((line) => new RegExp(`^${name}\\s*:`, 'i').test(line))
      ?.replace(/^[^:]+:\s*/, '')
      .slice(0, 70) || 'Needs review';
  const amountPattern = /(?:USD\s*|\$)\s*([\d,]+(?:\.\d{1,2})?)/i;
  const money = (amount: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  const milestones = lines
    .filter((line) => /^(?:milestone|phase|stage)\s*\d*\s*[:.\-]/i.test(line))
    .slice(0, 6)
    .map((line) => {
      const match = line.match(amountPattern);
      return {
        title:
          line
            .replace(/^(?:milestone|phase|stage)\s*\d*\s*[:.\-]\s*/i, '')
            .replace(amountPattern, '')
            .replace(/[|—–\-\s]+$/, '')
            .slice(0, 90) || 'Untitled milestone',
        amount: match
          ? money(Number(match[1].replace(/,/g, '')))
          : 'Needs review',
      };
    });
  const statedTotal = lines
    .find((line) => /^(?:total|agreement value|amount due)\s*:/i.test(line))
    ?.match(amountPattern);
  const sum = milestones.reduce(
    (value, m) => value + (Number(m.amount.replace(/[^\d.]/g, '')) || 0),
    0,
  );
  return {
    title: (
      lines.find(
        (line) =>
          !/^(buyer|seller|total|milestone|phase|stage)\s*\d*\s*:/i.test(line),
      ) || 'Untitled agreement'
    )
      .replace(/^title:\s*/i, '')
      .slice(0, 85),
    buyer: party('buyer'),
    seller: party('seller'),
    total: statedTotal
      ? money(Number(statedTotal[1].replace(/,/g, '')))
      : sum
        ? money(sum)
        : 'Needs review',
    milestones,
  };
}
