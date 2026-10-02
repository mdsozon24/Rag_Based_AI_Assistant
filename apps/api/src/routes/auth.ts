/**
 * Dashboard authentication: sign-up, email verification, sign-in/out, password reset, and
 * Google OAuth (behind GOOGLE_OAUTH_ENABLED).
 *
 * Anti-enumeration: sign-up, resend and forgot-password answer 202 whether or not the email exists.
 * Sign-in attempts are limited per IP and per email. A password reset signs out every session.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { burnPasswordCheck, hashPassword, passwordSchema, randomToken, verifyPassword } from '../auth/crypto.ts';
import { clientIp, limitAuthAttempt, SESSION_COOKIE } from '../auth/authenticate.ts';
import {
  consumeEmailToken,
  createEmailToken,
  createOrg,
  createSession,
  createUser,
  findUserByEmail,
  findUserByGoogleSub,
  findUserById,
  listUserOrgs,
  publicUser,
  revokeAllSessions,
  revokeSession,
  type UserRow,
} from '../auth/identity.ts';
import { ApiError } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import type { Queryable } from '../db/database.ts';

const HOUR = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * HOUR;
const RESET_TTL_MS = HOUR;
const OAUTH_COOKIE = 'octo_oauth';

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(1).max(100);

export function setSessionCookie(reply: FastifyReply, ctx: AppContext, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
  });
}

async function sendVerification(ctx: AppContext, tx: Queryable, user: Pick<UserRow, 'id' | 'email'>): Promise<() => Promise<void>> {
  const token = randomToken();
  await createEmailToken(tx, user.id, 'verify_email', token, VERIFY_TTL_MS);
  // Send after the transaction commits
  return () =>
    ctx.mailer.send({
      to: user.email,
      subject: 'Verify your email for Voice of Octo',
      text: `Confirm your email address: ${ctx.config.dashboardUrl}/verify-email?token=${token}\n\nThe link expires in 24 hours.`,
    });
}

/** Start a dashboard session for `user`, with their first org active. */
async function startSession(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, user: UserRow, method: string) {
  const token = randomToken();
  const result = await ctx.tenants.identity(async (tx) => {
    const orgs = await listUserOrgs(tx, user.id);
    const activeOrgId = orgs[0]?.id ?? null;
    await createSession(tx, { userId: user.id, token, activeOrgId, ttlMs: ctx.config.sessionTtlMs, ip: clientIp(request), userAgent: request.headers['user-agent'] });
    await tx.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.id]);
    // Logins are recorded in the org the session opens, so org admins see member sign-ins
    await audit(tx, { orgId: activeOrgId, actor: { type: 'user', id: user.id }, action: 'auth.login', targetType: 'user', targetId: user.id, metadata: { method }, ip: clientIp(request) });
    return { orgs, activeOrgId };
  });
  setSessionCookie(reply, ctx, token);
  return { user: publicUser(user), orgs: result.orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role })), activeOrgId: result.activeOrgId };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const open = { config: { auth: 'none' as const } };

  app.post('/v1/auth/signup', open, async (request, reply) => {
    limitAuthAttempt(request, ctx);
    const body = parse(z.object({ email, password: passwordSchema, name, orgName: z.string().trim().min(1).max(100).optional() }), request.body);
    const passwordHash = await hashPassword(body.password);
    const send = await ctx.tenants.identity(async (tx) => {
      const existing = await findUserByEmail(tx, body.email);
      if (existing) {
        return () =>
          ctx.mailer.send({
            to: existing.email,
            subject: 'Sign-up attempt for your Voice of Octo account',
            text: `Someone tried to create an account with this email address. If it was you, sign in or reset your password at ${ctx.config.dashboardUrl}/forgot-password.`,
          });
      }
      const user = await createUser(tx, { email: body.email, name: body.name, passwordHash });
      const org = await createOrg(tx, body.orgName ?? `${body.name}'s organization`, user.id);
      await audit(tx, { orgId: null, actor: { type: 'user', id: user.id }, action: 'auth.signup', targetType: 'user', targetId: user.id, ip: clientIp(request) });
      await audit(tx, { orgId: org.id, actor: { type: 'user', id: user.id }, action: 'org.created', targetType: 'org', targetId: org.id, metadata: { name: org.name } });
      return sendVerification(ctx, tx, user);
    });
    await send();
    return reply.code(202).send({ status: 'verification_sent', message: 'Check your email to verify your address.' });
  });

  app.post('/v1/auth/verify-email', open, async (request) => {
    limitAuthAttempt(request, ctx);
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), request.body);
    const user = await ctx.tenants.identity(async (tx) => {
      const userId = await consumeEmailToken(tx, 'verify_email', token);
      if (!userId) return null;
      await tx.query('UPDATE app_user SET email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId]);
      await audit(tx, { orgId: null, actor: { type: 'user', id: userId }, action: 'auth.email_verified', targetType: 'user', targetId: userId, ip: clientIp(request) });
      return findUserById(tx, userId);
    });
    if (!user) throw new ApiError('bad_request', 'This verification link is invalid or has expired');
    return { user: publicUser(user) };
  });

  app.post('/v1/auth/resend-verification', open, async (request, reply) => {
    const body = parse(z.object({ email }), request.body);
    limitAuthAttempt(request, ctx, body.email);
    const send = await ctx.tenants.identity(async (tx) => {
      const user = await findUserByEmail(tx, body.email);
      return user && !user.email_verified_at ? sendVerification(ctx, tx, user) : null;
    });
    await send?.();
    return reply.code(202).send({ status: 'ok' });
  });

  app.post('/v1/auth/login', open, async (request, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200) }), request.body);
    limitAuthAttempt(request, ctx, body.email);
    const user = await ctx.tenants.identity((tx) => findUserByEmail(tx, body.email));
    const valid = user?.password_hash ? await verifyPassword(user.password_hash, body.password) : (await burnPasswordCheck(body.password), false);
    if (!user || !valid) {
      await ctx.tenants.identity((tx) =>
        audit(tx, { orgId: null, actor: { type: user ? 'user' : 'system', id: user?.id ?? null }, action: 'auth.login_failed', metadata: { email: body.email }, ip: clientIp(request) })
      );
      throw new ApiError('unauthorized', 'Invalid email or password');
    }
    if (!user.email_verified_at) throw new ApiError('email_not_verified', 'Verify your email address first; we can resend the link');
    return startSession(ctx, request, reply, user, 'password');
  });

  app.post('/v1/auth/logout', { config: { auth: 'user' } }, async (request, reply) => {
    const principal = request.principal;
    if (principal?.kind === 'session') {
      await ctx.tenants.identity(async (tx) => {
        await revokeSession(tx, principal.sessionId);
        await audit(tx, { orgId: principal.activeOrgId, actor: { type: 'user', id: principal.userId }, action: 'auth.logout', targetType: 'user', targetId: principal.userId, ip: clientIp(request) });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.post('/v1/auth/forgot-password', open, async (request, reply) => {
    const body = parse(z.object({ email }), request.body);
    limitAuthAttempt(request, ctx, body.email);
    const send = await ctx.tenants.identity(async (tx) => {
      const user = await findUserByEmail(tx, body.email);
      if (!user) return null;
      const token = randomToken();
      await createEmailToken(tx, user.id, 'reset_password', token, RESET_TTL_MS);
      await audit(tx, { orgId: null, actor: { type: 'user', id: user.id }, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, ip: clientIp(request) });
      return () =>
        ctx.mailer.send({
          to: user.email,
          subject: 'Reset your Voice of Octo password',
          text: `Choose a new password: ${ctx.config.dashboardUrl}/reset-password?token=${token}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
        });
    });
    await send?.();
    return reply.code(202).send({ status: 'ok' });
  });

  app.post('/v1/auth/reset-password', open, async (request) => {
    limitAuthAttempt(request, ctx);
    const body = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }), request.body);
    const passwordHash = await hashPassword(body.password);
    const ok = await ctx.tenants.identity(async (tx) => {
      const userId = await consumeEmailToken(tx, 'reset_password', body.token);
      if (!userId) return false;
      // The reset link proved control of the inbox, so the address is verified too
      await tx.query('UPDATE app_user SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId, passwordHash]);
      const revoked = await revokeAllSessions(tx, userId);
      await audit(tx, { orgId: null, actor: { type: 'user', id: userId }, action: 'auth.password_reset', targetType: 'user', targetId: userId, metadata: { sessionsRevoked: revoked }, ip: clientIp(request) });
      return true;
    });
    if (!ok) throw new ApiError('bad_request', 'This reset link is invalid or has expired');
    return { status: 'ok', message: 'Password changed. Sign in with your new password.' };
  });

  // ---------------------------------------------------------------- Google OAuth (optional)

  const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
  const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

  function requireGoogle() {
    const g = ctx.config.google;
    if (!g.enabled || !g.clientId || !g.clientSecret || !g.redirectUri) throw new ApiError('not_found', 'Route not found');
    return g as Required<typeof g>;
  }

  app.get('/v1/auth/google/start', open, async (_request, reply) => {
    const g = requireGoogle();
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    reply.setCookie(OAUTH_COOKIE, `${state}.${verifier}`, { path: '/v1/auth/google', httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`${GOOGLE_AUTH}?${params}`);
  });

  app.get('/v1/auth/google/callback', open, async (request, reply) => {
    const g = requireGoogle();
    limitAuthAttempt(request, ctx);
    const query = parse(z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) }), request.query);
    const [state, verifier] = (request.cookies?.[OAUTH_COOKIE] ?? '').split('.');
    reply.clearCookie(OAUTH_COOKIE, { path: '/v1/auth/google' });
    if (!state || !verifier || state !== query.state) throw new ApiError('bad_request', 'Sign-in with Google expired or was tampered with; try again');

    const signal = AbortSignal.timeout(10_000);
    const tokenResponse = await ctx.fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: query.code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }).toString(),
      signal,
    });
    if (!tokenResponse.ok) throw new ApiError('unauthorized', 'Google did not accept the sign-in');
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
    const infoResponse = accessToken ? await ctx.fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` }, signal }) : null;
    if (!infoResponse?.ok) throw new ApiError('unauthorized', 'Could not read your Google profile');
    const info = (await infoResponse.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!info.sub || !info.email || info.email_verified !== true) throw new ApiError('unauthorized', 'Your Google account email is not verified');
    const googleSub = info.sub;
    const googleEmail = info.email.toLowerCase();

    const user = await ctx.tenants.identity(async (tx) => {
      const bySub = await findUserByGoogleSub(tx, googleSub);
      if (bySub) return bySub;
      const byEmail = await findUserByEmail(tx, googleEmail);
      if (byEmail) {
        // Google verified the address, so linking to the existing account is safe
        await tx.query('UPDATE app_user SET google_sub = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1', [byEmail.id, googleSub]);
        await audit(tx, { orgId: null, actor: { type: 'user', id: byEmail.id }, action: 'auth.google_linked', targetType: 'user', targetId: byEmail.id, ip: clientIp(request) });
        return (await findUserById(tx, byEmail.id))!;
      }
      const created = await createUser(tx, { email: googleEmail, name: (info.name ?? googleEmail.split('@')[0]).slice(0, 100), passwordHash: null, googleSub, verified: true });
      const org = await createOrg(tx, `${created.name}'s organization`, created.id);
      await audit(tx, { orgId: null, actor: { type: 'user', id: created.id }, action: 'auth.signup', targetType: 'user', targetId: created.id, metadata: { method: 'google' }, ip: clientIp(request) });
      await audit(tx, { orgId: org.id, actor: { type: 'user', id: created.id }, action: 'org.created', targetType: 'org', targetId: org.id, metadata: { name: org.name } });
      return created;
    });
    await startSession(ctx, request, reply, user, 'google');
    return reply.redirect(ctx.config.dashboardUrl);
  });
}
