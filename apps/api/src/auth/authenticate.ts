/**
 * Request authentication, org resolution, RBAC and rate limiting: one hook for every route.
 *
 * Every route declares `config.auth` ('none' | 'user' | 'org'; default 'org', so a route that
 * forgets to say is locked down). For 'org' routes the request ends up with exactly one org:
 * - API key: the key's org;
 * - dashboard session: the session's active org, after re-checking membership.
 * The handler then gets request.org.run(), which scopes every query to that org.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../http/errors.ts';
import type { AppContext, OrgScope, Principal, RouteAuthConfig } from '../context.ts';
import { audit, type Actor } from '../services/audit.ts';
import { apiKeyType, sha256 } from './crypto.ts';
import { findApiKeyByHash, findSession, revokeSession } from './identity.ts';
import { permissionsForRole, PRIVATE_KEY_PERMISSIONS, PUBLIC_KEY_PERMISSIONS, type Permission, type Role } from './permissions.ts';

export const SESSION_COOKIE = 'octo_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MINUTE = 60_000;
/** last_used_at is written at most this often per key; key usage is audited at most this often. */
const KEY_TOUCH_MS = MINUTE;
const KEY_AUDIT_MS = 10 * MINUTE;
const SESSION_TOUCH_MS = 5 * MINUTE;

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new ApiError('unauthorized', 'Authorization header must be "Bearer <api key>"');
  return match[1];
}

/** Cookie-authenticated state changes must come from the dashboard (CSRF). */
function assertSameOrigin(request: FastifyRequest, ctx: AppContext): void {
  if (!UNSAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (!origin || !ctx.config.dashboardOrigins.includes(origin)) {
    throw new ApiError('csrf_origin_mismatch', 'Request origin is not allowed for cookie authentication', { origin: origin ?? null });
  }
}

interface KeyAuth {
  principal: Extract<Principal, { kind: 'api_key' }>;
  limits: { key: number | null; org: number | null };
}

async function authenticateApiKey(token: string, request: FastifyRequest, ctx: AppContext): Promise<KeyAuth> {
  const type = apiKeyType(token);
  const row = type ? await ctx.tenants.identity((tx) => findApiKeyByHash(tx, sha256(token))) : null;
  // Same answer for unknown, revoked and expired keys: no oracle for key states
  if (!row || row.revoked_at || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
    throw new ApiError('invalid_api_key', 'Invalid, revoked or expired API key');
  }
  if (row.org_status !== 'active') throw new ApiError('org_suspended', 'This organization is suspended');
  await trackKeyUse(row.id, row.org_id, row.last_used_at, request, ctx);
  return {
    principal: { kind: 'api_key', keyId: row.id, keyType: row.type, orgId: row.org_id, allowedOrigins: row.allowed_origins, allowedAssistantIds: row.allowed_assistant_ids },
    limits: { key: row.rate_limit_per_minute, org: row.org_rate_limit_per_minute },
  };
}

/** Record key usage: last_used_at (throttled) and an audit entry (throttled). */
async function trackKeyUse(keyId: string, orgId: string, lastUsed: Date | null, request: FastifyRequest, ctx: AppContext): Promise<void> {
  const age = lastUsed ? Date.now() - lastUsed.getTime() : Infinity;
  if (age < KEY_TOUCH_MS) return;
  try {
    await ctx.tenants.withOrg(orgId, async (tx) => {
      await tx.query('UPDATE api_key SET last_used_at = now() WHERE id = $1 AND org_id = $2', [keyId, orgId]);
      if (age >= KEY_AUDIT_MS) {
        await audit(tx, { orgId, actor: { type: 'api_key', id: keyId }, action: 'api_key.used', targetType: 'api_key', targetId: keyId, metadata: { method: request.method, path: request.routeOptions.url }, ip: clientIp(request) });
      }
    });
  } catch (err) {
    request.log.warn({ err, key_id: keyId }, 'could not record API key use');
  }
}

async function authenticateSession(token: string, request: FastifyRequest, reply: FastifyReply, ctx: AppContext): Promise<Principal> {
  const session = await ctx.tenants.identity((tx) => findSession(tx, token));
  const now = Date.now();
  const expired = !session || session.revoked_at || session.expires_at.getTime() <= now || now - session.last_seen_at.getTime() > ctx.config.sessionIdleMs;
  if (expired) {
    if (session && !session.revoked_at) await ctx.tenants.identity((tx) => revokeSession(tx, session.id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    throw new ApiError('session_expired', 'Your session has expired; sign in again');
  }
  if (!session.email_verified_at) throw new ApiError('email_not_verified', 'Verify your email address first');
  if (now - session.last_seen_at.getTime() > SESSION_TOUCH_MS) {
    await ctx.tenants.identity((tx) => tx.query('UPDATE session SET last_seen_at = now() WHERE id = $1', [session.id]));
  }
  return { kind: 'session', userId: session.user_id, sessionId: session.id, activeOrgId: session.active_org_id };
}

function rateLimit(request: FastifyRequest, reply: FastifyReply, ctx: AppContext, orgId: string, keyId: string | null, overrides: { key?: number | null; org?: number | null }): void {
  const checks: [string, number][] = [[`org:${orgId}`, overrides.org ?? ctx.config.rateLimit.orgPerMinute]];
  if (keyId) checks.unshift([`key:${keyId}`, overrides.key ?? ctx.config.rateLimit.keyPerMinute]);
  let tightest: { limit: number; remaining: number } | null = null;
  for (const [bucket, limit] of checks) {
    const decision = ctx.rateLimiter.consume(bucket, limit, MINUTE);
    if (!decision.allowed) {
      throw new ApiError(
        'rate_limited',
        `Rate limit exceeded for this ${bucket.startsWith('key') ? 'API key' : 'organization'}; retry after ${decision.retryAfterSeconds}s`,
        { scope: bucket.split(':')[0], limit: decision.limit, retryAfterSeconds: decision.retryAfterSeconds },
        { 'Retry-After': String(decision.retryAfterSeconds) }
      );
    }
    if (!tightest || decision.remaining < tightest.remaining) tightest = decision;
  }
  if (tightest) {
    reply.header('X-RateLimit-Limit', String(tightest.limit));
    reply.header('X-RateLimit-Remaining', String(tightest.remaining));
  }
}

function orgScope(ctx: AppContext, orgId: string, role: Role | null, permissions: ReadonlySet<Permission>, actor: Actor, principal: Principal): OrgScope {
  return {
    id: orgId,
    role,
    permissions,
    actor,
    run: (fn) => ctx.tenants.withOrg(orgId, fn),
    can: (permission) => permissions.has(permission),
    assertAssistantAllowed(assistantId: string) {
      if (principal.kind === 'api_key' && principal.keyType === 'public' && principal.allowedAssistantIds.length > 0 && !principal.allowedAssistantIds.includes(assistantId)) {
        throw new ApiError('forbidden', 'This public key may not be used for this assistant', { assistantId });
      }
    },
  };
}

export function registerAuthentication(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('org', null);

  app.addHook('onRequest', async (request, reply) => {
    const config: RouteAuthConfig = request.routeOptions.config ?? {};
    // Unmatched routes are answered by the 404 handler
    if (!request.routeOptions.url) return;
    const mode = config.auth ?? 'org';
    if (mode === 'none') return;

    const token = bearerToken(request);
    const cookie = request.cookies?.[SESSION_COOKIE];
    let principal: Principal;
    let keyLimits: KeyAuth['limits'] = { key: null, org: null };
    if (token) ({ principal, limits: keyLimits } = await authenticateApiKey(token, request, ctx));
    else if (cookie) principal = await authenticateSession(cookie, request, reply, ctx);
    else throw new ApiError('unauthorized', 'Sign in or send an API key (Authorization: Bearer <key>)');
    request.principal = principal;

    if (principal.kind === 'session') assertSameOrigin(request, ctx);

    if (mode === 'user') {
      if (principal.kind !== 'session') throw new ApiError('forbidden_key_type', 'This endpoint needs a dashboard session, not an API key');
      return;
    }

    // mode === 'org'
    let scope: OrgScope;
    if (principal.kind === 'api_key') {
      if (principal.keyType === 'public') {
        if (!config.allowPublicKey) throw new ApiError('forbidden_key_type', 'Public keys can only start web calls; use a private key on the server');
        const origin = request.headers.origin;
        if (!origin || !principal.allowedOrigins.includes(origin)) {
          throw new ApiError('origin_not_allowed', 'This public key may not be used from this origin', { origin: origin ?? null });
        }
      }
      const permissions = principal.keyType === 'private' ? PRIVATE_KEY_PERMISSIONS : PUBLIC_KEY_PERMISSIONS;
      scope = orgScope(ctx, principal.orgId, null, permissions, { type: 'api_key', id: principal.keyId }, principal);
      rateLimit(request, reply, ctx, principal.orgId, principal.keyId, keyLimits);
    } else {
      const orgId = principal.activeOrgId;
      if (!orgId) throw new ApiError('no_active_org', 'Select an organization first (PUT /v1/me/active-org)');
      const found = await ctx.tenants.withOrg(orgId, async (tx) => {
        const member = await tx.query<{ role: Role }>('SELECT role FROM membership WHERE org_id = $1 AND user_id = $2', [orgId, principal.userId]);
        const org = await tx.query<{ status: string; rate_limit_per_minute: number | null }>('SELECT status, rate_limit_per_minute FROM org WHERE id = $1', [orgId]);
        return { role: member.rows[0]?.role, org: org.rows[0] };
      });
      if (!found.role || !found.org) throw new ApiError('forbidden', 'You are not a member of this organization');
      if (found.org.status !== 'active' && !(request.method === 'GET' && config.permission === 'org:read')) {
        throw new ApiError('org_suspended', 'This organization is suspended');
      }
      scope = orgScope(ctx, orgId, found.role, permissionsForRole(found.role), { type: 'user', id: principal.userId }, principal);
      rateLimit(request, reply, ctx, orgId, null, { org: found.org.rate_limit_per_minute });
    }

    if (config.permission && !scope.can(config.permission)) {
      throw new ApiError('forbidden', `Missing permission ${config.permission}`, { permission: config.permission, role: scope.role ?? `${principal.kind === 'api_key' ? principal.keyType : ''}_key` });
    }
    request.org = scope;
  });
}

/** Auth endpoints (sign-in, sign-up, resets): limit attempts per IP and, when given, per email. */
export function limitAuthAttempt(request: FastifyRequest, ctx: AppContext, email?: string): void {
  const window = 15 * MINUTE;
  const buckets = [`auth-ip:${clientIp(request)}`, ...(email ? [`auth-email:${email.trim().toLowerCase()}`] : [])];
  for (const bucket of buckets) {
    const decision = ctx.rateLimiter.consume(bucket, ctx.config.rateLimit.authPer15Min, window);
    if (!decision.allowed) {
      throw new ApiError('rate_limited', `Too many attempts; retry after ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds }, { 'Retry-After': String(decision.retryAfterSeconds) });
    }
  }
}
