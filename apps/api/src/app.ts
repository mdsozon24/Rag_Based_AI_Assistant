/**
 * Builds the API server (Fastify). Tests call buildApp with an in-memory database; server.ts calls
 * it with the configured one.
 */
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { CredentialCipher } from '../../../packages/engine/src/credentials/cipher.ts';
import { CredentialService, platformKeysFromEnv } from '../../../packages/engine/src/credentials/service.ts';
import { createDefaultRegistry } from '../../../packages/engine/src/providers/catalog.ts';
import { platformDefaults } from '../../../packages/engine/src/platform.ts';
import { resolveCallProviders, resolveModelChain } from '../../../packages/engine/src/providers/resolve.ts';
import { TwilioMessagingAdapter } from '../../../packages/engine/src/messaging/twilio.ts';
import { FakeMessagingAdapter } from '../../../packages/engine/src/messaging/fake.ts';
import type { MessagingAdapter, MessagingProvider } from '../../../packages/engine/src/messaging/types.ts';
import { TwilioAdapter } from '../../../packages/engine/src/telephony/twilio.ts';
import { FakeTelephonyAdapter } from '../../../packages/engine/src/telephony/fake.ts';
import type { ApiConfig } from './config.ts';
import type { AppContext, FetchLike } from './context.ts';
import type { Database } from './db/database.ts';
import { TenantDb } from './db/tenant.ts';
import { registerAuthentication } from './auth/authenticate.ts';
import { ApiError } from './http/errors.ts';
import { registerIdempotency } from './http/idempotency.ts';
import { MemoryRateLimiter, type RateLimiter } from './http/rateLimit.ts';
import { registerApiKeyRoutes } from './routes/apiKeys.ts';
import { registerAuditRoutes } from './routes/auditLogs.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCredentialRoutes } from './routes/credentials.ts';
import { registerAssistantRoutes } from './routes/assistants.ts';
import { registerCallRoutes } from './routes/calls.ts';
import { registerToolRoutes } from './routes/tools.ts';
import { registerPhoneNumberRoutes, registerTelephonyRoutes } from './routes/telephony.ts';
import { registerCallControlRoutes } from './routes/callControl.ts';
import { registerBrowserCallRoutes } from './routes/browserCalls.ts';
import { registerCors } from './http/cors.ts';
import type { VoiceRuntime } from './voice/runtime.ts';
import { WebCallService } from './voice/webCalls.ts';
import { ChatService } from './services/chat.ts';
import { SmsService } from './services/sms.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerOpenAiRoutes } from './routes/openai.ts';
import { registerMessagingRoutes } from './routes/messaging.ts';
import { registerSquadRoutes } from './routes/squads.ts';
import { LiveCallRegistry } from './services/liveCalls.ts';
import { WEBHOOK_EVENTS } from './services/webhooks.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';
import { registerCampaignRoutes } from './routes/campaigns.ts';
import { CampaignDialer } from './services/campaigns/dialer.ts';
import { AnalysisWorker } from './services/analysis/worker.ts';
import { WebhookDeliveryWorker } from './services/webhookDelivery.ts';
import type { HttpClient } from '../../../packages/engine/src/providers/net.ts';
import { registerStructuredOutputRoutes } from './routes/structuredOutputs.ts';
import { Metrics } from './observability/metrics.ts';
import { ErrorTracker, type SentryLike } from './observability/errors.ts';
import { MonitoringWorker } from './services/monitoringWorker.ts';
import { registerDebugRoutes } from './routes/callDebug.ts';
import { registerBoardRoutes } from './routes/boards.ts';
import { registerMonitoringRoutes } from './routes/monitoring.ts';
import { registerOpsRoutes } from './routes/ops.ts';
import { registerProviderRoutes } from './routes/providers.ts';
import { registerCallAnalysisRoutes } from './routes/callAnalysis.ts';
import { registerMeRoutes } from './routes/me.ts';
import { registerOrgRoutes } from './routes/org.ts';
import { createMailer, type Mailer } from './services/mailer.ts';
import { PostgresCredentialStore } from './services/credentialStore.ts';
import { guardedFetch } from '../../../packages/engine/src/providers/net.ts';

export interface BuildOptions {
  config: ApiConfig;
  db: Database;
  mailer?: Mailer;
  rateLimiter?: RateLimiter;
  fetch?: FetchLike;
  /** Env for platform provider keys and the credential encryption key. */
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  /** Extra routes registered after the built-in ones (tests). */
  extraRoutes?: (app: FastifyInstance, ctx: AppContext) => void;
  /** Provider chains for a call; default: the registry with org keys, else platform keys. Tests pass fakes. */
  providersForCall?: VoiceRuntime['providersForCall'];
  /** Model chain for text conversations; default: the registry (org key, else platform key). Tests pass fakes. */
  modelForCall?: VoiceRuntime['modelForCall'];
  /** Messaging adapters (tests pass a fake for "fake"). */
  messaging?: Partial<Record<MessagingProvider, MessagingAdapter>>;
  /** Where GET /sdk/:file reads the built SDK bundles (default packages/sdk/dist). */
  sdkDir?: string;
  /** The campaign dialer's clock (tests move it to cross calling windows); default: real time. */
  dialerClock?: () => Date;
  /** The analysis worker's clock (leases and backoff); default: real time. */
  analysisClock?: () => Date;
  /** The webhook delivery worker's clock and HTTP client (tests pass a fake; default: the SSRF-guarded client). */
  webhookClock?: () => Date;
  webhookHttp?: HttpClient;
  /** The monitoring worker's clock and HTTP client for alert webhooks (tests pass fakes). */
  monitoringClock?: () => Date;
  monitoringHttp?: HttpClient;
  /** Error tracking: a stand-in for Sentry and its transport (tests); used only when SENTRY_DSN is set. */
  sentry?: { sentry?: SentryLike; transport?: unknown };
}

export interface RouteInfo {
  method: string;
  url: string;
  auth: 'none' | 'user' | 'org';
  permission?: string;
}

export async function buildApp(options: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext; routes: RouteInfo[] }> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'octo-api', env: options.config.env, version: options.config.appVersion }, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(given) ? given : randomUUID();
    },
    trustProxy: options.config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  const tenants = new TenantDb(options.db);
  const env = options.env ?? process.env;
  const toolCipher = CredentialCipher.fromEnv(env);
  const credentials = new CredentialService(new PostgresCredentialStore(tenants), toolCipher, platformKeysFromEnv(env));
  const registry = createDefaultRegistry();
  const endpointPolicy = { allowPrivateNetwork: env.CUSTOM_ENDPOINTS_ALLOW_PRIVATE === 'true' && env.NODE_ENV !== 'production' };
  const defaults = platformDefaults(env);
  const metrics = new Metrics(options.config.appVersion);
  const errors = new ErrorTracker(app.log, metrics);
  if (options.config.sentry.dsn) {
    await errors.enableSentry({ dsn: options.config.sentry.dsn, environment: options.config.sentry.environment, release: options.config.appVersion, ...options.sentry });
  }
  const ctx: AppContext = {
    metrics,
    errors,
    startedAt: new Date(),
    monitoring: null as unknown as MonitoringWorker,
    config: options.config,
    db: options.db,
    tenants,
    mailer: options.mailer ?? createMailer(options.config, app.log),
    rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(),
    credentials,
    fetch: options.fetch ?? guardedFetch(endpointPolicy),
    voice: {
      registry,
      endpointPolicy,
      providersForCall: options.providersForCall ?? ((config, orgId, logger) => resolveCallProviders(config, registry, { orgId, credentials, endpointPolicy, defaults }, logger)),
      modelForCall: options.modelForCall ?? ((config, orgId, logger) => resolveModelChain(config, registry, { orgId, credentials, endpointPolicy, defaults }, logger)),
    },
    messaging: { twilio: new TwilioMessagingAdapter(), fake: new FakeMessagingAdapter(), ...options.messaging },
    webCalls: null as unknown as WebCallService,
    chat: null as unknown as ChatService,
    sms: null as unknown as SmsService,
    toolCipher,
    telephony: {
      adapters: { twilio: new TwilioAdapter(), telnyx: new FakeTelephonyAdapter() as never, vonage: new FakeTelephonyAdapter() as never, sip: new FakeTelephonyAdapter() },
      maxConcurrentCalls: options.config.maxConcurrentCallsPerOrg,
    },
    liveCalls: new LiveCallRegistry(),
    webhookEvents: WEBHOOK_EVENTS,
    campaigns: null as unknown as CampaignDialer,
    analysis: null as unknown as AnalysisWorker,
    webhookDelivery: null as unknown as WebhookDeliveryWorker,
  };
  ctx.webCalls = new WebCallService(ctx);
  ctx.chat = new ChatService(ctx);
  ctx.sms = new SmsService(ctx);
  ctx.campaigns = new CampaignDialer(ctx, app.log, options.dialerClock);
  ctx.analysis = new AnalysisWorker(ctx, app.log, options.analysisClock);
  ctx.monitoring = new MonitoringWorker(ctx, app.log, options.monitoringClock, options.monitoringHttp);
  metrics.sources = { db: options.db, liveSessions: () => ctx.webCalls.activeCount };
  ctx.webhookDelivery = new WebhookDeliveryWorker(ctx, app.log, options.webhookClock, options.webhookHttp);
  // Live calls end (and their rows are written) before the database closes
  app.addHook('onClose', async () => {
    // Dials already sent are recorded before the database closes
    await ctx.campaigns.stop();
    await ctx.analysis.stop();
    await ctx.webhookDelivery.stop();
    await ctx.monitoring.stop();
    await ctx.webCalls.shutdown();
    // SMS replies in progress finish before the database closes
    await ctx.sms.idle();
  });

  // Every registered route with its auth mode (tests prove isolation coverage from this list)
  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const config = (route.config ?? {}) as { auth?: RouteInfo['auth']; permission?: string };
    for (const method of methods) if (method !== 'HEAD') routes.push({ method, url: route.url, auth: config.auth ?? 'org', permission: config.permission });
  });

  await app.register(cookie);
  // Browser audio frames are 20-100 ms of PCM (a few KB); nothing legitimate is near 1 MB
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.headers) for (const [k, v] of Object.entries(error.headers)) reply.header(k, v);
      return reply.code(error.status).send(error.toJSON());
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Malformed JSON, wrong content type, body too large...
      return reply.code(status).send({ code: 'bad_request', message: (error as Error).message, details: {} });
    }
    request.log.error({ err: error }, 'unhandled error');
    ctx.errors.capture(error, { source: 'http', requestId: request.id, orgId: request.org?.id });
    return reply.code(500).send({ code: 'internal_error', message: 'Something went wrong; quote the request id when contacting support', details: { requestId: request.id } });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'not_found', message: 'Route not found', details: {} }));

  registerAuthentication(app, ctx);
  // Every log line of a request carries the org once it is known, next to the request id
  app.addHook('preHandler', async (request) => {
    if (request.org) request.log = request.log.child({ org_id: request.org.id });
  });
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration.observe({ method: request.method, route: request.routeOptions?.url ?? 'unmatched', status_class: `${Math.floor(reply.statusCode / 100)}xx` }, reply.elapsedTime / 1000);
  });
  registerIdempotency(app);
  registerCors(app, ['/v1/calls', '/v1/chat']);
  // Provider webhooks (Twilio) post form-encoded bodies
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/health', { config: { auth: 'none' } }, async () => {
    await options.db.query('SELECT 1');
    return { ok: true };
  });

  registerAuthRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerApiKeyRoutes(app, ctx);
  registerCredentialRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerAssistantRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerCallRoutes(app, ctx);
  registerToolRoutes(app, ctx);
  registerPhoneNumberRoutes(app, ctx);
  registerTelephonyRoutes(app, ctx);
  registerCallControlRoutes(app, ctx);
  registerBrowserCallRoutes(app, ctx, { sdkDir: options.sdkDir });
  registerChatRoutes(app, ctx);
  registerOpenAiRoutes(app, ctx);
  registerMessagingRoutes(app, ctx);
  registerSquadRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerCampaignRoutes(app, ctx);
  registerStructuredOutputRoutes(app, ctx);
  registerCallAnalysisRoutes(app, ctx);
  registerDebugRoutes(app, ctx);
  registerBoardRoutes(app, ctx);
  registerMonitoringRoutes(app, ctx);
  registerOpsRoutes(app, ctx);
  options.extraRoutes?.(app, ctx);

  await app.ready();
  return { app, ctx, routes };
}
