import { CircleAlert, Inbox, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/api/client';
import { cn } from '@/lib/cn';
import { Button } from './button';

/** Loading placeholder: announced once ("Loading…"), shapes hidden from screen readers. */
export function LoadingState({ label = 'Loading…', rows = 3, className }: { label?: string; rows?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-col gap-3', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-12 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center', className)}>
      <div className="mb-3 rounded-full bg-surface-2 p-3 text-muted [&_svg]:size-6" aria-hidden="true">
        {icon ?? <Inbox />}
      </div>
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A failed load: what went wrong, the request id to quote to support, and a retry. */
export function ErrorState({ error, onRetry, title = 'Could not load this', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const requestId = error instanceof ApiError ? error.requestId : null;
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-4 py-4', className)}>
      <div className="flex items-center gap-2 text-danger">
        <CircleAlert aria-hidden="true" className="size-5" />
        <h2 className="text-sm font-semibold">{forbidden ? 'You do not have access to this' : title}</h2>
      </div>
      <p className="text-sm text-text">{forbidden ? 'Ask an admin of this organization for the role you need.' : errorMessage(error)}</p>
      {requestId ? <p className="text-xs text-muted">Reference: <code className="font-mono">{requestId}</code></p> : null}
      {onRetry && !forbidden ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Renders the right state for a query: loading, error (with retry), empty, or the data. */
export function QueryState<T>({
  query,
  loading,
  empty,
  isEmpty,
  children,
  errorTitle,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  loading?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  errorTitle?: string;
}) {
  if (query.isPending) return <>{loading ?? <LoadingState />}</>;
  if (query.isError || query.data === undefined) return <ErrorState error={query.error} title={errorTitle} onRetry={() => void query.refetch()} />;
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
