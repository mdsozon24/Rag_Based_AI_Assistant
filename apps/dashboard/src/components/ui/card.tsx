import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface shadow-card', className)} {...props} />;
}

export function CardHeader({ title, description, actions, className, as: Heading = 'h2' }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; as?: 'h2' | 'h3' }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5', className)}>
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-text">{title}</Heading>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 sm:px-5', className)} {...props} />;
}

/** A small labelled number (stats rows). */
export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-card">
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-text tabular-nums">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}
