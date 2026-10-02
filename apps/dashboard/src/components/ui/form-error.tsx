import { CircleAlert } from 'lucide-react';
import type { FieldErrors } from '@/lib/forms';

/**
 * Errors that belong to no visible field (the API's form-level message, or issues on fields this
 * form does not show). Focusable, so focusFirstError can move to it.
 */
export function FormError({ errors, shown = [] }: { errors: FieldErrors; shown?: string[] }) {
  const rest = Object.entries(errors).filter(([path]) => !shown.includes(path));
  if (!rest.length) return null;
  return (
    <div role="alert" tabIndex={-1} data-form-error className="flex gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2.5 text-sm text-text">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <ul className="flex flex-col gap-0.5">
        {rest.map(([path, message]) => (
          <li key={path}>{path === '_form' ? message : `${path}: ${message}`}</li>
        ))}
      </ul>
    </div>
  );
}
