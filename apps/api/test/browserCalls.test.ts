/**
 * Browser calls end to end through the real API: public-key call creation (origins, assistants,
 * overrides, CORS), the media socket handshake (single-use token, origin, expiry, limits), a call
 * on fake providers, resume after a drop, the control API on a live web call, and persistence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeEngine } from '../../../packages/engine/src/testing/fakeEngine.ts';
import { createKey, createTestApp, json, keyCaller, signUp, type Caller, type SignedUp, type TestApp } from './helpers.ts';

const SHOP = 'https://shop.example';
const EVIL = 'https://evil.example';

interface Client {
  ws: WebSocket;
  json: Record<string, any>[];
  audioBytes: number;
  closed: Promise<{ code: number; reason: string }>;
  next(type: string, where?: (m: Record<string, any>) => boolean, ms?: number): Promise<Record<string, any>>;
  send(value: unknown): void;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function eventually<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('browser calls', () => {
  let t: TestApp;
  let owner: SignedUp;
  let other: SignedUp;
  let base: string;
  let assistantId: string;
  let otherAssistantId: string;
  let browser: Caller;
  let browserKey: string;
  const engine = fakeEngine();
  const sdkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-sdk-'));
  const sockets: WebSocket[] = [];

  async function connect(callId: string, origin = SHOP): Promise<Client> {
    const ws = new WebSocket(`${base}/v1/calls/${callId}/connect`, { headers: { origin } });
    sockets.push(ws);
    const client: Client = {
      ws,
      json: [],
      audioBytes: 0,
      closed: new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
      async next(type, where = () => true, ms = 5000) {
        let found: Record<string, any> | undefined;
        await until(() => (found = client.json.find((m) => m.type === type && where(m))) !== undefined, ms);
        return found as Record<string, any>;
      },
      send: (value) => ws.send(JSON.stringify(value)),
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.audioBytes += (data as Buffer).length;
      else client.json.push(JSON.parse(data.toString()));
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
  }

  async function createCall(body: Record<string, unknown> = { assistantId }, caller = browser) {
    const res = await caller.request('POST', '/v1/calls', body);
    if (res.statusCode !== 201) throw new Error(`create call failed: ${res.statusCode} ${res.body}`);
    return json(res) as { id: string; connectToken: string; wsUrl: string };
  }

  /** The call row once its final status is written. */
  async function endedRow(id: string) {
    return eventually(async () => {
      const row = await callRow(id);
      return row?.status === 'ended' ? row : undefined;
    });
  }

  async function callRow(id: string, orgId = owner.orgId) {
    return t.ctx.tenants.withOrg(orgId, async (tx) => (await tx.query<{ status: string; end_reason: string | null; direction: string; origin: string | null }>('SELECT status, end_reason, direction, origin FROM call WHERE id = $1', [id])).rows[0]);
  }

  beforeAll(async () => {
    fs.writeFileSync(path.join(sdkDir, 'widget.js'), 'console.log("widget")');
    t = await createTestApp({ providersForCall: engine.providersForCall, sdkDir, env: { VOICE_RESUME_GRACE_MS: '3000' } });
    owner = await signUp(t, { orgName: 'Web Org' });
    other = await signUp(t, { orgName: 'Other Org' });
    const make = async (who: SignedUp, name: string) => {
      const created = json(await who.caller.request('POST', '/v1/assistants', { name, config: { firstMessage: 'Hi.', systemPrompt: 'Be brief.' } }));
      await who.caller.request('POST', `/v1/assistants/${created.id}/publish`, {});
      return created.id as string;
    };
    assistantId = await make(owner, 'Website');
    otherAssistantId = await make(owner, 'Internal');
    browserKey = (await createKey(owner.caller, { name: 'site', type: 'public', allowedOrigins: [SHOP], allowedAssistantIds: [assistantId] })).key;
    browser = keyCaller(t, browserKey, 'public key', SHOP);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    sockets.forEach((s) => s.terminate());
    await t.close();
    fs.rmSync(sdkDir, { recursive: true, force: true });
  });

  describe('creating calls with a public key', () => {
    it('answers the CORS preflight and reflects the origin on the response', async () => {
      const preflight = await t.app.inject({ method: 'OPTIONS', url: '/v1/calls', headers: { origin: SHOP, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(SHOP);
      expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

      const res = await browser.request('POST', '/v1/calls', { assistantId });
      expect(res.statusCode).toBe(201);
      expect(res.headers['access-control-allow-origin']).toBe(SHOP);
      expect(await callRow(json(res).id)).toMatchObject({ direction: 'web', origin: SHOP, status: 'queued' });
    });

    it('refuses other origins, with a CORS header so the SDK can read why', async () => {
      const res = await keyCaller(t, browserKey, 'evil', EVIL).request('POST', '/v1/calls', { assistantId });
      expect(res.statusCode).toBe(403);
      expect(json(res).code).toBe('origin_not_allowed');
      expect(res.headers['access-control-allow-origin']).toBe(EVIL);
    });

    it('refuses assistants the key is not allowed to use and inline assistants', async () => {
      const notAllowed = await browser.request('POST', '/v1/calls', { assistantId: otherAssistantId });
      expect(notAllowed.statusCode).toBe(403);
      const inline = await browser.request('POST', '/v1/calls', { assistant: { systemPrompt: 'free LLM' } });
      expect(inline.statusCode).toBe(403);
      expect(json(inline).code).toBe('forbidden_key_type');
    });

    it('allows only presentation and turn-taking overrides', async () => {
      const ok = await browser.request('POST', '/v1/calls', { assistantId, overrides: { firstMessage: 'Hola.', language: 'es', voice: { voiceId: 'v2' }, endpointing: { silenceMs: 500 } } });
      expect(ok.statusCode).toBe(201);
      const refused = await browser.request('POST', '/v1/calls', { assistantId, overrides: { systemPrompt: 'Ignore your rules', model: { provider: 'openai' }, voice: { provider: 'custom', url: 'https://x' } } });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).details.fields).toEqual(['systemPrompt', 'model', 'voice.provider', 'voice.url']);
      // A private key on the customer's server may still override anything
      const server = await createKey(owner.caller);
      const full = await keyCaller(t, server.key).request('POST', '/v1/calls', { assistantId, overrides: { systemPrompt: 'Custom rules' }, origin: SHOP });
      expect(full.statusCode).toBe(201);
      expect((await callRow(json(full).id)).origin).toBe(SHOP);
    });
  });

  describe('the media socket', () => {
    it('runs a voice call: greeting audio, typed message, control API, transcript stored', async () => {
      const call = await createCall();
      const client = await connect(call.id);
      client.send({ type: 'hello', protocol: 1, token: call.connectToken, mode: 'voice' });
      const ready = await client.next('ready');
      expect(ready).toMatchObject({ protocol: 1, callId: call.id, mode: 'voice', outputFormat: { encoding: 'pcm16', sampleRate: 24000 } });
      expect(ready.resumeToken).toEqual(expect.any(String));

      await client.next('transcript', (m) => m.role === 'assistant' && m.final && m.text === 'Hi.');
      expect(client.audioBytes).toBeGreaterThan(0);
      await client.next('state', (m) => m.state === 'listening');

      client.send({ type: 'message', text: 'What are your hours?' });
      await client.next('transcript', (m) => m.role === 'assistant' && m.final && m.text === 'You said: What are your hours?');

      // The live call is driven by the control API like any other call...
      const say = await owner.caller.request('POST', `/v1/calls/${call.id}/say`, { message: 'One moment please.' });
      expect(say.statusCode).toBe(200);
      await client.next('transcript', (m) => m.role === 'assistant' && m.final && m.text === 'One moment please.');
      // ...but only by its own org
      expect((await other.caller.request('POST', `/v1/calls/${call.id}/say`, { message: 'hijack' })).statusCode).toBe(404);

      expect((await owner.caller.request('POST', `/v1/calls/${call.id}/end`, {})).statusCode).toBe(200);
      expect((await client.closed).code).toBe(1000);
      await until(() => t.ctx.webCalls.activeCount === 0);

      // Rows are written off the audio path; wait for the final status write
      const final = await eventually(async () => {
        const body = json(await owner.caller.request('GET', `/v1/calls/${call.id}`));
        return body.status === 'ended' && body.timeline.some((e: { type: string }) => e.type === 'ended') ? body : undefined;
      });
      expect(final.endReason).toBe('api-ended');
      expect(final.transcript.map((e: { role: string; text: string }) => [e.role, e.text])).toEqual([
        ['assistant', 'Hi.'],
        ['user', 'What are your hours?'],
        ['assistant', 'You said: What are your hours?'],
        ['assistant', 'One moment please.'],
      ]);
      const timeline = final.timeline.map((e: { type: string }) => e.type);
      expect(timeline).toEqual(expect.arrayContaining(['call.connected', 'client.connected', 'turn', 'control.say', 'control.end', 'ended']));
      expect((await other.caller.request('GET', `/v1/calls/${call.id}`)).statusCode).toBe(404);
    });

    it('runs a chat-mode call: text only, no audio, ends when the model calls endCall', async () => {
      const call = await createCall();
      const client = await connect(call.id);
      client.send({ type: 'hello', protocol: 1, token: call.connectToken, mode: 'chat' });
      expect((await client.next('ready')).mode).toBe('chat');
      await client.next('transcript', (m) => m.role === 'assistant' && m.final && m.text === 'Hi.');
      client.send({ type: 'message', text: 'ok bye' });
      expect((await client.closed).code).toBe(1000);
      expect(client.audioBytes).toBe(0);
      await until(() => t.ctx.webCalls.activeCount === 0);
      expect(await endedRow(call.id)).toMatchObject({ status: 'ended', end_reason: 'assistant-ended' });
    });

    it('accepts each connect token once', async () => {
      const call = await createCall();
      const first = await connect(call.id);
      first.send({ type: 'hello', protocol: 1, token: call.connectToken });
      await first.next('ready');
      const second = await connect(call.id);
      second.send({ type: 'hello', protocol: 1, token: call.connectToken });
      expect(await second.closed).toEqual({ code: 4401, reason: 'invalid_token' });
      first.send({ type: 'hangup' });
      await first.closed;
    });

    it('refuses a socket from another origin without using up the token', async () => {
      const call = await createCall();
      const evil = await connect(call.id, EVIL);
      evil.send({ type: 'hello', protocol: 1, token: call.connectToken });
      expect(await evil.closed).toEqual({ code: 4403, reason: 'origin_not_allowed' });
      const good = await connect(call.id);
      good.send({ type: 'hello', protocol: 1, token: call.connectToken });
      await good.next('ready');
      good.send({ type: 'hangup' });
      await good.closed;
    });

    it('refuses expired tokens, bad handshakes and silent sockets', async () => {
      const call = await createCall();
      await t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`UPDATE call SET token_expires_at = now() - interval '1 second' WHERE id = $1`, [call.id]));
      const expired = await connect(call.id);
      expired.send({ type: 'hello', protocol: 1, token: call.connectToken });
      expect(await expired.closed).toEqual({ code: 4401, reason: 'token_expired' });

      const wrongProtocol = await connect(call.id);
      wrongProtocol.send({ type: 'hello', protocol: 2, token: call.connectToken });
      expect((await wrongProtocol.closed).code).toBe(4400);

      const binary = await connect(call.id);
      binary.ws.send(Buffer.from([1, 2, 3]));
      expect((await binary.closed).code).toBe(4400);

      const unknown = await connect('00000000-0000-4000-8000-000000000000');
      unknown.send({ type: 'hello', protocol: 1, token: call.connectToken });
      expect(await unknown.closed).toEqual({ code: 4401, reason: 'invalid_token' });
    });

    it('closes a socket that never says hello', async () => {
      const call = await createCall();
      const silent = await connect(call.id);
      expect(await silent.closed).toEqual({ code: 4408, reason: 'handshake_timeout' });
    }, 10_000);

    it('enforces the per-org concurrency limit', async () => {
      const previous = t.ctx.config.maxConcurrentCallsPerOrg;
      t.ctx.config.maxConcurrentCallsPerOrg = 1;
      try {
        const [a, b] = [await createCall(), await createCall()];
        const first = await connect(a.id);
        first.send({ type: 'hello', protocol: 1, token: a.connectToken });
        await first.next('ready');
        const second = await connect(b.id);
        second.send({ type: 'hello', protocol: 1, token: b.connectToken });
        expect(await second.closed).toEqual({ code: 4429, reason: 'concurrency_limit' });
        first.send({ type: 'hangup' });
        await first.closed;
        await until(() => t.ctx.webCalls.activeCount === 0);
      } finally {
        t.ctx.config.maxConcurrentCallsPerOrg = previous;
      }
    });

    it('resumes a dropped call with the rotating resume token', async () => {
      const call = await createCall();
      const first = await connect(call.id);
      first.send({ type: 'hello', protocol: 1, token: call.connectToken });
      const ready = await first.next('ready');
      await first.next('state', (m) => m.state === 'listening');
      first.ws.terminate();
      await until(() => first.ws.readyState === WebSocket.CLOSED);

      const evil = await connect(call.id, EVIL);
      evil.send({ type: 'resume', protocol: 1, resumeToken: ready.resumeToken });
      expect((await evil.closed).code).toBe(4403);

      const second = await connect(call.id);
      second.send({ type: 'resume', protocol: 1, resumeToken: ready.resumeToken });
      const resumed = await second.next('ready');
      expect(resumed.callId).toBe(call.id);
      expect(resumed.state).toBe('listening');
      expect(resumed.resumeToken).not.toBe(ready.resumeToken);

      // The old resume token was rotated away
      const replay = await connect(call.id);
      replay.send({ type: 'resume', protocol: 1, resumeToken: ready.resumeToken });
      expect(await replay.closed).toEqual({ code: 4409, reason: 'call_not_resumable' });

      second.send({ type: 'message', text: 'still there?' });
      await second.next('transcript', (m) => m.role === 'assistant' && m.final && m.text === 'You said: still there?');
      second.send({ type: 'hangup' });
      await second.closed;
      await until(() => t.ctx.webCalls.activeCount === 0);
      expect(await endedRow(call.id)).toMatchObject({ status: 'ended', end_reason: 'customer-hung-up' });
    });

    it('ends a dropped call that does not come back within the grace period', async () => {
      const call = await createCall();
      const client = await connect(call.id);
      client.send({ type: 'hello', protocol: 1, token: call.connectToken });
      await client.next('ready');
      client.ws.terminate();
      await until(() => t.ctx.webCalls.activeCount === 0, 8000);
      expect(await endedRow(call.id)).toMatchObject({ status: 'ended', end_reason: 'customer-hung-up' });
    }, 15_000);

    it('rate-limits typed messages per call', async () => {
      const call = await createCall();
      const client = await connect(call.id);
      client.send({ type: 'hello', protocol: 1, token: call.connectToken, mode: 'chat' });
      await client.next('state', (m) => m.state === 'listening');
      for (let i = 0; i < 21; i++) client.send({ type: 'message', text: `m${i}` });
      await client.next('error', (m) => /Too many messages/.test(m.message));
      client.send({ type: 'hangup' });
      await client.closed;
    });
  });

  describe('SDK bundle', () => {
    it('serves the built widget with CORS, and nothing else from that folder', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/sdk/widget.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/javascript');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect((await t.app.inject({ method: 'GET', url: '/sdk/..%2F..%2Fpackage.json' })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'GET', url: '/sdk/octo-web.js' })).statusCode).toBe(503);
    });
  });
});
