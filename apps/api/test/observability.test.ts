/**
 * Observability: readiness and Prometheus metrics (ops), boards, scorecards, monitoring policies with
 * one evaluate-and-notify cycle of the monitoring worker, and the per-call debug view. Every org
 * route is checked for cross-org isolation (404 for foreign ids, lists without foreign rows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../src/auth/crypto.ts';
import { appendTranscript } from '../src/services/analysis/transcript.ts';
import { addMember, createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

const HOUR = 3_600_000;
const METRICS_TOKEN = 'metrics-token-for-tests-0123456789';

let t: TestApp;
let A: SignedUp;
let B: SignedUp;
let assistantA: string;
let assistantB: string;

async function assistant(who: SignedUp, name: string): Promise<string> {
  const res = await who.caller.request('POST', '/v1/assistants', { name, config: { firstMessage: 'Hello.', systemPrompt: 'Be brief.' } });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).id;
}

/** An ended web call created `ageMs` ago, with an optional pass-fail verdict and one voice turn. */
async function call(who: SignedUp, assistantId: string, options: { ageMs?: number; endReason?: string; passed?: boolean; voiceToVoiceMs?: number; transcript?: string } = {}): Promise<string> {
  const id = newId();
  const created = new Date(t.monitoringClock.now - (options.ageMs ?? HOUR));
  await t.ctx.tenants.withOrg(who.orgId, async (tx) => {
    await tx.query(
      `INSERT INTO call (id, org_id, type, assistant_id, config_source, assistant_name, config, config_schema, status, created_by_type, direction, started_at, ended_at, duration_ms, end_reason, created_at)
       VALUES ($1, $2, 'web', $3, 'draft', 'Agent', '{}'::jsonb, 1, 'ended', 'user', 'web', $4::timestamptz, $4::timestamptz + interval '60 seconds', 60000, $5, $4::timestamptz)`,
      [id, who.orgId, assistantId, created.toISOString(), options.endReason ?? 'customer-ended-call']
    );
    if (options.passed !== undefined) {
      await tx.query(`INSERT INTO call_analysis (id, org_id, call_id, status, success_rubric, success_passed) VALUES ($1, $2, $3, 'succeeded', 'pass-fail', $4)`, [newId(), who.orgId, id, options.passed]);
    }
    if (options.voiceToVoiceMs !== undefined) {
      await tx.query(`INSERT INTO call_event (id, org_id, call_id, type, payload, created_at) VALUES ($1, $2, $3, 'turn', $4::jsonb, $5::timestamptz)`, [
        newId(),
        who.orgId,
        id,
        JSON.stringify({ index: 1, kind: 'reply', interrupted: false, latency: { voiceToVoiceMs: options.voiceToVoiceMs } }),
        created.toISOString(),
      ]);
    }
    if (options.transcript) await appendTranscript(tx, who.orgId, id, { kind: 'speech', role: 'user', text: options.transcript, startedAt: created, endedAt: new Date(created.getTime() + 2000) });
  });
  return id;
}

beforeAll(async () => {
  t = await createTestApp({ env: { METRICS_TOKEN } });
  A = await signUp(t, { orgName: 'Observed A' });
  B = await signUp(t, { orgName: 'Observed B' });
  assistantA = await assistant(A, 'A agent');
  assistantB = await assistant(B, 'B agent');
}, 60_000);
afterAll(async () => t.close());

describe('readiness and metrics', () => {
  it('/ready answers 200 with its checks when the database answers and there is capacity', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ ok: true, checks: { database: 'ok', capacity: 'ok' }, liveSessions: 0, maxSessions: 50 });
    expect(json(res).uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('/ready answers 503 while the database does not answer', async () => {
    const original = t.ctx.db.query;
    t.ctx.db.query = (async () => {
      throw new Error('connection refused');
    }) as typeof original;
    try {
      const res = await t.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ ok: false, checks: { database: 'failed' } });
    } finally {
      t.ctx.db.query = original;
    }
  });

  it('/ready answers 503 while the node is at VOICE_MAX_SESSIONS', async () => {
    Object.defineProperty(t.ctx.webCalls, 'activeCount', { configurable: true, get: () => 50 });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ ok: false, checks: { database: 'ok', capacity: 'full' }, liveSessions: 50 });
    } finally {
      delete (t.ctx.webCalls as unknown as Record<string, unknown>).activeCount;
    }
    expect((await t.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('/metrics needs the metrics token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } })).statusCode).toBe(401);
    // A session or an API key is not a metrics token
    expect((await t.app.inject({ method: 'GET', url: '/metrics', headers: { cookie: A.cookie } })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('octo_build_info');
    expect(res.body).toContain('octo_queue_depth');
    // Bounded labels only: no org or call ids
    expect(res.body).not.toContain(A.orgId);
  });

  it('/metrics does not exist without a configured token', async () => {
    const token = t.ctx.config.metricsToken;
    t.ctx.config.metricsToken = undefined;
    try {
      const res = await t.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      expect(res.statusCode).toBe(404);
      expect(json(res).code).toBe('not_found');
    } finally {
      t.ctx.config.metricsToken = token;
    }
  });
});

describe('boards', () => {
  beforeAll(async () => {
    await call(A, assistantA, { passed: true, voiceToVoiceMs: 900 });
    await call(A, assistantA, { passed: false, voiceToVoiceMs: 1100 });
    await call(A, assistantA, { endReason: 'error-llm-failed' });
    // Outside the default 7-day range
    await call(A, assistantA, { ageMs: 10 * 24 * HOUR });
    await call(B, assistantB, { passed: true });
  });

  it('the overview counts only the org own calls in range', async () => {
    const res = await A.caller.request('GET', '/v1/boards/overview');
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body.calls).toEqual({ total: 3, finished: 3, errored: 1 });
    expect(body.errorRatePercent).toBe(33.33);
    expect(body.success).toMatchObject({ evaluated: 2, passed: 1, ratePercent: 50 });
    expect(body.latency.voiceToVoiceMs).toMatchObject({ samples: 2, p50: 1000 });
    expect(body.endReasons).toEqual(expect.arrayContaining([{ reason: 'error-llm-failed', count: 1 }]));
    expect(json(await B.caller.request('GET', '/v1/boards/overview')).calls.total).toBe(1);
  });

  it('series has one bucket per interval, and filters by assistant', async () => {
    const res = await A.caller.request('GET', `/v1/boards/series?interval=day&assistantId=${assistantA}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body.interval).toBe('day');
    expect(body.buckets.length).toBeGreaterThanOrEqual(7);
    expect(body.buckets.reduce((sum: number, b: { calls: number }) => sum + b.calls, 0)).toBe(3);
    // Another org's assistant matches none of this org's calls
    expect(json(await A.caller.request('GET', `/v1/boards/overview?assistantId=${assistantB}`)).calls.total).toBe(0);
  });

  it('refuses a reversed range or unknown filters', async () => {
    const reversed = await A.caller.request('GET', '/v1/boards/overview?from=2026-10-05&to=2026-10-01');
    expect(reversed.statusCode).toBe(400);
    expect(json(reversed).details.issues[0].path).toBe('from');
    expect((await A.caller.request('GET', '/v1/boards/overview?orgId=x')).statusCode).toBe(400);
  });
});

describe('scorecards', () => {
  const passRate = { name: 'Pass rate', spec: { source: { type: 'success', property: 'passed' }, aggregate: 'rate' } };

  it('create, read, value, series, update and delete', async () => {
    const created = await A.caller.request('POST', '/v1/scorecards', passRate);
    expect(created.statusCode, created.body).toBe(201);
    const card = json(created);
    expect(card).toMatchObject({ name: 'Pass rate', description: '' });

    const value = json(await A.caller.request('GET', `/v1/scorecards/${card.id}/value`));
    expect(value).toMatchObject({ scorecardId: card.id, value: 50, sample: 2, unit: 'percent' });
    const series = json(await A.caller.request('GET', `/v1/scorecards/${card.id}/series?interval=day`));
    expect(series.points.length).toBeGreaterThanOrEqual(7);

    const patched = await A.caller.request('PATCH', `/v1/scorecards/${card.id}`, { description: 'Calls that passed' });
    expect(json(patched).description).toBe('Calls that passed');
    expect(json(await A.caller.request('GET', '/v1/scorecards')).data.map((s: { id: string }) => s.id)).toContain(card.id);

    expect((await A.caller.request('DELETE', `/v1/scorecards/${card.id}`)).statusCode).toBe(204);
    expect((await A.caller.request('GET', `/v1/scorecards/${card.id}`)).statusCode).toBe(404);
  });

  it('validates the spec and keeps names unique per org', async () => {
    const noEquals = await A.caller.request('POST', '/v1/scorecards', { name: 'Booked', spec: { source: { type: 'output', field: 'booked' }, aggregate: 'rate' } });
    expect(noEquals.statusCode).toBe(400);
    expect(json(noEquals).details.issues[0].path).toBe('spec.equals');
    const foreign = await A.caller.request('POST', '/v1/scorecards', { name: 'Foreign', spec: { ...passRate.spec, filters: { assistantId: assistantB } } });
    expect(foreign.statusCode).toBe(400);
    expect(json(foreign).details.issues[0].path).toBe('spec.filters.assistantId');

    expect((await A.caller.request('POST', '/v1/scorecards', { ...passRate, name: 'Unique' })).statusCode).toBe(201);
    const twice = await A.caller.request('POST', '/v1/scorecards', { ...passRate, name: 'unique' });
    expect(twice.statusCode).toBe(409);
    // Another org may use the same name
    expect((await B.caller.request('POST', '/v1/scorecards', { ...passRate, name: 'Unique' })).statusCode).toBe(201);
  });
});

describe('monitoring policies', () => {
  it('a breaching policy fires once, emails the admins, and shows in the alert history', async () => {
    const created = await A.caller.request('POST', '/v1/alert-policies', { name: 'Errors', metric: 'error_rate', comparison: 'gt', threshold: 20, windowMinutes: 180, minSamples: 1 });
    expect(created.statusCode, created.body).toBe(201);
    const policy = json(created);
    expect(policy).toMatchObject({ unit: 'percent', notify: { email: true, userIds: [], webhookEndpointId: null }, status: { state: 'unknown' } });

    const dryRun = json(await A.caller.request('POST', `/v1/alert-policies/${policy.id}/test`));
    expect(dryRun).toMatchObject({ status: 'breach', value: 33.33, sample: 3 });
    // A dry run records nothing
    expect(json(await A.caller.request('GET', `/v1/alert-policies/${policy.id}`)).status.state).toBe('unknown');

    const sent = t.outbox.sent.length;
    const tick = await t.ctx.monitoring.tick();
    expect(tick.fired).toBe(1);
    expect(t.outbox.sent.length).toBe(sent + 1);
    expect(t.outbox.last(A.email)?.text).toContain(`/monitoring/policies/${policy.id}`);
    expect(json(await A.caller.request('GET', `/v1/alert-policies/${policy.id}`)).status.state).toBe('firing');

    // Still breaching: no second alert before renotifyMinutes
    expect((await t.ctx.monitoring.tick()).fired).toBe(0);

    const events = json(await A.caller.request('GET', `/v1/alert-events?policyId=${policy.id}`)).data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'fired', policyName: 'Errors', rule: { metric: 'error_rate', comparison: 'gt', threshold: 20 }, notifications: [{ channel: 'email', target: A.email, status: 'sent' }] });
    expect(json(await A.caller.request('GET', '/v1/alert-policies?state=firing')).data.map((p: { id: string }) => p.id)).toEqual([policy.id]);

    expect((await A.caller.request('PATCH', `/v1/alert-policies/${policy.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await A.caller.request('DELETE', `/v1/alert-policies/${policy.id}`)).statusCode).toBe(204);
  });

  it('validates rules and references', async () => {
    const rate = await A.caller.request('POST', '/v1/alert-policies', { name: 'Bad rate', metric: 'success_rate', comparison: 'lt', threshold: 150, windowMinutes: 60 });
    expect(json(rate).details.issues[0].path).toBe('threshold');
    const scorecardless = await A.caller.request('POST', '/v1/alert-policies', { name: 'No card', metric: 'scorecard', comparison: 'lt', threshold: 1, windowMinutes: 60 });
    expect(json(scorecardless).details.issues[0].path).toBe('scorecardId');
    const silent = await A.caller.request('POST', '/v1/alert-policies', { name: 'Silent', metric: 'call_count', comparison: 'gt', threshold: 1, windowMinutes: 60, notify: { email: false } });
    expect(json(silent).details.issues[0].path).toBe('notify');
    const foreign = await A.caller.request('POST', '/v1/alert-policies', { name: 'Foreign', metric: 'call_count', comparison: 'gt', threshold: 1, windowMinutes: 60, assistantId: assistantB, notify: { userIds: [B.userId] } });
    expect(foreign.statusCode).toBe(400);
    expect(json(foreign).details.issues.map((i: { path: string }) => i.path)).toEqual(['assistantId', 'notify.userIds.0']);
  });

  it('members and viewers read monitoring; only admins and owners define it', async () => {
    const viewer = await addMember(t, A, 'viewer');
    const member = await addMember(t, A, 'member');
    expect((await viewer.caller.request('GET', '/v1/alert-policies')).statusCode).toBe(200);
    expect((await viewer.caller.request('GET', '/v1/scorecards')).statusCode).toBe(200);
    expect((await viewer.caller.request('GET', '/v1/boards/overview')).statusCode).toBe(200);
    for (const who of [viewer, member]) {
      const res = await who.caller.request('POST', '/v1/alert-policies', { name: 'Not mine', metric: 'call_count', comparison: 'gt', threshold: 1, windowMinutes: 60 });
      expect(res.statusCode).toBe(403);
      expect(json(res).details.permission).toBe('monitoring:manage');
      expect((await who.caller.request('POST', '/v1/scorecards', { name: 'Not mine', spec: { source: { type: 'success', property: 'passed' }, aggregate: 'rate' } })).statusCode).toBe(403);
    }
  });
});

describe('per-call debug view', () => {
  it('returns the timeline with transcript lines and turn latency', async () => {
    const id = await call(A, assistantA, { voiceToVoiceMs: 1200, transcript: 'I need an appointment' });
    const res = await A.caller.request('GET', `/v1/calls/${id}/debug`);
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body.call).toMatchObject({ id, assistantId: assistantA, captureLlm: false });
    expect(body.turns).toEqual([{ index: 1, kind: 'reply', interrupted: false, latency: { voiceToVoiceMs: 1200 } }]);
    expect(body.timeline.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['turn', 'transcript']));
    expect(json(await A.caller.request('GET', `/v1/calls/${id}/debug?types=transcript`)).timeline).toHaveLength(1);
  });
});

describe('isolation', () => {
  let card: string;
  let policy: string;
  let callA: string;

  beforeAll(async () => {
    card = json(await A.caller.request('POST', '/v1/scorecards', { name: 'A only', spec: { source: { type: 'success', property: 'passed' }, aggregate: 'rate' } })).id;
    policy = json(await A.caller.request('POST', '/v1/alert-policies', { name: 'A only', metric: 'call_count', comparison: 'gt', threshold: 1000, windowMinutes: 60 })).id;
    callA = await call(A, assistantA, { transcript: 'private words' });
  });

  it.each([
    ['GET', () => `/v1/scorecards/${card}`],
    ['PATCH', () => `/v1/scorecards/${card}`],
    ['DELETE', () => `/v1/scorecards/${card}`],
    ['GET', () => `/v1/scorecards/${card}/value`],
    ['GET', () => `/v1/scorecards/${card}/series`],
    ['GET', () => `/v1/alert-policies/${policy}`],
    ['PATCH', () => `/v1/alert-policies/${policy}`],
    ['DELETE', () => `/v1/alert-policies/${policy}`],
    ['POST', () => `/v1/alert-policies/${policy}/test`],
    ['GET', () => `/v1/calls/${callA}/debug`],
  ] as const)("org B: %s on org A's resource is 404 and changes nothing", async (method, url) => {
    const before = await t.db.query('SELECT name, description, deleted_at FROM scorecard WHERE id = $1 UNION ALL SELECT name, metric, NULL FROM alert_policy WHERE id = $2', [card, policy]);
    const res = await B.caller.request(method, url(), method === 'PATCH' ? { name: 'taken over' } : undefined);
    expect(res.statusCode).toBe(404);
    expect(json(res).code).toBe('not_found');
    const after = await t.db.query('SELECT name, description, deleted_at FROM scorecard WHERE id = $1 UNION ALL SELECT name, metric, NULL FROM alert_policy WHERE id = $2', [card, policy]);
    expect(after.rows).toEqual(before.rows);
  });

  it("org B's lists and boards contain none of org A's data", async () => {
    for (const url of ['/v1/scorecards', '/v1/alert-policies', '/v1/alert-events', '/v1/boards/overview', '/v1/boards/series']) {
      const res = await B.caller.request('GET', url);
      expect(res.statusCode, url).toBe(200);
      for (const foreign of [card, policy, callA, A.orgId, assistantA, 'A only']) expect(res.body, url).not.toContain(foreign);
    }
  });

  it("org B cannot point a policy or scorecard at org A's scorecard or assistant", async () => {
    const res = await B.caller.request('POST', '/v1/alert-policies', { name: 'Steal', metric: 'scorecard', scorecardId: card, comparison: 'lt', threshold: 1, windowMinutes: 60 });
    expect(res.statusCode).toBe(400);
    expect(json(res).details.issues[0].path).toBe('scorecardId');
  });
});
