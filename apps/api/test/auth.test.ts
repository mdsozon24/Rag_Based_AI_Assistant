import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, DASHBOARD, json, login, PASSWORD, sessionCaller, sessionCookie, signUp, tokenFromEmail, uniqueEmail, type TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => t.app.inject({ method: 'POST', url, payload: payload as object, headers });

describe('sign-up and email verification', () => {
  it('signs up, requires verification, then signs in with an owner org', async () => {
    const email = uniqueEmail('signup');
    const res = await post('/v1/auth/signup', { email: email.toUpperCase(), password: PASSWORD, name: 'Ada', orgName: 'Ada Labs' });
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ status: 'verification_sent', message: expect.any(String) });

    const early = await post('/v1/auth/login', { email, password: PASSWORD });
    expect(early.statusCode).toBe(403);
    expect(json(early)).toEqual({ code: 'email_not_verified', message: expect.any(String), details: {} });

    const verify = await post('/v1/auth/verify-email', { token: tokenFromEmail(t.outbox, email) });
    expect(verify.statusCode).toBe(200);
    expect(json(verify).user).toMatchObject({ email, emailVerified: true });

    const ok = await post('/v1/auth/login', { email, password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.headers['set-cookie'] as string;
    expect(cookie).toMatch(/^octo_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(json(ok)).toMatchObject({ user: { email, name: 'Ada' }, orgs: [{ name: 'Ada Labs', role: 'owner' }] });
    expect(json(ok).activeOrgId).toBe(json(ok).orgs[0].id);

    const me = await sessionCaller(t, sessionCookie(ok)).request('GET', '/v1/me');
    expect(json(me)).toMatchObject({ user: { email }, activeOrgId: json(ok).activeOrgId });
  });

  it('verification tokens are single-use', async () => {
    const email = uniqueEmail('single');
    await post('/v1/auth/signup', { email, password: PASSWORD, name: 'Bo' });
    const token = tokenFromEmail(t.outbox, email);
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(200);
    const again = await post('/v1/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
    expect(json(again).code).toBe('bad_request');
  });

  it('does not reveal whether an email is registered', async () => {
    const existing = await signUp(t);
    const before = t.outbox.sent.length;
    const res = await post('/v1/auth/signup', { email: existing.email, password: 'another password 123', name: 'Mallory' });
    expect(res.statusCode).toBe(202);
    expect(json(res).status).toBe('verification_sent');
    // The real owner gets a heads-up instead of a second account
    expect(t.outbox.sent.length).toBe(before + 1);
    expect(t.outbox.last(existing.email)!.subject).toMatch(/Sign-up attempt/);
    const count = await t.db.query<{ n: string }>('SELECT count(*) AS n FROM app_user WHERE email = $1', [existing.email]);
    expect(Number(count.rows[0].n)).toBe(1);

    expect((await post('/v1/auth/forgot-password', { email: uniqueEmail('nobody') })).statusCode).toBe(202);
    expect((await post('/v1/auth/resend-verification', { email: uniqueEmail('nobody') })).statusCode).toBe(202);
  });

  it('validates input with field-level details', async () => {
    const res = await post('/v1/auth/signup', { email: 'not-an-email', password: 'short', name: '' });
    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.code).toBe('validation_error');
    expect(body.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['email', 'name', 'password']);
  });

  it('resends a verification link that works and invalidates the old one', async () => {
    const email = uniqueEmail('resend');
    await post('/v1/auth/signup', { email, password: PASSWORD, name: 'Cy' });
    const first = tokenFromEmail(t.outbox, email);
    await post('/v1/auth/resend-verification', { email });
    const second = tokenFromEmail(t.outbox, email);
    expect(second).not.toBe(first);
    expect((await post('/v1/auth/verify-email', { token: first })).statusCode).toBe(400);
    expect((await post('/v1/auth/verify-email', { token: second })).statusCode).toBe(200);
  });
});

describe('sign-in, sessions and sign-out', () => {
  it('rejects wrong passwords and unknown emails with the same answer, and audits failures', async () => {
    const user = await signUp(t);
    const wrong = await post('/v1/auth/login', { email: user.email, password: 'wrong password!' });
    const unknown = await post('/v1/auth/login', { email: uniqueEmail('ghost'), password: 'wrong password!' });
    expect(wrong.statusCode).toBe(401);
    expect(json(wrong)).toEqual(json(unknown));
    const failed = await t.db.query('SELECT 1 FROM audit_log WHERE action = $1 AND actor_id = $2', ['auth.login_failed', user.userId]);
    expect(failed.rowCount).toBe(1);
  });

  it('records sign-ins in the org audit log', async () => {
    const user = await signUp(t);
    const logins = await t.db.query('SELECT 1 FROM audit_log WHERE action = $1 AND org_id = $2 AND actor_id = $3', ['auth.login', user.orgId, user.userId]);
    expect(logins.rowCount).toBe(1);
  });

  it('signs out: the session stops working', async () => {
    const user = await signUp(t);
    const out = await user.caller.request('POST', '/v1/auth/logout');
    expect(out.statusCode).toBe(204);
    const me = await user.caller.request('GET', '/v1/me');
    expect(me.statusCode).toBe(401);
    expect(json(me).code).toBe('session_expired');
  });

  it('expires idle sessions', async () => {
    const user = await signUp(t);
    await t.db.query(`UPDATE session SET last_seen_at = now() - interval '8 days' WHERE user_id = $1`, [user.userId]);
    expect(json(await user.caller.request('GET', '/v1/me')).code).toBe('session_expired');
  });

  it('requires a session or key, and rejects unknown cookies', async () => {
    expect(json(await t.app.inject({ method: 'GET', url: '/v1/me' })).code).toBe('unauthorized');
    expect((await sessionCaller(t, 'octo_session=forged').request('GET', '/v1/me')).statusCode).toBe(401);
  });

  it('blocks cross-site state changes made with the session cookie (CSRF)', async () => {
    const user = await signUp(t);
    const noOrigin = await t.app.inject({ method: 'PATCH', url: '/v1/org', headers: { cookie: user.cookie }, payload: { name: 'pwned' } });
    expect(noOrigin.statusCode).toBe(403);
    expect(json(noOrigin).code).toBe('csrf_origin_mismatch');
    const evil = await user.caller.request('PATCH', '/v1/org', { name: 'pwned' }, { origin: 'https://evil.example' });
    expect(json(evil).code).toBe('csrf_origin_mismatch');
    // Reads stay allowed; the dashboard origin works
    expect((await t.app.inject({ method: 'GET', url: '/v1/org', headers: { cookie: user.cookie } })).statusCode).toBe(200);
    expect((await user.caller.request('PATCH', '/v1/org', { name: 'Renamed' })).statusCode).toBe(200);
  });

  it('switches the active org only to orgs the user belongs to', async () => {
    const user = await signUp(t);
    const created = await user.caller.request('POST', '/v1/orgs', { name: 'Second Org' });
    expect(created.statusCode).toBe(201);
    expect(json(await user.caller.request('GET', '/v1/org')).name).toBe('Second Org');
    expect((await user.caller.request('PUT', '/v1/me/active-org', { orgId: user.orgId })).statusCode).toBe(200);
    expect(json(await user.caller.request('GET', '/v1/org')).id).toBe(user.orgId);
    const other = await signUp(t);
    const sneaky = await user.caller.request('PUT', '/v1/me/active-org', { orgId: other.orgId });
    expect(sneaky.statusCode).toBe(404);
  });
});

describe('password reset', () => {
  it('resets the password, signs out every session, and the link works once', async () => {
    const user = await signUp(t);
    const second = await login(t, user.email);
    expect((await post('/v1/auth/forgot-password', { email: user.email })).statusCode).toBe(202);
    const token = tokenFromEmail(t.outbox, user.email);

    const weak = await post('/v1/auth/reset-password', { token, password: 'short' });
    expect(weak.statusCode).toBe(400);

    const reset = await post('/v1/auth/reset-password', { token, password: 'a brand new passphrase' });
    expect(reset.statusCode).toBe(200);
    for (const caller of [user.caller, second.caller]) expect((await caller.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: user.email, password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: user.email, password: 'a brand new passphrase' })).statusCode).toBe(200);
    expect((await post('/v1/auth/reset-password', { token, password: 'yet another passphrase' })).statusCode).toBe(400);

    const audited = await t.db.query('SELECT metadata FROM audit_log WHERE action = $1 AND actor_id = $2', ['auth.password_reset', user.userId]);
    expect(audited.rows[0]).toMatchObject({ metadata: { sessionsRevoked: 2 } });
  });

  it('rejects expired reset links', async () => {
    const user = await signUp(t);
    await post('/v1/auth/forgot-password', { email: user.email });
    const token = tokenFromEmail(t.outbox, user.email);
    await t.db.query(`UPDATE email_token SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND purpose = 'reset_password'`, [user.userId]);
    expect((await post('/v1/auth/reset-password', { token, password: 'a brand new passphrase' })).statusCode).toBe(400);
  });
});

describe('sign-in rate limits', () => {
  it('limits attempts per email with 429 and Retry-After', async () => {
    const limited = await createTestApp({ env: { AUTH_RATE_LIMIT_PER_15_MIN: '3' } });
    try {
      const email = uniqueEmail('brute');
      const attempt = () => limited.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'guess guess guess' }, remoteAddress: `10.0.0.${Math.floor(Math.random() * 200)}` });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(json(blocked).code).toBe('rate_limited');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

describe('Google OAuth (behind a flag)', () => {
  it('is off unless enabled', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/auth/google/start' })).statusCode).toBe(404);
  });

  it('signs in with Google: PKCE + state, verified email required, links existing accounts', async () => {
    const profiles: Record<string, { sub: string; email: string; email_verified: boolean; name: string }> = {};
    const calls: { url: string; body?: string }[] = [];
    const fakeFetch = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      calls.push({ url, body: init?.body });
      if (url.includes('/token')) {
        const code = new URLSearchParams(init!.body).get('code')!;
        return { ok: true, status: 200, json: async () => ({ access_token: `at-${code}` }) };
      }
      const code = init!.headers!.Authorization.replace('Bearer at-', '');
      return { ok: true, status: 200, json: async () => profiles[code] };
    };
    const g = await createTestApp({
      env: { GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REDIRECT_URI: 'https://api.octo.test/v1/auth/google/callback' },
      fetch: fakeFetch,
    });
    try {
      const signInWith = async (code: string, tamper = false) => {
        const start = await g.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
        expect(start.statusCode).toBe(302);
        const location = new URL(start.headers.location as string);
        expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        const state = location.searchParams.get('state')!;
        const oauthCookie = (start.headers['set-cookie'] as string).split(';')[0];
        return g.app.inject({ method: 'GET', url: `/v1/auth/google/callback?code=${code}&state=${tamper ? 'wrong' : state}`, headers: { cookie: oauthCookie } });
      };

      profiles.c1 = { sub: 'google-1', email: 'gina@example.com', email_verified: true, name: 'Gina' };
      expect((await signInWith('c1', true)).statusCode).toBe(400);

      const first = await signInWith('c1');
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).toBe(DASHBOARD);
      const me = json(await sessionCaller(g, sessionCookie(first)).request('GET', '/v1/me'));
      expect(me).toMatchObject({ user: { email: 'gina@example.com', emailVerified: true }, orgs: [{ role: 'owner' }] });
      expect(calls.find((c) => c.url.includes('/token'))!.body).toMatch(/code_verifier=/);

      // Same Google account again: same user, no second org
      const again = await signInWith('c1');
      expect(json(await sessionCaller(g, sessionCookie(again)).request('GET', '/v1/me')).user.id).toBe(me.user.id);

      // Existing password user with the same (verified-by-Google) email gets linked
      const existing = await signUp(g, { email: 'pat@example.com' });
      profiles.c2 = { sub: 'google-2', email: 'pat@example.com', email_verified: true, name: 'Pat' };
      const linked = await signInWith('c2');
      expect(json(await sessionCaller(g, sessionCookie(linked)).request('GET', '/v1/me')).user.id).toBe(existing.userId);

      profiles.c3 = { sub: 'google-3', email: 'unverified@example.com', email_verified: false, name: 'U' };
      expect((await signInWith('c3')).statusCode).toBe(401);
    } finally {
      await g.close();
    }
  });
});
