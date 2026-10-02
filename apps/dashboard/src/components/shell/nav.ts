import {
  AudioLines,
  BellRing,
  BookOpen,
  Bot,
  Braces,
  Building2,
  CreditCard,
  Drama,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  Phone,
  PhoneOff,
  ScrollText,
  ShieldCheck,
  Users,
  Webhook,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Hidden for members without it (the API would refuse anyway). */
  permission?: Permission;
  /** Not available yet: the API behind it does not exist. */
  soon?: boolean;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: 'Build',
    items: [
      { href: '/assistants', label: 'Assistants', icon: Bot, permission: 'assistants:read' },
      { href: '/squads', label: 'Squads', icon: Workflow, permission: 'assistants:read' },
      { href: '/tools', label: 'Tools', icon: Wrench, permission: 'assistants:read' },
      { href: '/structured-outputs', label: 'Structured outputs', icon: Braces, permission: 'assistants:read' },
      { href: '/knowledge-base', label: 'Knowledge base', icon: BookOpen, soon: true },
    ],
  },
  {
    label: 'Deploy',
    items: [
      { href: '/phone-numbers', label: 'Phone numbers', icon: Phone, permission: 'assistants:read' },
      { href: '/campaigns', label: 'Campaigns', icon: Megaphone, permission: 'campaigns:read' },
      { href: '/do-not-call', label: 'Do-not-call list', icon: PhoneOff, permission: 'campaigns:read' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { href: '/calls', label: 'Calls', icon: AudioLines, permission: 'calls:read' },
      { href: '/monitoring', label: 'Boards', icon: LayoutDashboard, permission: 'calls:read' },
      { href: '/monitoring/scorecards', label: 'Scorecards', icon: Gauge, permission: 'monitoring:read' },
      { href: '/monitoring/policies', label: 'Monitoring', icon: BellRing, permission: 'monitoring:read' },
    ],
  },
  {
    label: 'Test',
    items: [
      { href: '/evals', label: 'Evals', icon: FlaskConical, soon: true },
      { href: '/simulations', label: 'Simulations', icon: Drama, soon: true },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings', label: 'Organization', icon: Building2, permission: 'org:read' },
      { href: '/settings/members', label: 'Members', icon: Users, permission: 'members:read' },
      { href: '/settings/api-keys', label: 'API keys', icon: KeyRound, permission: 'api_keys:read' },
      { href: '/settings/provider-keys', label: 'Provider keys', icon: KeyRound, permission: 'credentials:read' },
      { href: '/settings/webhooks', label: 'Webhooks', icon: Webhook, permission: 'org:read' },
      { href: '/settings/billing', label: 'Billing', icon: CreditCard, soon: true },
      { href: '/settings/compliance', label: 'Compliance', icon: ShieldCheck, soon: true },
      { href: '/settings/audit-log', label: 'Audit log', icon: ScrollText, permission: 'audit:read' },
    ],
  },
];

/** The nav entry a path belongs to: the longest matching href (so /monitoring/policies wins over /monitoring). */
export function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const section of NAV) {
    for (const item of section.items) {
      const match = pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.length)) best = item.href;
    }
  }
  return best;
}
