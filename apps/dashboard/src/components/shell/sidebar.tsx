'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import { activeHref, NAV } from './nav';

/** Primary navigation; the current page is marked with aria-current. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can } = useSession();
  const active = activeHref(pathname);
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {NAV.map((section) => {
        const items = section.items.filter((item) => !item.permission || can(item.permission));
        if (!items.length) return null;
        return (
          <div key={section.label}>
            <h2 className="px-2 pb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{section.label}</h2>
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => {
                const current = item.href === active;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      onClick={onNavigate}
                      className={cn(
                        'flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium',
                        current ? 'bg-accent-soft text-accent-text' : 'text-text hover:bg-surface-2'
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.soon ? <Badge>Soon</Badge> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
