/**
 * Test harness: a real Postgres (PGlite, in memory) with the real migrations, the real app, an
 * outbox mailer, and helpers to sign users up and call the API like a browser or a server would.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions, type RouteInfo } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { openDatabase, type Database } from '../src/db/database.ts';
import { migrate } from '../src/db/migrate.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import { OutboxMailer } from '../src/services/mailer.ts';

export const DASHBOARD = 'https://dash.octo.test';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Database;
  outbox: OutboxMailer;
  clock: { now: number };
  /** The campaign dialer's clock (separate from the rate limiter's, so tests can move it freely). */
  dialerClock: { now: number };
  /** The analysis worker's clock (leases and backoff). */
  analysisClock: { now: number };
  /** The webhook delivery worker's clock. */
  webhookClock: { now: number };
  /** The monitoring worker's clock (policy evaluation, notification retries, pruning). */
  monitoringClock: { now: number };
  routes: RouteInfo[];
  close(): Promise<void>;
}

export async function createTestApp(
  options: { env?: Record<string, string>; extraRoutes?: BuildOptions['extraRoutes']; fetch?: BuildOptions['fetch']; logger?: boolean; providersForCall?: BuildOptions['providersForCall']; modelForCall?: BuildOptions['modelForCall']; messaging?: BuildOptions['messaging']; sdkDir?: string; webhookHttp?: BuildOptions['webhookHttp']; monitoringHttp?: BuildOptions['monitoringHttp']; sentry?: BuildOptions['sentry'] } = {}
): Promise<TestApp> {
  const db = await openDatabase('pglite://memory');
  await migrate(db);
  const env = {
    NODE_ENV: 'test',
    DASHBOARD_URL: DASHBOARD,
    CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // High defaults so only the rate-limit tests hit limits
    RATE_LIMIT_KEY_PER_MINUTE: '10000',
    RATE_LIMIT_ORG_PER_MINUTE: '10000',
    AUTH_RATE_LIMIT_PER_15_MIN: '1000',
    ...options.env,
  };
  const config = loadConfig(env);
  const outbox = new OutboxMailer();
  const clock = { now: Date.now() };
  const dialerClock = { now: Date.now() };
  const analysisClock = { now: Date.now() };
  const webhookClock = { now: Date.now() };
  const monitoringClock = { now: Date.now() };
  const { app, ctx, routes } = await buildApp({
    config,
    db,
    mailer: outbox,
    rateLimiter: new MemoryRateLimiter(() => clock.now),
    env,
    logger: options.logger ?? false,
    fetch: options.fetch,
    extraRoutes: options.extraRoutes,
    providersForCall: options.providersForCall,
    modelForCall: options.modelForCall,
    messaging: options.messaging,
    sdkDir: options.sdkDir,
    dialerClock: () => new Date(dialerClock.now),
    analysisClock: () => new Date(analysisClock.now),
    webhookClock: () => new Date(webhookClock.now),
    webhookHttp: options.webhookHttp,
    monitoringClock: () => new Date(monitoringClock.now),
    monitoringHttp: options.monitoringHttp,
    sentry: options.sentry,
  });
  return { app, ctx, db, outbox, clock, dialerClock, analysisClock, webhookClock, monitoringClock, routes, close: async () => (await app.close(), await db.close()) };
}

export function json<T = any>(res: LightMyRequestResponse): T {
  return res.body ? JSON.parse(res.body) : (undefined as T);
}

/** Extract the token from the latest email to `to`. */
export function tokenFromEmail(outbox: OutboxMailer, to: string): string {
  const mail = outbox.last(to);
  const token = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error(`no token email for ${to}`);
  return token;
}

/** A caller: a browser session (cookie + dashboard Origin) or a server with an API key. */
export interface Caller {
  label: string;
  request(method: InjectOptions['method'], url: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

export function sessionCaller(t: TestApp, cookie: string, label = 'session'): Caller {
  return {
    label,
    request: (method, url, body, headers = {}) =>
      t.app.inject({ method, url, headers: { cookie, origin: DASHBOARD, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) }),
  };
}

export function keyCaller(t: TestApp, key: string, label = 'api key', origin?: string): Caller {
  return {
    label,
    request: (method, url, body, headers = {}) =>
      t.app.inject({ method, url, headers: { authorization: `Bearer ${key}`, ...(origin ? { origin } : {}), ...headers }, ...(body !== undefined ? { payload: body as object } : {}) }),
  };
}

export interface SignedUp {
  userId: string;
  orgId: string;
  email: string;
  cookie: string;
  caller: Caller;
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${Date.now().toString(36)}.${counter++}@example.com`;
}

export const PASSWORD = 'correct horse battery staple';

/** Sign up, verify the email and sign in. */
export async function signUp(t: TestApp, options: { email?: string; name?: string; orgName?: string } = {}): Promise<SignedUp> {
  const email = options.email ?? uniqueEmail();
  const signup = await t.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: PASSWORD, name: options.name ?? 'Test User', orgName: options.orgName } });
  if (signup.statusCode !== 202) throw new Error(`signup failed: ${signup.body}`);
  const verify = await t.app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: tokenFromEmail(t.outbox, email) } });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.body}`);
  return login(t, email);
}

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<SignedUp> {
  const res = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = sessionCookie(res);
  const body = json(res);
  return { userId: body.user.id, orgId: body.activeOrgId, email, cookie, caller: sessionCaller(t, cookie, email) };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const setCookie = res.headers['set-cookie'];
  const raw = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((c) => c?.startsWith('octo_session='));
  if (!raw) throw new Error('no session cookie');
  return raw.split(';')[0];
}

/** Invite `email` into `inviter`'s org with `role`, then sign them up/in and accept. */
export async function addMember(t: TestApp, inviter: SignedUp, role: 'admin' | 'member' | 'viewer', email = uniqueEmail(role)): Promise<SignedUp> {
  const invite = await inviter.caller.request('POST', '/v1/invitations', { email, role });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.body}`);
  const token = tokenFromEmail(t.outbox, email);
  const member = await signUp(t, { email });
  const accept = await member.caller.request('POST', '/v1/invitations/accept', { token });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.body}`);
  return { ...member, orgId: inviter.orgId };
}

export async function createKey(caller: Caller, body: Record<string, unknown> = { name: 'server', type: 'private' }): Promise<{ id: string; key: string }> {
  const res = await caller.request('POST', '/v1/api-keys', body);
  if (res.statusCode !== 201) throw new Error(`create key failed: ${res.body}`);
  return json(res);
}
