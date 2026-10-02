/**
 * Error tracking. Unexpected errors (a 500, a crashed worker, an unhandled rejection) are:
 *  - logged with their ids by the caller,
 *  - counted (octo_errors_total{source}),
 *  - kept in a small in-memory list for the operator's admin page, and
 *  - sent to Sentry, but only when SENTRY_DSN is set. Without a DSN nothing leaves the platform.
 *
 * What Sentry receives is deliberately thin: the error type and a scrubbed message, the stack, and
 * tags with ids (org_id, call_id, request_id, source). Never request bodies, headers, cookies, query
 * strings, user data, transcripts, or breadcrumbs. Secrets and email addresses that end up inside an
 * error message are masked first.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from './metrics.ts';

export interface ErrorContext {
  /** Where it came from: http, analysis, dialer, webhook-delivery, monitoring, process... */
  source: string;
  orgId?: string;
  callId?: string;
  requestId?: string;
}

export interface RecentError {
  at: string;
  source: string;
  type: string;
  message: string;
  orgId?: string;
  callId?: string;
  requestId?: string;
}

const MAX_RECENT = 50;
const MAX_MESSAGE = 500;

const MASKS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [secret]'],
  [/\b(?:sk|pk|rk)_[A-Za-z0-9_-]{8,}/g, '[api-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[api-key]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(password|secret|token|authorization|cookie|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[secret]'],
  [/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgres://[redacted]'],
];

/** Mask secrets and email addresses, and cap the length. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/** The slice of Sentry the tracker uses (the real module satisfies it; tests pass a stand-in). */
export interface SentryLike {
  init(options: Record<string, unknown>): unknown;
  withScope(callback: (scope: { setTags(tags: Record<string, string>): void }) => void): void;
  captureException(error: unknown): string;
  flush(timeoutMs?: number): Promise<boolean>;
  close(timeoutMs?: number): Promise<boolean>;
}

export interface SentryEventLike {
  request?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  contexts?: Record<string, unknown>;
  server_name?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  message?: string;
}

/** What Sentry may see of an event: type, scrubbed message, stack and tags. Exported for tests. */
export function scrubEvent<T extends SentryEventLike>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.server_name;
  if (event.contexts) event.contexts = Object.fromEntries(Object.entries(event.contexts).filter(([key]) => key === 'runtime' || key === 'os'));
  if (event.message) event.message = scrubText(event.message);
  for (const value of event.exception?.values ?? []) if (value.value) value.value = scrubText(value.value);
  return event;
}

export class ErrorTracker {
  private readonly recent: RecentError[] = [];
  private sentry: SentryLike | null = null;
  private count = 0;

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly metrics?: Metrics
  ) {}

  /** Start sending to Sentry. `transport` lets tests capture what would be sent. */
  async enableSentry(options: { dsn: string; environment: string; release: string; transport?: unknown; sentry?: SentryLike }): Promise<void> {
    const sentry = options.sentry ?? ((await import('@sentry/node')) as unknown as SentryLike);
    sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      release: options.release,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      // Only what we capture on purpose: no automatic instrumentation of http, pg or console
      defaultIntegrations: false,
      integrations: [],
      skipOpenTelemetrySetup: true,
      beforeSend: (event: SentryEventLike) => scrubEvent(event),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    this.sentry = sentry;
  }

  get sentryEnabled(): boolean {
    return this.sentry !== null;
  }

  /** Total errors captured since start. */
  get total(): number {
    return this.count;
  }

  /** Record an unexpected error. Never throws. */
  capture(error: unknown, context: ErrorContext): void {
    try {
      this.count++;
      this.metrics?.errors.inc({ source: context.source });
      const err = error instanceof Error ? error : new Error(String(error));
      this.recent.unshift({
        at: new Date().toISOString(),
        source: context.source,
        type: err.name,
        message: scrubText(err.message),
        ...(context.orgId ? { orgId: context.orgId } : {}),
        ...(context.callId ? { callId: context.callId } : {}),
        ...(context.requestId ? { requestId: context.requestId } : {}),
      });
      if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
      const sentry = this.sentry;
      if (sentry) {
        const tags: Record<string, string> = { source: context.source };
        if (context.orgId) tags.org_id = context.orgId;
        if (context.callId) tags.call_id = context.callId;
        if (context.requestId) tags.request_id = context.requestId;
        sentry.withScope((scope) => {
          scope.setTags(tags);
          sentry.captureException(err);
        });
      }
    } catch (failure) {
      // Error tracking must never become the error
      this.log.warn({ err: failure }, 'could not record an error');
    }
  }

  recentErrors(): RecentError[] {
    return [...this.recent];
  }

  async flush(timeoutMs = 2000): Promise<void> {
    await this.sentry?.flush(timeoutMs).catch(() => undefined);
  }
}
