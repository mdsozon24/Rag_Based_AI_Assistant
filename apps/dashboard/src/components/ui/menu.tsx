'use client';

import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Menu({ trigger, children, align = 'end', label }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; label?: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={6} aria-label={label} className="z-50 min-w-48 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ children, onSelect, tone, disabled }: { children: ReactNode; onSelect?: (event: Event) => void; tone?: 'danger'; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4',
        tone === 'danger' ? 'text-danger' : 'text-text'
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-semibold text-muted">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}

export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem value={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-text outline-none select-none data-[highlighted]:bg-surface-2 data-[state=checked]:font-semibold">
      <span className="flex size-4 items-center justify-center" aria-hidden="true">
        <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.RadioItem>
  );
}
