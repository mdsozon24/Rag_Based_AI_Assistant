/**
 * API configuration from environment variables (documented in .env.example), validated at start-up.
 */
import { isIP } from 'node:net';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** A proxy address for TRUST_PROXY: an IP, an IP/prefix (CIDR), or a proxy-addr keyword. */
function isProxyAddress(value: string): boolean {
  if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return true;
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  const bits = isIP(address) === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= bits;
}

/**
 * Which proxies may set X-Forwarded-For: false (none: the socket address is the client), true (any
 * hop; only safe when every request comes through an ingress that overwrites the header), or the
 * proxies' own addresses, comma-separated (the client is the last address that is not one of them).
 */
const trustProxy = z
  .string()
  .optional()
  .transform((v, ctx): boolean | string[] => {
    const value = v?.trim() ?? '';
    if (value === '' || value === 'false' || value === '0') return false;
    if (value === 'true' || value === '1') return true;
    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    const bad = entries.filter((entry) => !isProxyAddress(entry));
    if (bad.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `TRUST_PROXY must be true, false, or proxy IPs/CIDRs separated by commas (not ${bad.join(', ')})` });
    return entries;
  });
const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().default('pglite://./.data/api-db'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: int(3300),
  /** Public base URL of this API (https://api.example.com); call WebSocket URLs are built from it. */
  API_PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(z.string().url().optional()),
  /** Dashboard base URL, used in email links. */
  DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
  /** Origins allowed to make cookie-authenticated state-changing requests (CSRF), comma-separated. */
  DASHBOARD_ORIGINS: z.string().optional(),
  SESSION_TTL_DAYS: int(30),
  SESSION_IDLE_DAYS: int(7),
  COOKIE_SECURE: z.string().optional(),
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_KEY_PER_MINUTE: int(600),
  RATE_LIMIT_ORG_PER_MINUTE: int(1200),
  /** Sign-in, sign-up and password-reset attempts per IP (and per email for sign-in) per 15 minutes. */
  AUTH_RATE_LIMIT_PER_15_MIN: int(10),
  MAX_CONCURRENT_CALLS_PER_ORG: int(10),
  /** Live browser calls this process accepts at once; further connects are refused (4503). */
  VOICE_MAX_SESSIONS: int(50),
  /** How long a dropped browser call may take to reconnect before it ends (ms; 0 = end at once). */
  VOICE_RESUME_GRACE_MS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 15_000 : Number(v)))
    .pipe(z.number().int().min(0).max(120_000)),
  TWILIO_WEBHOOK_SECRET: z.string().optional(),
  /** Twilio account for sending SMS replies (Programmable Messaging). */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_URL: z.string().url().optional(),
  /** A chat session with no message for this long expires (minutes). */
  CHAT_SESSION_IDLE_MINUTES: int(1440),
  /** Newest messages sent to the model each turn; older ones stay stored but are not sent. */
  CHAT_MAX_HISTORY_MESSAGES: int(40),
  /** A session ends ("max-messages") after this many stored messages. */
  CHAT_MAX_MESSAGES_PER_SESSION: int(400),
  /** SMS replies: segments one message may use, and messages per reply (the rest is cut with "…"). */
  SMS_MAX_SEGMENTS_PER_MESSAGE: int(3),
  SMS_MAX_MESSAGES_PER_REPLY: int(5),
  /** Campaign dialer: runs inside the API process when true (server.ts); tests drive ticks directly. */
  CAMPAIGN_DIALER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v.trim() === '' || v === 'true' || v === '1'),
  CAMPAIGN_TICK_SECONDS: int(5),
  /** Platform calling hours in the CONTACT's local time; no campaign can dial outside them (HH:MM). */
  CAMPAIGN_HARD_CAP_START: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM').default('08:00'),
  CAMPAIGN_HARD_CAP_END: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM').default('21:00'),
  /** A provider dial request that takes longer than this counts as unconfirmed (not retried). */
  CAMPAIGN_DIAL_TIMEOUT_SECONDS: int(25),
  /** A dial that never reports back within this long is closed as unconfirmed (seconds). */
  CAMPAIGN_DIAL_CONFIRM_SECONDS: int(120),
  /** A ringing or connected call with no final provider event after this long is closed as lost (minutes). */
  CAMPAIGN_CALL_TIMEOUT_MINUTES: int(120),
  CAMPAIGN_MAX_CONTACTS: int(50_000),
  CAMPAIGN_MAX_UPLOAD_ROWS: int(10_000),
  /** Post-call analysis (summary, success evaluation, structured outputs): runs inside the API process when true. */
  ANALYSIS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v.trim() === '' || v === 'true' || v === '1'),
  ANALYSIS_TICK_SECONDS: int(5),
  /** Analysis jobs run at once per org per tick. */
  ANALYSIS_CONCURRENCY: int(3),
  /** Attempts per job (provider failures are retried with backoff) before it is marked failed. */
  ANALYSIS_MAX_ATTEMPTS: int(4),
  ANALYSIS_RETRY_BASE_SECONDS: int(30),
  /** A job whose worker disappears is taken over after this long (seconds). */
  ANALYSIS_LEASE_SECONDS: int(300),
  /** Longest transcript sent to the model; a longer call keeps its start and end. */
  ANALYSIS_MAX_TRANSCRIPT_CHARS: int(60_000),
  /** Sends queued call webhooks (end-of-call-report) automatically. Chat events stay on manual redelivery. */
  WEBHOOK_DELIVERY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v.trim() === '' || v === 'true' || v === '1'),
  WEBHOOK_DELIVERY_TICK_SECONDS: int(5),
  /** Operators (platform staff): signed-in users with a verified email in this comma-separated list may use /admin and /v1/admin/*. */
  OPERATOR_EMAILS: z.string().optional(),
  /** Bearer token Prometheus presents to GET /metrics. Unset: /metrics answers 404. At least 24 characters. */
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .refine((v) => v === undefined || v.length >= 24, 'METRICS_TOKEN must be at least 24 characters'),
  /** Error tracking: errors are sent to Sentry only when a DSN is set. */
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(z.string().url().optional()),
  SENTRY_ENVIRONMENT: z.string().optional(),
  /** Shown in logs, /ready, metrics and Sentry. */
  APP_VERSION: z.string().optional(),
  /** Days the full LLM prompts and replies of calls with debug.captureLlm are kept. */
  DEBUG_RETENTION_DAYS: int(14),
  /** Log lines and partial transcripts kept per call in the debug timeline (the rest is counted, not stored). */
  DEBUG_LOG_LINES_PER_CALL: int(500),
  DEBUG_PARTIALS_PER_CALL: int(300),
  /** Evaluates monitoring policies, sends alert notifications, and prunes expired debug data. */
  MONITORING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v.trim() === '' || v === 'true' || v === '1'),
  MONITORING_TICK_SECONDS: int(60),
  /** Longest date range a board or scorecard query may cover. */
  BOARD_MAX_RANGE_DAYS: int(92),
  GOOGLE_OAUTH_ENABLED: bool,
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

export type RawApiEnv = z.infer<typeof schema>;

export interface ApiConfig {
  env: string;
  databaseUrl: string;
  host: string;
  port: number;
  /** Public base URL, no trailing slash. */
  publicUrl: string;
  dashboardUrl: string;
  dashboardOrigins: string[];
  sessionTtlMs: number;
  sessionIdleMs: number;
  cookieSecure: boolean;
  /** false, true (any hop), or the addresses of trusted proxies. */
  trustProxy: boolean | string[];
  rateLimit: { keyPerMinute: number; orgPerMinute: number; authPer15Min: number };
  maxConcurrentCallsPerOrg: number;
  voice: { maxSessions: number; resumeGraceMs: number };
  twilioWebhookSecret?: string;
  twilio: { accountSid?: string; authToken?: string; apiUrl?: string };
  chat: { sessionIdleMs: number; maxHistoryMessages: number; maxMessagesPerSession: number };
  sms: { maxSegmentsPerMessage: number; maxMessagesPerReply: number };
  campaigns: {
    dialerEnabled: boolean;
    tickMs: number;
    hardCap: { start: string; end: string };
    dialTimeoutMs: number;
    dialConfirmMs: number;
    callTimeoutMs: number;
    maxContacts: number;
    maxUploadRows: number;
  };
  operatorEmails: string[];
  metricsToken?: string;
  sentry: { dsn?: string; environment: string };
  appVersion: string;
  debug: { retentionDays: number; logLinesPerCall: number; partialsPerCall: number };
  monitoring: { enabled: boolean; tickMs: number; boardMaxRangeDays: number };
  analysis: { enabled: boolean; tickMs: number; concurrency: number; maxAttempts: number; retryBaseMs: number; leaseMs: number; maxTranscriptChars: number };
  webhookDelivery: { enabled: boolean; tickMs: number };
  google: { enabled: boolean; clientId?: string; clientSecret?: string; redirectUri?: string };
  smtp: { host?: string; port: number; user?: string; pass?: string; from?: string };
}

const DAY = 24 * 60 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid API configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const google = { enabled: e.GOOGLE_OAUTH_ENABLED, clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri: e.GOOGLE_REDIRECT_URI };
  if (e.CAMPAIGN_HARD_CAP_START >= e.CAMPAIGN_HARD_CAP_END) {
    throw new Error('CAMPAIGN_HARD_CAP_START must be before CAMPAIGN_HARD_CAP_END (calling hours cannot cross midnight)');
  }
  if (google.enabled && (!google.clientId || !google.clientSecret || !google.redirectUri)) {
    throw new Error('GOOGLE_OAUTH_ENABLED=true needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI');
  }
  if (production && !e.SMTP_HOST) {
    // Without SMTP the dev outbox would write verification and reset links to the logs
    throw new Error('SMTP_HOST is required in production (emails carry sign-in links)');
  }
  if (production && !e.API_PUBLIC_URL) {
    throw new Error('API_PUBLIC_URL is required in production (clients connect calls to it)');
  }
  if (production && new URL(e.API_PUBLIC_URL as string).protocol !== 'https:') {
    throw new Error('API_PUBLIC_URL must use HTTPS in production');
  }
  if (production && new URL(e.DASHBOARD_URL).protocol !== 'https:') {
    throw new Error('DASHBOARD_URL must use HTTPS in production');
  }
  if (production && e.GOOGLE_OAUTH_ENABLED && new URL(e.GOOGLE_REDIRECT_URI as string).protocol !== 'https:') {
    throw new Error('GOOGLE_REDIRECT_URI must use HTTPS in production');
  }
  if (production && e.DATABASE_URL.startsWith('pglite://')) {
    throw new Error('DATABASE_URL must point to a real Postgres (postgres://...) in production');
  }
  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    host: e.API_HOST,
    port: e.API_PORT,
    publicUrl: (e.API_PUBLIC_URL ?? `http://${e.API_HOST}:${e.API_PORT}`).replace(/\/$/, ''),
    dashboardUrl: e.DASHBOARD_URL.replace(/\/$/, ''),
    dashboardOrigins: (e.DASHBOARD_ORIGINS ?? new URL(e.DASHBOARD_URL).origin)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    sessionTtlMs: e.SESSION_TTL_DAYS * DAY,
    sessionIdleMs: e.SESSION_IDLE_DAYS * DAY,
    cookieSecure: e.COOKIE_SECURE !== undefined ? e.COOKIE_SECURE === 'true' : production,
    trustProxy: e.TRUST_PROXY,
    rateLimit: { keyPerMinute: e.RATE_LIMIT_KEY_PER_MINUTE, orgPerMinute: e.RATE_LIMIT_ORG_PER_MINUTE, authPer15Min: e.AUTH_RATE_LIMIT_PER_15_MIN },
    maxConcurrentCallsPerOrg: e.MAX_CONCURRENT_CALLS_PER_ORG,
    voice: { maxSessions: e.VOICE_MAX_SESSIONS, resumeGraceMs: e.VOICE_RESUME_GRACE_MS },
    twilioWebhookSecret: e.TWILIO_WEBHOOK_SECRET?.trim() || undefined,
    twilio: { accountSid: e.TWILIO_ACCOUNT_SID?.trim() || undefined, authToken: e.TWILIO_AUTH_TOKEN?.trim() || undefined, apiUrl: e.TWILIO_API_URL },
    chat: { sessionIdleMs: e.CHAT_SESSION_IDLE_MINUTES * 60_000, maxHistoryMessages: e.CHAT_MAX_HISTORY_MESSAGES, maxMessagesPerSession: e.CHAT_MAX_MESSAGES_PER_SESSION },
    sms: { maxSegmentsPerMessage: e.SMS_MAX_SEGMENTS_PER_MESSAGE, maxMessagesPerReply: e.SMS_MAX_MESSAGES_PER_REPLY },
    campaigns: {
      dialerEnabled: e.CAMPAIGN_DIALER_ENABLED,
      tickMs: e.CAMPAIGN_TICK_SECONDS * 1000,
      hardCap: { start: e.CAMPAIGN_HARD_CAP_START, end: e.CAMPAIGN_HARD_CAP_END },
      dialTimeoutMs: e.CAMPAIGN_DIAL_TIMEOUT_SECONDS * 1000,
      dialConfirmMs: e.CAMPAIGN_DIAL_CONFIRM_SECONDS * 1000,
      callTimeoutMs: e.CAMPAIGN_CALL_TIMEOUT_MINUTES * 60_000,
      maxContacts: e.CAMPAIGN_MAX_CONTACTS,
      maxUploadRows: e.CAMPAIGN_MAX_UPLOAD_ROWS,
    },
    operatorEmails: (e.OPERATOR_EMAILS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
    metricsToken: e.METRICS_TOKEN,
    sentry: { dsn: e.SENTRY_DSN, environment: e.SENTRY_ENVIRONMENT?.trim() || e.NODE_ENV },
    appVersion: e.APP_VERSION?.trim() || process.env.npm_package_version || 'dev',
    debug: { retentionDays: e.DEBUG_RETENTION_DAYS, logLinesPerCall: e.DEBUG_LOG_LINES_PER_CALL, partialsPerCall: e.DEBUG_PARTIALS_PER_CALL },
    monitoring: { enabled: e.MONITORING_ENABLED, tickMs: e.MONITORING_TICK_SECONDS * 1000, boardMaxRangeDays: e.BOARD_MAX_RANGE_DAYS },
    analysis: {
      enabled: e.ANALYSIS_ENABLED,
      tickMs: e.ANALYSIS_TICK_SECONDS * 1000,
      concurrency: e.ANALYSIS_CONCURRENCY,
      maxAttempts: e.ANALYSIS_MAX_ATTEMPTS,
      retryBaseMs: e.ANALYSIS_RETRY_BASE_SECONDS * 1000,
      leaseMs: e.ANALYSIS_LEASE_SECONDS * 1000,
      maxTranscriptChars: e.ANALYSIS_MAX_TRANSCRIPT_CHARS,
    },
    webhookDelivery: { enabled: e.WEBHOOK_DELIVERY_ENABLED, tickMs: e.WEBHOOK_DELIVERY_TICK_SECONDS * 1000 },
    google,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.SMTP_FROM },
  };
}
