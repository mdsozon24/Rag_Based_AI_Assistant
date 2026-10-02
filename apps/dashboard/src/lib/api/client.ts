/**
 * The dashboard's only way to the platform: the public /v1 API, on this origin (next.config.ts
 * forwards /v1/* to the API). The session cookie is HttpOnly and travels by itself; the browser's
 * Origin header satisfies the API's CSRF check. Errors keep the API's {code, message, details} and
 * the X-Request-Id to quote to support.
 */

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level problems of a validation_error (empty otherwise). */
  get issues(): ApiIssue[] {
    const issues = this.details.issues;
    return Array.isArray(issues) ? (issues as ApiIssue[]).filter((i) => typeof i?.path === 'string' && typeof i?.message === 'string') : [];
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Requests time out rather than hang the UI; the API's own long operations stay well below this. */
const TIMEOUT_MS = 30_000;

export async function api<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(withQuery(path, options.query), {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const timedOut = timeout.aborted;
    throw new ApiError(0, timedOut ? 'timeout' : 'network', timedOut ? 'The server took too long to answer. Try again.' : 'Could not reach the server. Check your connection and try again.');
  }
  const requestId = response.headers.get('x-request-id');
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = (body ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, error.code ?? 'internal_error', error.message ?? `Request failed (${response.status})`, error.details ?? {}, requestId);
  }
  return body as T;
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>('GET', path, { query, signal });
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, { body: body ?? {}, headers });
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, { body });
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, { body });
export const del = <T = void>(path: string, body?: unknown) => api<T>('DELETE', path, { body });

/** A short, human message for any error (used by error states and toasts). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
