import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * A data table that scrolls sideways on narrow screens. The scroll region is focusable and named,
 * so keyboard users can scroll it too.
 */
export function Table({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1)
    <div role="region" aria-label={label} tabIndex={0} className={cn('overflow-x-auto rounded-lg border border-border bg-surface shadow-card', className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border bg-surface-2/60 text-xs font-semibold tracking-wide text-muted uppercase">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('align-top', className)} {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('px-4 py-2.5 font-semibold whitespace-nowrap', className)} {...props} />;
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 text-text', className)} {...props} />;
}
