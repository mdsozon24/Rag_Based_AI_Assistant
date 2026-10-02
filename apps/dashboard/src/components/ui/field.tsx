'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface ControlProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'aria-required'?: boolean;
}

/**
 * A labelled form field. The control is rendered by `children(props)` so it gets the id, the
 * invalid state and the description/error ids it must announce.
 */
export function Field({
  label,
  description,
  error,
  required,
  className,
  id: givenId,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  id?: string;
  children: (props: ControlProps) => ReactNode;
}) {
  const generated = useId();
  const id = givenId ?? `f${generated.replace(/:/g, '')}`;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, 'aria-required': required || undefined })}
      {description ? (
        <p id={descriptionId} className="text-xs text-muted">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A checkbox or switch with its label beside it. */
export function InlineField({ label, description, children, className }: { label: ReactNode; description?: ReactNode; children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode; className?: string }) {
  const generated = useId();
  const id = `f${generated.replace(/:/g, '')}`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <div className="pt-0.5">{children({ id, 'aria-describedby': descriptionId })}</div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-xs text-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Groups related fields under a legend (fieldset). */
export function FieldGroup({ legend, description, children, className }: { legend: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <fieldset className={cn('flex flex-col gap-4', className)}>
      <legend className="mb-1 text-base font-semibold text-text">{legend}</legend>
      {description ? <p className="-mt-3 text-sm text-muted">{description}</p> : null}
      {children}
    </fieldset>
  );
}
