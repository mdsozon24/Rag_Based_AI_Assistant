/**
 * Dependencies shared by every route, and the per-request auth types.
 */
import type { CredentialService } from '../../../packages/engine/src/credentials/service.ts';
import type { ApiConfig } from './config.ts';
import type { Database, Queryable } from './db/database.ts';
import type { TenantDb } from './db/tenant.ts';
import type { RateLimiter } from './http/rateLimit.ts';
import type { Permission, Role } from './auth/permissions.ts';
import type { Mailer } from './services/mailer.ts';
import type { Actor } from './services/audit.ts';
import type { VoiceRuntime } from './voice/runtime.ts';
import type { WebCallService } from './voice/webCalls.ts';
import type { ChatService } from './services/chat.ts';
import type { SmsService } from './services/sms.ts';
import type { MessagingAdapter, MessagingProvider } from '../../../packages/engine/src/messaging/types.ts';
import type { CredentialCipher } from '../../../packages/engine/src/credentials/cipher.ts';
import type { TelephonyAdapter, TelephonyProvider } from '../../../packages/engine/src/telephony/types.ts';
import type { LiveCallRegistry } from './services/liveCalls.ts';
import type { WebhookEventType } from './services/webhooks.ts';
import type { CampaignDialer } from './services/campaigns/dialer.ts';
import type { AnalysisWorker } from './services/analysis/worker.ts';
import type { WebhookDeliveryWorker } from './services/webhookDelivery.ts';
import type { MonitoringWorker } from './services/monitoringWorker.ts';
import type { Metrics } from './observability/metrics.ts';
import type { ErrorTracker } from './observability/errors.ts';

/** Minimal fetch used for Google OAuth (injectable for tests). */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface AppContext {
  config: ApiConfig;
  db: Database;
  tenants: TenantDb;
  mailer: Mailer;
  rateLimiter: RateLimiter;
  credentials: CredentialService;
  fetch: FetchLike;
  voice: VoiceRuntime;
  /** Live browser calls owned by this process (the /v1/calls/:id/connect socket). */
  webCalls: WebCallService;
  /** SMS (and later WhatsApp) providers by name, for /v1/messaging/:provider/webhook. */
  messaging: Record<MessagingProvider, MessagingAdapter>;
  /** Text conversations (chat API, OpenAI-compatible API, SMS). */
  chat: ChatService;
  sms: SmsService;
  toolCipher: CredentialCipher | null;
  telephony: { adapters: Record<TelephonyProvider, TelephonyAdapter>; maxConcurrentCalls: number };
  liveCalls: LiveCallRegistry;
  webhookEvents: readonly WebhookEventType[];
  /** Outbound campaign dialer; started by server.ts, driven tick by tick in tests. */
  campaigns: CampaignDialer;
  /** Post-call analysis queue; started by server.ts, driven tick by tick in tests. */
  analysis: AnalysisWorker;
  /** Sends queued call webhooks (end-of-call-report). */
  webhookDelivery: WebhookDeliveryWorker;
  /** Evaluates monitoring policies, sends alert notifications, prunes expired debug data. */
  monitoring: MonitoringWorker;
  /** Prometheus metrics (GET /metrics). */
  metrics: Metrics;
  /** Unexpected errors: counted, kept for the admin page, and sent to Sentry when a DSN is set. */
  errors: ErrorTracker;
  /** When this process started (uptime on /ready and the admin page). */
  startedAt: Date;
}

export type Principal =
  | { kind: 'session'; userId: string; sessionId: string; activeOrgId: string | null }
  | {
      kind: 'api_key';
      keyId: string;
      keyType: 'private' | 'public';
      orgId: string;
      allowedOrigins: string[];
      allowedAssistantIds: string[];
    };

/** The org a request is scoped to, and the only database access org routes get. */
export interface OrgScope {
  id: string;
  /** The member's role; null when the caller is an API key. */
  role: Role | null;
  permissions: ReadonlySet<Permission>;
  actor: Actor;
  /** Run fn in a transaction scoped to this org (role octo_app + row-level security). */
  run<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  can(permission: Permission): boolean;
  /** Public keys: throws unless the key may be used for this assistant. */
  assertAssistantAllowed(assistantId: string): void;
}

/** Per-route options, set with `config: { ... }` on the route. */
export interface RouteAuthConfig {
  /** none: public; user: dashboard session; org: session or API key, resolved to one org (default). */
  auth?: 'none' | 'user' | 'org';
  permission?: Permission;
  /** Public (browser) keys are refused unless the route opts in. */
  allowPublicKey?: boolean;
  /** Honour the Idempotency-Key header. */
  idempotent?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig extends RouteAuthConfig {}
  interface FastifyRequest {
    principal: Principal | null;
    org: OrgScope | null;
  }
}
