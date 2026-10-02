/**
 * API errors. Every error response has the same JSON shape:
 *   { "code": "not_found", "message": "Human readable text", "details": { ... } }
 * plus the X-Request-Id header for support.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'invalid_api_key'
  | 'session_expired'
  | 'email_not_verified'
  | 'forbidden'
  | 'forbidden_key_type'
  | 'origin_not_allowed'
  | 'csrf_origin_mismatch'
  | 'org_suspended'
  | 'no_active_org'
  | 'not_found'
  | 'conflict'
  | 'idempotency_in_progress'
  | 'idempotency_key_reused'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'not_configured'
  | 'upstream_unavailable'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 400,
  unauthorized: 401,
  invalid_api_key: 401,
  session_expired: 401,
  email_not_verified: 403,
  forbidden: 403,
  forbidden_key_type: 403,
  origin_not_allowed: 403,
  csrf_origin_mismatch: 403,
  org_suspended: 403,
  no_active_org: 409,
  not_found: 404,
  conflict: 409,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
  provider_unavailable: 422,
  rate_limited: 429,
  not_configured: 503,
  // The AI provider failed after retries and fallbacks; safe to retry
  upstream_unavailable: 503,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Extra response headers, e.g. Retry-After. */
    readonly headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details ?? {} };
  }
}

export const notFound = (what: string) => new ApiError('not_found', `${what} not found`);
