/**
 * Form errors: one map from a field path ("config.firstMessage", "schedule.windowStart") to a
 * message, filled by client-side validation (zod schemas that mirror the API's) and by the API's
 * own validation_error issues, so a rule the client missed still lands on the right field.
 */
import type { ZodError, ZodTypeAny, z } from 'zod';
import { ApiError, type ApiIssue } from '@/lib/api/client';

export type FieldErrors = Record<string, string>;

/** Issues → errors, keeping the first message per path. `strip` removes a prefix ("config."). */
export function issuesToErrors(issues: ApiIssue[], strip = ''): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    let path = issue.path;
    if (strip && path.startsWith(strip)) path = path.slice(strip.length);
    else if (strip && path === strip.replace(/\.$/, '')) path = '';
    errors[path || '_form'] ??= issue.message;
  }
  return errors;
}

export function zodToErrors(error: ZodError): FieldErrors {
  return issuesToErrors(error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

/** Validate with a schema: the parsed value, or the errors. */
export function validate<S extends ZodTypeAny>(schema: S, value: unknown): { ok: true; value: z.infer<S> } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: zodToErrors(result.error) };
}

/**
 * The errors to show for a failed request: field issues of a validation error, otherwise one
 * form-level message.
 */
export function apiErrorsFor(error: unknown, strip = ''): FieldErrors {
  if (error instanceof ApiError && error.issues.length) return issuesToErrors(error.issues, strip);
  if (error instanceof ApiError) return { _form: error.requestId && error.status >= 500 ? `${error.message} (reference ${error.requestId})` : error.message };
  return { _form: error instanceof Error ? error.message : 'Something went wrong.' };
}

/** Errors for paths under `prefix`, with the prefix removed (for nested editors). */
export function errorsUnder(errors: FieldErrors, prefix: string): FieldErrors {
  const out: FieldErrors = {};
  for (const [path, message] of Object.entries(errors)) if (path.startsWith(`${prefix}.`)) out[path.slice(prefix.length + 1)] = message;
  return out;
}

/** Move focus to the first invalid control so keyboard and screen-reader users land on the problem. */
export function focusFirstError(root: HTMLElement | null): void {
  if (!root) return;
  requestAnimationFrame(() => {
    const target = root.querySelector<HTMLElement>('[aria-invalid="true"], [data-form-error]');
    target?.focus();
  });
}
