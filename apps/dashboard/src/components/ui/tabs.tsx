'use client';

import { Tabs as RadixTabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  /** Shown next to the label, e.g. a count or an error marker. */
  badge?: ReactNode;
}

/** Keyboard: arrow keys move between tabs (Radix); the list scrolls sideways on phones. */
export function Tabs({ items, value, onValueChange, label, className }: { items: TabItem[]; value: string; onValueChange: (value: string) => void; label: string; className?: string }) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} className={className}>
      <RadixTabs.List aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              '-mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium text-muted hover:text-text',
              'data-[state=active]:border-accent data-[state=active]:text-text'
            )}
          >
            {item.label}
            {item.badge}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-5 outline-none">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
