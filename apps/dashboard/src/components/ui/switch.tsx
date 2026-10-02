'use client';

import { Switch as RadixSwitch } from 'radix-ui';
import { cn } from '@/lib/cn';

/** An on/off switch (role="switch", announces its state). Label it with InlineField or aria-label. */
export function Switch({ checked, onCheckedChange, disabled, id, className, ...aria }: { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; id?: string; className?: string; 'aria-label'?: string; 'aria-describedby'?: string }) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-control bg-surface-2 transition-colors disabled:cursor-not-allowed disabled:opacity-55 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className
      )}
      {...aria}
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-1 rounded-full bg-control shadow transition-transform data-[state=checked]:translate-x-6 data-[state=checked]:bg-accent-fg" />
    </RadixSwitch.Root>
  );
}
