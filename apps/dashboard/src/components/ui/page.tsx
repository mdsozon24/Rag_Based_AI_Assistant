import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The page's single h1, its summary and its main actions. */
export function PageHeader({ title, description, actions, breadcrumb, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-6 flex flex-col gap-3', className)}>
      {breadcrumb ? <nav aria-label="Breadcrumb" className="text-sm text-muted">{breadcrumb}</nav> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words text-text">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Content width and padding for every page. */
export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-6 lg:px-8', wide ? 'max-w-7xl' : 'max-w-6xl', className)}>{children}</div>;
}
