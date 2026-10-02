import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import { createKey, createTestApp, json, keyCaller, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('token bucket', () => {
  it('allows the limit per window, then reports when to retry, and refills', () => {
    const clock = { now: 0 };
    const limiter = new MemoryRateLimiter(() => clock.now);
    for (let i = 0; i < 3; i++) expect(limiter.consume('k', 3, 60_000).allowed).toBe(true);
    const blocked = limiter.consume('k', 3, 60_000);
    expect(blocked).toEqual({ allowed: false, limit: 3, remaining: 0, retryAfterSeconds: 20 });
    clock.now += 20_000;
    expect(limiter.consume('k', 3, 60_000).allowed).toBe(true);
    expect(limiter.consume('other', 3, 60_000).allowed).toBe(true);
  });
});

describe('API rate limits', () => {
  let t: TestApp;
  let owner: SignedUp;

  beforeAll(async () => {
    t = await createTestApp({ env: { RATE_LIMIT_KEY_PER_MINUTE: '5', RATE_LIMIT_ORG_PER_MINUTE: '8' } });
    owner = await signUp(t);
  });
  afterAll(async () => t.close());

  it('limits each API key, with 429, Retry-After and the JSON error shape', async () => {
    const server = keyCaller(t, (await createKey(owner.caller)).key);
    for (let i = 0; i < 5; i++) {
      const ok = await server.request('GET', '/v1/org');
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['x-ratelimit-limit']).toBeDefined();
    }
    const blocked = await server.request('GET', '/v1/org');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBe(12);
    expect(json(blocked)).toMatchObject({ code: 'rate_limited', details: { scope: 'key', limit: 5, retryAfterSeconds: 12 } });

    t.clock.now += 12_000;
    expect((await server.request('GET', '/v1/org')).statusCode).toBe(200);
  });

  it('limits the whole org across its keys and sessions, without affecting other orgs', async () => {
    const org = await signUp(t);
    const other = await signUp(t);
    const k1 = keyCaller(t, (await createKey(org.caller)).key);
    const k2 = keyCaller(t, (await createKey(org.caller)).key);
    // 2 key creations above used 2 of the org's 8; 3 + 3 more reach the limit
    for (let i = 0; i < 3; i++) expect((await k1.request('GET', '/v1/org')).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await k2.request('GET', '/v1/org')).statusCode).toBe(200);
    const blocked = await org.caller.request('GET', '/v1/org');
    expect(blocked.statusCode).toBe(429);
    expect(json(blocked).details.scope).toBe('org');
    expect((await other.caller.request('GET', '/v1/org')).statusCode).toBe(200);
  });

  it('honours per-key and per-org overrides', async () => {
    const org = await signUp(t);
    const tight = keyCaller(t, (await createKey(org.caller, { name: 'tight', type: 'private', rateLimitPerMinute: 2 })).key);
    expect((await tight.request('GET', '/v1/org')).statusCode).toBe(200);
    expect((await tight.request('GET', '/v1/org')).statusCode).toBe(200);
    expect(json(await tight.request('GET', '/v1/org')).details).toMatchObject({ scope: 'key', limit: 2 });

    const roomy = await signUp(t);
    await t.db.query('UPDATE org SET rate_limit_per_minute = 50 WHERE id = $1', [roomy.orgId]);
    for (let i = 0; i < 20; i++) expect((await roomy.caller.request('GET', '/v1/org')).statusCode).toBe(200);
  });
});
