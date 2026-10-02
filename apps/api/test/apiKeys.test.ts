/**
 * API keys (show once, hashed, masked, revocation, expiry, public-key restrictions) and the API
 * conventions (error shape, pagination, idempotency). Public keys and idempotency are exercised on
 * a test-only route standing in for POST /v1/calls, which arrives with the voice engine wiring.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/errors.ts';
import { createKey, createTestApp, json, keyCaller, signUp, type SignedUp, type TestApp } from './helpers.ts';

let t: TestApp;
let owner: SignedUp;
let handlerRuns = 0;

beforeAll(async () => {
  t = await createTestApp({
    extraRoutes: (app) => {
      // Stand-in for POST /v1/calls: public keys allowed, idempotent, assistant-restricted
      app.post('/v1/test/web-calls', { config: { permission: 'calls:create', allowPublicKey: true, idempotent: true } }, async (request, reply) => {
        const body = request.body as { assistantId: string; fail?: boolean };
        request.org!.assertAssistantAllowed(body.assistantId);
        handlerRuns++;
        if (body.fail) throw new ApiError('internal_error', 'simulated failure');
        return reply.code(201).send({ callId: randomUUID(), orgId: request.org!.id, assistantId: body.assistantId });
      });
    },
  });
  owner = await signUp(t);
});
afterAll(async () => t.close());

describe('private API keys', () => {
  it('shows the full key once, stores only a hash, and lists it masked', async () => {
    const created = await owner.caller.request('POST', '/v1/api-keys', { name: 'Backend', type: 'private' });
    expect(created.statusCode).toBe(201);
    const body = json(created);
    expect(body.key).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ name: 'Backend', type: 'private', status: 'active', lastUsedAt: null });

    const stored = await t.db.query<{ key_hash: string; prefix: string }>('SELECT key_hash, prefix FROM api_key WHERE id = $1', [body.id]);
    expect(stored.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows)).not.toContain(body.key);

    const listed = await owner.caller.request('GET', '/v1/api-keys');
    const fetched = await owner.caller.request('GET', `/v1/api-keys/${body.id}`);
    const audit = await owner.caller.request('GET', '/v1/audit-logs?limit=100');
    for (const res of [listed, fetched, audit]) expect(res.body).not.toContain(body.key);
    expect(json(fetched).key).toBe(`${stored.rows[0].prefix}••••••••`);
  });

  it('authenticates server requests, records last use, and audits key usage', async () => {
    const { id, key } = await createKey(owner.caller);
    const res = await keyCaller(t, key).request('GET', '/v1/org');
    expect(res.statusCode).toBe(200);
    expect(json(res).id).toBe(owner.orgId);
    expect(json(await owner.caller.request('GET', `/v1/api-keys/${id}`)).lastUsedAt).not.toBeNull();
    const used = await t.db.query('SELECT 1 FROM audit_log WHERE action = $1 AND actor_id = $2', ['api_key.used', id]);
    expect(used.rowCount).toBe(1);
  });

  it('stops working immediately when revoked', async () => {
    const { id, key } = await createKey(owner.caller);
    const server = keyCaller(t, key);
    expect((await server.request('GET', '/v1/org')).statusCode).toBe(200);
    const revoked = await owner.caller.request('DELETE', `/v1/api-keys/${id}`);
    expect(revoked.statusCode).toBe(200);
    expect(json(revoked)).toMatchObject({ status: 'revoked', revokedAt: expect.any(String) });
    const after = await server.request('GET', '/v1/org');
    expect(after.statusCode).toBe(401);
    expect(json(after)).toEqual({ code: 'invalid_api_key', message: 'Invalid, revoked or expired API key', details: {} });
    expect((await t.db.query('SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2', ['api_key.revoked', id])).rowCount).toBe(1);
  });

  it('a key can revoke itself', async () => {
    const { id, key } = await createKey(owner.caller);
    expect((await keyCaller(t, key).request('DELETE', `/v1/api-keys/${id}`)).statusCode).toBe(200);
    expect((await keyCaller(t, key).request('GET', '/v1/org')).statusCode).toBe(401);
  });

  it('stops working after it expires', async () => {
    const { id, key } = await createKey(owner.caller, { name: 'temp', type: 'private', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await keyCaller(t, key).request('GET', '/v1/org')).statusCode).toBe(200);
    await t.db.query(`UPDATE api_key SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(json(await keyCaller(t, key).request('GET', '/v1/org')).code).toBe('invalid_api_key');
    expect(json(await owner.caller.request('GET', `/v1/api-keys/${id}`)).status).toBe('expired');
  });

  it('rejects malformed and unknown keys the same way', async () => {
    for (const key of ['nope', `sk_${'a'.repeat(43)}`, `pk_${'b'.repeat(43)}`]) {
      expect(json(await keyCaller(t, key).request('GET', '/v1/org')).code).toBe('invalid_api_key');
    }
    expect(json(await t.app.inject({ method: 'GET', url: '/v1/org', headers: { authorization: 'Basic abc' } })).code).toBe('unauthorized');
  });

  it('cannot be used for dashboard-only endpoints', async () => {
    const { key } = await createKey(owner.caller);
    expect(json(await keyCaller(t, key).request('GET', '/v1/me')).code).toBe('forbidden_key_type');
  });

  it('validates key settings', async () => {
    const noOrigins = await owner.caller.request('POST', '/v1/api-keys', { name: 'web', type: 'public' });
    expect(json(noOrigins).details.issues[0].path).toBe('allowedOrigins');
    const restrictedPrivate = await owner.caller.request('POST', '/v1/api-keys', { name: 'x', type: 'private', allowedOrigins: ['https://a.example'] });
    expect(restrictedPrivate.statusCode).toBe(400);
    const badOrigin = await owner.caller.request('POST', '/v1/api-keys', { name: 'x', type: 'public', allowedOrigins: ['http://insecure.example'] });
    expect(badOrigin.statusCode).toBe(400);
    const pastExpiry = await owner.caller.request('POST', '/v1/api-keys', { name: 'x', type: 'private', expiresAt: '2020-01-01T00:00:00Z' });
    expect(pastExpiry.statusCode).toBe(400);
  });
});

describe('public API keys', () => {
  const allowed = randomUUID();
  const other = randomUUID();
  let publicKey: string;
  let revocableId: string;

  beforeAll(async () => {
    const created = await createKey(owner.caller, { name: 'Website widget', type: 'public', allowedOrigins: ['https://shop.example.com'], allowedAssistantIds: [allowed] });
    publicKey = created.key;
    revocableId = created.id;
    expect(publicKey).toMatch(/^pk_/);
  });

  it('starts web calls from an allowed origin for an allowed assistant', async () => {
    const res = await keyCaller(t, publicKey, 'pk', 'https://shop.example.com').request('POST', '/v1/test/web-calls', { assistantId: allowed });
    expect(res.statusCode).toBe(201);
    expect(json(res).orgId).toBe(owner.orgId);
  });

  it('is refused from other origins or without an origin', async () => {
    for (const origin of ['https://evil.example', 'https://shop.example.com.evil.example', undefined]) {
      const res = await keyCaller(t, publicKey, 'pk', origin).request('POST', '/v1/test/web-calls', { assistantId: allowed });
      expect(res.statusCode).toBe(403);
      expect(json(res).code).toBe('origin_not_allowed');
    }
  });

  it('is refused for assistants outside its list', async () => {
    const res = await keyCaller(t, publicKey, 'pk', 'https://shop.example.com').request('POST', '/v1/test/web-calls', { assistantId: other });
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('forbidden');
  });

  it('cannot read or manage anything (server endpoints refuse public keys)', async () => {
    const pk = keyCaller(t, publicKey, 'pk', 'https://shop.example.com');
    for (const [method, url] of [['GET', '/v1/org'], ['GET', '/v1/api-keys'], ['POST', '/v1/api-keys'], ['GET', '/v1/credentials'], ['GET', '/v1/members']] as const) {
      const res = await pk.request(method, url, method === 'POST' ? { name: 'x', type: 'private' } : undefined);
      expect(res.statusCode).toBe(403);
      expect(json(res).code).toBe('forbidden_key_type');
    }
  });

  it('stops working when revoked', async () => {
    await owner.caller.request('DELETE', `/v1/api-keys/${revocableId}`);
    const res = await keyCaller(t, publicKey, 'pk', 'https://shop.example.com').request('POST', '/v1/test/web-calls', { assistantId: allowed });
    expect(res.statusCode).toBe(401);
  });
});

describe('API conventions', () => {
  it('returns {code, message, details} for every error, with a request id', async () => {
    const missing = await owner.caller.request('GET', '/v1/nope');
    expect(missing.statusCode).toBe(404);
    expect(json(missing)).toEqual({ code: 'not_found', message: 'Route not found', details: {} });
    expect(missing.headers['x-request-id']).toBeTruthy();

    const badJson = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expect(badJson.statusCode).toBe(400);
    expect(Object.keys(json(badJson)).sort()).toEqual(['code', 'details', 'message']);

    const badId = await owner.caller.request('GET', '/v1/api-keys/not-a-uuid');
    expect(json(badId).code).toBe('not_found');
  });

  it('paginates with limit + cursor, without gaps or duplicates', async () => {
    const fresh = await signUp(t);
    // Same-millisecond inserts: the cursor must keep microsecond precision
    await fresh.caller.request('GET', '/v1/org');
    for (let i = 0; i < 23; i++) await createKey(fresh.caller, { name: `key-${i}`, type: 'private' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await fresh.caller.request('GET', `/v1/api-keys?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      const page = json(res);
      seen.push(...page.data.map((k: { id: string }) => k.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);

    expect(json(await fresh.caller.request('GET', '/v1/api-keys?cursor=garbage')).code).toBe('validation_error');
    expect((await fresh.caller.request('GET', '/v1/api-keys?limit=1000')).statusCode).toBe(400);
  });

  it('replays the original response for a repeated Idempotency-Key', async () => {
    const { key } = await createKey(owner.caller);
    const server = keyCaller(t, key);
    const assistantId = randomUUID();
    const runsBefore = handlerRuns;
    const first = await server.request('POST', '/v1/test/web-calls', { assistantId }, { 'idempotency-key': 'call-123' });
    const second = await server.request('POST', '/v1/test/web-calls', { assistantId }, { 'idempotency-key': 'call-123' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(json(second)).toEqual(json(first));
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(handlerRuns - runsBefore).toBe(1);

    const reused = await server.request('POST', '/v1/test/web-calls', { assistantId: randomUUID() }, { 'idempotency-key': 'call-123' });
    expect(reused.statusCode).toBe(422);
    expect(json(reused).code).toBe('idempotency_key_reused');

    const noKey1 = json(await server.request('POST', '/v1/test/web-calls', { assistantId }));
    const noKey2 = json(await server.request('POST', '/v1/test/web-calls', { assistantId }));
    expect(noKey1.callId).not.toBe(noKey2.callId);
  });

  it('does not store failures (5xx), so the client can retry with the same key', async () => {
    const { key } = await createKey(owner.caller);
    const server = keyCaller(t, key);
    const assistantId = randomUUID();
    const failed = await server.request('POST', '/v1/test/web-calls', { assistantId, fail: true }, { 'idempotency-key': 'retry-me' });
    expect(failed.statusCode).toBe(500);
    const rows = await t.db.query('SELECT 1 FROM idempotency_key WHERE key = $1', ['retry-me']);
    expect(rows.rowCount).toBe(0);
  });

  it('scopes idempotency keys per org', async () => {
    const other = await signUp(t);
    const a = keyCaller(t, (await createKey(owner.caller)).key);
    const b = keyCaller(t, (await createKey(other.caller)).key);
    const assistantId = randomUUID();
    const ra = json(await a.request('POST', '/v1/test/web-calls', { assistantId }, { 'idempotency-key': 'shared-key' }));
    const rb = json(await b.request('POST', '/v1/test/web-calls', { assistantId }, { 'idempotency-key': 'shared-key' }));
    expect(ra.orgId).toBe(owner.orgId);
    expect(rb.orgId).toBe(other.orgId);
    expect(ra.callId).not.toBe(rb.callId);
  });
});
