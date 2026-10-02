/**
 * Post-call analysis end to end on fake models: transcripts with timing and tool calls, the analysis
 * job (summary, success rubrics, structured outputs with validation and one corrective retry,
 * retries with backoff, crash recovery), reusable structured outputs, call filters on extracted
 * values, transcript search, usage records, the end-of-call-report webhook and its delivery.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HttpClient, HttpRequestInit } from '../../../packages/engine/src/providers/net.ts';
import type { LlmRequest } from '../../../packages/engine/src/providers/types.ts';
import { defaultFakeReply, fakeEngine } from '../../../packages/engine/src/testing/fakeEngine.ts';
import type { FakeLlmReply } from '../../../packages/engine/src/testing/fakes.ts';
import { newId } from '../src/auth/crypto.ts';
import { appendTranscript } from '../src/services/analysis/transcript.ts';
import { enqueueAnalysis } from '../src/services/analysis/worker.ts';
import { verifyWebhookSignature } from '../src/services/webhooks.ts';
import { addMember, createTestApp, DASHBOARD, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

const MINUTE = 60_000;

/** What the analysis model is asked, and what the fake answers. Reset in beforeEach. */
const script = {
  /** Replies per step name; a function sees the request and the 1-based number of this step's requests so far. */
  summary: (_r: LlmRequest, _n: number): string | FakeLlmReply => 'The caller asked to book an appointment for tomorrow; the assistant booked it.',
  success: (_r: LlmRequest, _n: number): string | FakeLlmReply => '{"passed": true, "reason": "Booked."}',
  output: (_r: LlmRequest, _n: number, _name: string): string | FakeLlmReply => '{"appointment_booked": true, "sentiment": "positive"}',
};
const seen: { step: string; request: LlmRequest }[] = [];
const counts: Record<string, number> = {};

function analysisReply(request: LlmRequest): string | FakeLlmReply {
  const task = String(request.messages.find((m) => m.role === 'user')?.content ?? '').split('</transcript>').at(-1) ?? '';
  const step = /Evaluate the call/.test(task) ? 'success' : /Extract the structured output "([^"]+)"/.test(task) ? `output:${/"([^"]+)"/.exec(task)![1]}` : 'summary';
  seen.push({ step, request });
  counts[step] = (counts[step] ?? 0) + 1;
  const n = counts[step];
  if (step === 'success') return script.success(request, n);
  if (step === 'summary') return script.summary(request, n);
  return script.output(request, n, step.slice('output:'.length));
}

const engine = fakeEngine({
  reply: (text, request) => (request.systemPrompt.startsWith('You analyse finished phone calls') ? analysisReply(request) : defaultFakeReply(text)),
});

const BOOKING_SCHEMA = {
  type: 'object',
  properties: { appointment_booked: { type: 'boolean' }, sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] }, score: { type: 'integer', minimum: 0, maximum: 10 } },
  required: ['appointment_booked', 'sentiment'],
  additionalProperties: false,
};

let t: TestApp;
let owner: SignedUp;
let other: SignedUp;
let http: { requests: { url: string; init: HttpRequestInit }[]; statuses: number[] };

const fakeHttp: HttpClient = async (url, init) => {
  http.requests.push({ url, init });
  const status = http.statuses.shift() ?? 200;
  return { status, ok: status >= 200 && status < 300, headers: {}, body: (async function* () {})(), text: async () => (status >= 400 ? 'receiver said no' : 'ok') };
};

async function assistant(who: SignedUp, analysis: Record<string, unknown>, name = `Agent ${newId().slice(0, 6)}`, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await who.caller.request('POST', '/v1/assistants', { name, config: { firstMessage: 'Hello.', systemPrompt: 'Be brief.', analysis, ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  const id = json(res).id as string;
  expect((await who.caller.request('POST', `/v1/assistants/${id}/publish`, {})).statusCode).toBe(201);
  return id;
}

async function structuredOutput(who: SignedUp, name: string, schema: object = BOOKING_SCHEMA, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await who.caller.request('POST', '/v1/structured-outputs', { name, schema, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).id as string;
}

type Line = { role: 'user' | 'assistant'; text: string } | { tool: string; args?: Record<string, unknown> };

/** An ended call with a stored transcript and a queued analysis job, as the voice path leaves it. */
async function endedCall(who: SignedUp, assistantId: string, lines: Line[] = defaultLines(), over: { endReason?: string; createdAt?: string } = {}): Promise<string> {
  const callId = newId();
  const started = new Date(Date.parse('2026-10-05T04:00:00Z'));
  await t.ctx.tenants.withOrg(who.orgId, async (tx) => {
    const a = (await tx.query<{ name: string; draft: object }>('SELECT name, draft FROM assistant WHERE id = $1', [assistantId])).rows[0];
    await tx.query(
      `INSERT INTO call (id, org_id, type, assistant_id, config_source, assistant_name, config, config_schema, status, created_by_type, direction, started_at, ended_at, duration_ms, end_reason, created_at)
       VALUES ($1, $2, 'web', $3, 'draft', $4, $5::jsonb, 1, 'ended', 'user', 'web', $6::timestamptz, $7::timestamptz, 90000, $8, $9::timestamptz)`,
      [callId, who.orgId, assistantId, a.name, JSON.stringify(a.draft), started.toISOString(), new Date(started.getTime() + 90_000).toISOString(), over.endReason ?? 'assistant-ended-call', over.createdAt ?? started.toISOString()]
    );
    let at = started.getTime();
    for (const line of lines) {
      if ('tool' in line) await appendTranscript(tx, who.orgId, callId, { kind: 'tool-call', name: line.tool, args: line.args ?? {}, at: new Date(at) });
      else await appendTranscript(tx, who.orgId, callId, { kind: 'speech', role: line.role, text: line.text, startedAt: new Date(at), endedAt: new Date((at += 4000)) });
      at += 1000;
    }
    await enqueueAnalysis(tx, who.orgId, callId, new Date(t.analysisClock.now));
  });
  return callId;
}

function defaultLines(): Line[] {
  return [
    { role: 'assistant', text: 'Hello, how can I help?' },
    { role: 'user', text: 'I would like to book an appointment for tomorrow morning.' },
    { tool: 'bookAppointment', args: { day: 'tomorrow', slot: 'morning' } },
    { role: 'assistant', text: 'Done, you are booked for 10 o clock.' },
  ];
}

const analysisOf = async (who: SignedUp, callId: string) => json(await who.caller.request('GET', `/v1/calls/${callId}/analysis`));
const tick = () => t.ctx.analysis.tick();
const rowOf = async (callId: string) => (await t.db.query<any>('SELECT * FROM call_analysis WHERE call_id = $1', [callId])).rows[0];
const usageRows = async (callId: string) => (await t.db.query<any>(`SELECT * FROM usage_record WHERE subject_id = $1 AND channel = 'analysis' ORDER BY created_at`, [callId])).rows;
const reports = async (orgId = owner.orgId) => (await t.db.query<{ id: string; payload: any; call_id: string; endpoint_id: string; status: string }>(`SELECT id, payload, call_id, endpoint_id, status FROM webhook_delivery WHERE org_id = $1 AND event_type = 'end-of-call-report' ORDER BY created_at`, [orgId])).rows;

beforeAll(async () => {
  t = await createTestApp({ modelForCall: engine.modelForCall, providersForCall: engine.providersForCall, webhookHttp: fakeHttp });
  owner = await signUp(t, { orgName: 'Analysis Org' });
  other = await signUp(t, { orgName: 'Other Analysis Org' });
}, 60_000);
afterAll(async () => t.close());

beforeEach(() => {
  seen.length = 0;
  for (const key of Object.keys(counts)) delete counts[key];
  script.summary = () => 'The caller asked to book an appointment for tomorrow; the assistant booked it.';
  script.success = () => '{"passed": true, "reason": "Booked."}';
  script.output = () => '{"appointment_booked": true, "sentiment": "positive"}';
  http = { requests: [], statuses: [] };
  t.analysisClock.now = Date.now();
  t.webhookClock.now = Date.now();
});
afterEach(async () => {
  // Nothing queued by one test is picked up by the next
  await t.db.query(`UPDATE call_analysis SET status = 'skipped', skip_reason = 'analysis-disabled', report_enqueued_at = coalesce(report_enqueued_at, now()) WHERE status IN ('pending', 'running')`);
  await t.db.query(`UPDATE webhook_delivery SET status = 'dead' WHERE status IN ('pending', 'failed', 'delivering')`);
});

// ---------------------------------------------------------------- structured output resource

describe('structured outputs', () => {
  it('creates, reads, lists, edits and soft-deletes a reusable definition', async () => {
    const created = await owner.caller.request('POST', '/v1/structured-outputs', { name: 'Booking', description: 'Did they book?', schema: BOOKING_SCHEMA, prompt: 'Only count confirmed bookings.' });
    expect(created.statusCode).toBe(201);
    const id = json(created).id;
    expect(json(created)).toMatchObject({ name: 'Booking', description: 'Did they book?', prompt: 'Only count confirmed bookings.', assistantCount: 0, schema: BOOKING_SCHEMA });
    expect(json(await owner.caller.request('GET', `/v1/structured-outputs/${id}`)).name).toBe('Booking');

    const assistantId = await assistant(owner, { structuredOutputIds: [id] });
    expect(json(await owner.caller.request('GET', `/v1/structured-outputs/${id}`)).assistantCount).toBe(1);
    const list = json(await owner.caller.request('GET', '/v1/structured-outputs'));
    expect(list.data.find((o: { id: string }) => o.id === id)).toMatchObject({ assistantCount: 1 });

    const patched = await owner.caller.request('PATCH', `/v1/structured-outputs/${id}`, { description: 'Booked or not', prompt: null });
    expect(json(patched)).toMatchObject({ description: 'Booked or not', prompt: null, name: 'Booking' });

    expect((await owner.caller.request('DELETE', `/v1/structured-outputs/${id}`)).statusCode).toBe(204);
    expect((await owner.caller.request('GET', `/v1/structured-outputs/${id}`)).statusCode).toBe(404);
    expect(json(await owner.caller.request('GET', '/v1/structured-outputs')).data.map((o: { id: string }) => o.id)).not.toContain(id);
    expect((await owner.caller.request('DELETE', `/v1/structured-outputs/${id}`)).statusCode).toBe(404);
    // A deleted output cannot be attached to anything new, but the name can be reused
    expect((await owner.caller.request('PATCH', `/v1/assistants/${assistantId}`, { config: { analysis: { structuredOutputIds: [id] } } })).statusCode).toBe(400);
    await structuredOutput(owner, 'Booking');
  });

  it.each([
    ['a schema that is not an object schema', { type: 'array', items: { type: 'string' } }, 'schema.type'],
    ['a pattern (regular expressions can stall the service)', { type: 'object', properties: { phone: { type: 'string', pattern: '^(a+)+$' } } }, 'schema.properties.phone.pattern'],
    ['patternProperties', { type: 'object', patternProperties: { '^x': { type: 'string' } } }, 'schema.patternProperties'],
    ['a $ref to another document', { type: 'object', properties: { a: { $ref: 'https://evil.example/schema.json' } } }, 'schema.properties.a.$ref'],
    ['a schema that does not compile', { type: 'object', properties: { a: { type: 'wizard' } } }, 'schema'],
    ['a schema over 20000 characters', { type: 'object', description: 'x'.repeat(20_001) }, 'schema'],
  ])('refuses %s', async (_label, schema, path) => {
    const res = await owner.caller.request('POST', '/v1/structured-outputs', { name: `Bad ${newId()}`, schema });
    expect(res.statusCode).toBe(400);
    expect(json(res).details.issues.map((i: { path: string }) => i.path)).toContain(path);
  });

  it('accepts a local $ref and formats', async () => {
    const id = await structuredOutput(owner, `Refs ${newId()}`, { type: 'object', $defs: { when: { type: 'string', format: 'date' } }, properties: { date: { $ref: '#/$defs/when' } } });
    expect(id).toBeTruthy();
  });

  it('keeps names unique per org (case-insensitive) and rejects unknown fields', async () => {
    await structuredOutput(owner, 'Unique Name');
    const dup = await owner.caller.request('POST', '/v1/structured-outputs', { name: 'unique name', schema: BOOKING_SCHEMA });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).details.reason).toBe('name_taken');
    expect((await other.caller.request('POST', '/v1/structured-outputs', { name: 'Unique Name', schema: BOOKING_SCHEMA })).statusCode).toBe(201);
    expect((await owner.caller.request('POST', '/v1/structured-outputs', { name: 'x', schema: BOOKING_SCHEMA, color: 'red' })).statusCode).toBe(400);
  });

  it('is attached to many assistants, refuses unknown or foreign ids, and is checked again at publish', async () => {
    const id = await structuredOutput(owner, `Shared ${newId()}`);
    const a = await assistant(owner, { structuredOutputIds: [id] });
    const b = await assistant(owner, { structuredOutputIds: [id] });
    expect(json(await owner.caller.request('GET', `/v1/structured-outputs/${id}`)).assistantCount).toBe(2);
    const foreign = await structuredOutput(other, `Theirs ${newId()}`);
    for (const ids of [[foreign], ['00000000-0000-4000-8000-000000000042']]) {
      const res = await owner.caller.request('POST', '/v1/assistants', { name: 'Bad', config: { analysis: { structuredOutputIds: ids } } });
      expect(res.statusCode).toBe(400);
      expect(json(res).details.issues[0].path).toBe('config.analysis.structuredOutputIds');
    }
    expect((await owner.caller.request('POST', '/v1/assistants', { name: 'Dup', config: { analysis: { structuredOutputIds: [id, id] } } })).statusCode).toBe(400);
    // Deleted after the draft was edited but before it was published: publishing refuses
    expect((await owner.caller.request('PATCH', `/v1/assistants/${a}`, { config: { firstMessage: 'Hello again.' } })).statusCode).toBe(200);
    await owner.caller.request('DELETE', `/v1/structured-outputs/${id}`);
    const publish = await owner.caller.request('POST', `/v1/assistants/${a}/publish`, {});
    expect(publish.statusCode).toBe(400);
    expect(json(publish).details.issues[0].path).toBe('config.analysis.structuredOutputIds');
    expect(b).toBeTruthy();
  });

  it('validates the success rubric settings on the assistant', async () => {
    const make = (successEvaluation: object) => owner.caller.request('POST', '/v1/assistants', { name: 'Rubric', config: { analysis: { successEvaluation } } });
    expect((await make({ enabled: true, rubric: 'categories' })).statusCode).toBe(400);
    expect((await make({ enabled: true, rubric: 'categories', categories: ['one'] })).statusCode).toBe(400);
    expect((await make({ enabled: true, rubric: 'categories', categories: ['a', 'a'] })).statusCode).toBe(400);
    expect((await make({ enabled: true, rubric: 'pass-fail', categories: ['a', 'b'] })).statusCode).toBe(400);
    expect((await make({ enabled: true, rubric: 'categories', categories: ['resolved', 'escalated', 'abandoned'] })).statusCode).toBe(201);
  });

  it('lets viewers read but not change', async () => {
    const viewer = await addMember(t, owner, 'viewer');
    const id = await structuredOutput(owner, `Viewable ${newId()}`);
    expect((await viewer.caller.request('GET', `/v1/structured-outputs/${id}`)).statusCode).toBe(200);
    expect((await viewer.caller.request('POST', '/v1/structured-outputs', { name: 'No', schema: BOOKING_SCHEMA })).statusCode).toBe(403);
    expect((await viewer.caller.request('PATCH', `/v1/structured-outputs/${id}`, { name: 'No' })).statusCode).toBe(403);
    expect((await viewer.caller.request('DELETE', `/v1/structured-outputs/${id}`)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- transcript from a live call

describe('transcript of a call', () => {
  let base: string;
  beforeAll(async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });

  it('stores who said what and when, with the tool call in between, and queues the analysis when the call ends', async () => {
    const id = await structuredOutput(owner, `Live ${newId()}`);
    const assistantId = await assistant(owner, { summary: { enabled: true }, structuredOutputIds: [id] });
    const created = json(await owner.caller.request('POST', '/v1/calls', { assistantId }));
    const ws = new WebSocket(`${base}/v1/calls/${created.id}/connect`, { headers: { origin: DASHBOARD } });
    const events: Record<string, any>[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) events.push(JSON.parse(data.toString()));
    });
    const closed = new Promise((resolve) => ws.on('close', resolve));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: created.connectToken, mode: 'chat' }));
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(check()).toBe(true);
    };
    await until(() => events.some((e) => e.type === 'transcript' && e.role === 'assistant' && e.final));
    ws.send(JSON.stringify({ type: 'message', text: 'I need to book a table' }));
    await until(() => events.some((e) => e.type === 'transcript' && e.role === 'assistant' && e.final && /You said/.test(e.text)));
    ws.send(JSON.stringify({ type: 'message', text: 'ok bye' }));
    await closed;

    let call: any;
    for (let i = 0; i < 200; i++) {
      call = json(await owner.caller.request('GET', `/v1/calls/${created.id}`));
      if (call.status === 'ended') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(call.status).toBe('ended');
    const speech = call.transcript.filter((e: { kind: string }) => e.kind === 'speech');
    expect(speech.map((e: { role: string; text: string }) => [e.role, e.text])).toEqual([
      ['assistant', 'Hello.'],
      ['user', 'I need to book a table'],
      ['assistant', 'You said: I need to book a table'],
      ['user', 'ok bye'],
      ['assistant', 'Goodbye!'],
    ]);
    expect(call.transcript.map((e: { seq: number }) => e.seq)).toEqual(call.transcript.map((_: unknown, i: number) => i + 1));
    for (const entry of call.transcript) {
      expect(Date.parse(entry.endedAt)).toBeGreaterThanOrEqual(Date.parse(entry.startedAt));
      expect(entry.endOffsetMs).toBeGreaterThanOrEqual(entry.startOffsetMs);
      expect(typeof entry.createdAt).toBe('string');
    }
    // seq is the order. Speech lines are in time order; a tool call is placed where the model asked for it
    const speechStarts = speech.map((e: { startedAt: string }) => Date.parse(e.startedAt));
    expect(speechStarts).toEqual([...speechStarts].sort((a, b) => a - b));
    const tool = call.transcript.find((e: { kind: string }) => e.kind === 'tool-call');
    expect(tool).toMatchObject({ role: 'tool', text: 'endCall', toolCall: { name: 'endCall', arguments: {}, result: null, status: 'requested' } });
    // The tool call sits between the lines around it, not at the end
    const toolIndex = call.transcript.indexOf(tool);
    expect(toolIndex).toBeGreaterThan(0);
    expect(toolIndex).toBeLessThan(call.transcript.length);

    const row = await rowOf(created.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    t.analysisClock.now = Date.now() + 1000; // the live call queued its job at real time
    await tick();
    const analysis = await analysisOf(owner, created.id);
    expect(analysis).toMatchObject({ status: 'succeeded', summary: expect.stringContaining('appointment') });
    expect(analysis.structuredOutputs).toHaveLength(1);
    // The model was shown the call as one fenced transcript with times and the tool call
    const prompt = String(seen.find((s) => s.step === 'summary')!.request.messages[0].content);
    expect(prompt).toContain('<transcript>');
    expect(prompt).toMatch(/\[\d\d:\d\d\] Caller: I need to book a table/);
    expect(prompt).toContain('(tool call) endCall({})');
  }, 30_000);

  it('marks an interrupted assistant line, and keeps older rows readable', async () => {
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const callId = await endedCall(owner, assistantId, [{ role: 'assistant', text: 'Our opening hours are nine to' }]);
    await t.db.query(`UPDATE call_transcript SET interrupted = true WHERE call_id = $1`, [callId]);
    const call = json(await owner.caller.request('GET', `/v1/calls/${callId}`));
    expect(call.transcript[0]).toMatchObject({ kind: 'speech', role: 'assistant', interrupted: true });
    expect(call.transcript[0]).not.toHaveProperty('toolCall');
  });
});

// ---------------------------------------------------------------- the analysis job

describe('analysis job', () => {
  it('writes a summary, a success verdict and structured values on the call, and tracks the cost', async () => {
    const reusable = await structuredOutput(owner, `Booking ${newId()}`, BOOKING_SCHEMA, { prompt: 'Count confirmed bookings only.' });
    const assistantId = await assistant(owner, {
      summary: { enabled: true, prompt: 'One sentence, in French.' },
      successEvaluation: { enabled: true, rubric: 'pass-fail', prompt: 'Was the appointment booked?' },
      structuredData: { enabled: true, prompt: 'Extract the contact.', schema: { type: 'object', properties: { phone: { type: 'string' } } } },
      structuredOutputIds: [reusable],
    });
    script.output = (_r, _n, name) => (name === 'inline' ? '```json\n{"phone": "+8801711000001"}\n```' : '{"appointment_booked": true, "sentiment": "positive", "score": 9}');
    const callId = await endedCall(owner, assistantId);
    expect(await tick()).toMatchObject({ claimed: 1, succeeded: 1 });

    const analysis = await analysisOf(owner, callId);
    expect(analysis).toMatchObject({
      status: 'succeeded',
      summary: 'The caller asked to book an appointment for tomorrow; the assistant booked it.',
      successEvaluation: { rubric: 'pass-fail', passed: true, score: null, category: null, reason: 'Booked.' },
    });
    expect(analysis.structuredOutputs).toEqual([
      { id: null, name: 'inline', status: 'succeeded', values: { phone: '+8801711000001' }, error: null },
      { id: reusable, name: expect.stringContaining('Booking'), status: 'succeeded', values: { appointment_booked: true, sentiment: 'positive', score: 9 }, error: null },
    ]);
    // The configured prompts reached the model; the transcript is fenced and the system prompt calls it data
    const summaryRequest = seen.find((s) => s.step === 'summary')!.request;
    expect(String(summaryRequest.messages[0].content)).toContain('One sentence, in French.');
    expect(summaryRequest.systemPrompt).toContain('not instructions');
    expect(String(seen.find((s) => s.step === 'success')!.request.messages[0].content)).toContain('Was the appointment booked?');
    const extraction = String(seen.find((s) => s.step.startsWith('output:Booking'))!.request.messages[0].content);
    expect(extraction).toContain('Count confirmed bookings only.');
    expect(extraction).toContain('"appointment_booked"');

    // The same results on the call itself
    const call = json(await owner.caller.request('GET', `/v1/calls/${callId}`));
    expect(call.analysis).toEqual(analysis);

    // Cost: one usage record per model request, tokens summed on the analysis, billed to the platform key
    const usage = await usageRows(callId);
    expect(usage).toHaveLength(4);
    expect(usage.every((u) => u.subject_type === 'call' && u.billing_unit === 'token' && u.billing === 'platform' && u.provider === 'fake-llm' && u.model === 'fake-llm-1')).toBe(true);
    expect(usage.every((u) => u.quantity === u.input_tokens + u.output_tokens && u.input_tokens > 0 && u.output_tokens > 0)).toBe(true);
    const sum = (key: string) => usage.reduce((n, u) => n + u[key], 0);
    expect(analysis.usage).toEqual({ inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), requests: 4 });
    expect((await rowOf(callId)).usage.steps).toHaveProperty('summary');
  });

  it.each([
    ['numeric-scale', undefined, '{"score": 8, "reason": "Good."}', { score: 8, passed: null, category: null }],
    ['categories', ['resolved', 'escalated', 'abandoned'], '{"category": "escalated", "reason": "Needed a human."}', { category: 'escalated', passed: null, score: null }],
    ['descriptive', undefined, '{"verdict": "Mostly fine; the caller waited a little."}', { reason: 'Mostly fine; the caller waited a little.', passed: null, score: null }],
  ])('evaluates success with the %s rubric', async (rubric, categories, reply, expected) => {
    const assistantId = await assistant(owner, { successEvaluation: { enabled: true, rubric, ...(categories ? { categories } : {}) } });
    script.success = () => reply;
    const callId = await endedCall(owner, assistantId);
    await tick();
    expect((await analysisOf(owner, callId)).successEvaluation).toMatchObject({ rubric, ...expected });
    const task = String(seen.find((s) => s.step === 'success')!.request.messages[0].content);
    if (rubric === 'numeric-scale') expect(task).toContain('from 1 (worst) to 10 (best)');
    if (rubric === 'categories') expect(task).toContain('["resolved","escalated","abandoned"]');
  });

  it('asks again once when the answer is not valid JSON or breaks the schema, feeding back why', async () => {
    const id = await structuredOutput(owner, `Strict ${newId()}`);
    const assistantId = await assistant(owner, { structuredOutputIds: [id], successEvaluation: { enabled: true, rubric: 'numeric-scale' } });
    script.output = (_r, n) => (n === 1 ? '{"appointment_booked": "yes", "sentiment": "happy"}' : '{"appointment_booked": true, "sentiment": "positive"}');
    script.success = (_r, n) => (n === 1 ? 'I think it went well!' : '{"score": 7, "reason": "ok"}');
    const callId = await endedCall(owner, assistantId);
    await tick();
    const analysis = await analysisOf(owner, callId);
    expect(analysis.status).toBe('succeeded');
    expect(analysis.structuredOutputs[0]).toMatchObject({ status: 'succeeded', values: { appointment_booked: true, sentiment: 'positive' } });
    expect(analysis.successEvaluation).toMatchObject({ score: 7 });
    const retry = seen.filter((s) => s.step.startsWith('output:Strict'))[1].request.messages;
    expect(retry).toHaveLength(3);
    expect(String(retry[2].content)).toMatch(/must be boolean/);
    expect(String(retry[2].content)).toMatch(/sentiment/);
    expect(String(seen.filter((s) => s.step === 'success')[1].request.messages[2].content)).toContain('no JSON object');
  });

  it('records a step that never validates as failed, keeps the other steps, and does not loop', async () => {
    const id = await structuredOutput(owner, `Hopeless ${newId()}`);
    const assistantId = await assistant(owner, { summary: { enabled: true }, structuredOutputIds: [id] });
    script.output = () => '{"appointment_booked": 5}';
    const callId = await endedCall(owner, assistantId);
    expect(await tick()).toMatchObject({ succeeded: 1, retried: 0, failed: 0 });
    const analysis = await analysisOf(owner, callId);
    expect(analysis.status).toBe('succeeded');
    expect(analysis.summary).toContain('appointment');
    expect(analysis.structuredOutputs[0]).toMatchObject({ status: 'failed', values: null });
    expect(analysis.structuredOutputs[0].error).toContain('did not validate after a retry');
    expect(Object.entries(counts).find(([key]) => key.startsWith('output:Hopeless'))![1]).toBe(2);
    t.analysisClock.now += 10 * 60 * MINUTE;
    expect((await tick()).claimed).toBe(0);
  });

  it('retries provider failures with backoff, redoing only what is missing, then gives up', async () => {
    const id = await structuredOutput(owner, `Flaky ${newId()}`);
    const assistantId = await assistant(owner, { summary: { enabled: true }, structuredOutputIds: [id] });
    let failing = true;
    script.output = () => (failing ? { text: 'x', error: 'before-first-token', errorAttempts: 99 } : '{"appointment_booked": true, "sentiment": "neutral"}');
    const callId = await endedCall(owner, assistantId);

    expect(await tick()).toMatchObject({ claimed: 1, retried: 1 });
    let row = await rowOf(callId);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row.last_error).toContain('output:');
    expect(row.summary).toContain('appointment'); // the step that worked is kept
    expect(new Date(row.next_attempt_at).getTime() - t.analysisClock.now).toBe(30_000);
    expect(await usageRows(callId)).toHaveLength(1); // the summary's request; the failed one produced no tokens

    t.analysisClock.now += 29_000;
    expect((await tick()).claimed).toBe(0);
    t.analysisClock.now += 2_000;
    expect(await tick()).toMatchObject({ claimed: 1, retried: 1 });
    expect(new Date((await rowOf(callId)).next_attempt_at).getTime() - t.analysisClock.now).toBe(120_000);
    expect(counts.summary).toBe(1); // never asked again

    failing = false;
    t.analysisClock.now += 121_000;
    expect(await tick()).toMatchObject({ claimed: 1, succeeded: 1 });
    row = await rowOf(callId);
    expect(row).toMatchObject({ status: 'succeeded', attempts: 3, last_error: null });
    expect((await analysisOf(owner, callId)).structuredOutputs[0].values).toEqual({ appointment_booked: true, sentiment: 'neutral' });
    expect(counts.summary).toBe(1);
  });

  it('ends as failed after the last attempt, keeps partial results, and still sends the report', async () => {
    const hook = await owner.caller.request('POST', '/v1/webhooks', { url: 'https://hooks.example/failed', secret: 'a-long-enough-secret', events: ['end-of-call-report'] });
    expect(hook.statusCode).toBe(201);
    const assistantId = await assistant(owner, { summary: { enabled: true }, successEvaluation: { enabled: true, rubric: 'pass-fail' } });
    script.success = () => ({ text: 'x', error: 'before-first-token', errorAttempts: 99 });
    const callId = await endedCall(owner, assistantId);
    for (let i = 0; i < 3; i++) {
      expect((await tick()).retried).toBe(1);
      t.analysisClock.now += 70 * MINUTE;
    }
    expect(await tick()).toMatchObject({ failed: 1 });
    const analysis = await analysisOf(owner, callId);
    expect(analysis).toMatchObject({ status: 'failed', attempts: 4, summary: expect.stringContaining('appointment') });
    expect(analysis.error).toContain('success');
    const sent = (await reports()).filter((r) => r.call_id === callId);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.data.analysis).toMatchObject({ status: 'failed', summary: expect.stringContaining('appointment') });
    await owner.caller.request('DELETE', `/v1/webhooks/${json(hook).id}`);
  });

  it('takes over a job whose worker died, and fails one that keeps killing its worker', async () => {
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const callId = await endedCall(owner, assistantId);
    // A worker claimed it and vanished: the lease runs out
    await t.db.query(`UPDATE call_analysis SET status = 'running', attempts = 1, locked_until = $2::timestamptz WHERE call_id = $1`, [callId, new Date(t.analysisClock.now + 5 * MINUTE).toISOString()]);
    expect((await tick()).claimed).toBe(0);
    t.analysisClock.now += 6 * MINUTE;
    expect(await tick()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await rowOf(callId)).toMatchObject({ status: 'succeeded', attempts: 2 });

    const stuck = await endedCall(owner, assistantId);
    await t.db.query(`UPDATE call_analysis SET status = 'running', attempts = 4, locked_until = $2::timestamptz WHERE call_id = $1`, [stuck, new Date(t.analysisClock.now - 1000).toISOString()]);
    expect(await tick()).toMatchObject({ claimed: 0, failed: 1 });
    expect(await rowOf(stuck)).toMatchObject({ status: 'failed' });
    expect((await rowOf(stuck)).last_error).toContain('stopped before finishing');
  });

  it('never runs the same job twice, even from overlapping ticks or a second worker', async () => {
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const calls = await Promise.all(Array.from({ length: 3 }, () => endedCall(owner, assistantId)));
    const { AnalysisWorker } = await import('../src/services/analysis/worker.ts');
    const second = new AnalysisWorker(t.ctx, t.app.log, () => new Date(t.analysisClock.now));
    await Promise.all([tick(), second.tick(), tick(), second.tick()]);
    expect(counts.summary).toBe(3);
    for (const id of calls) expect(await rowOf(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('skips calls with nothing to analyse, and still reports them', async () => {
    const hook = await owner.caller.request('POST', '/v1/webhooks', { url: 'https://hooks.example/skipped', secret: 'a-long-enough-secret', events: ['end-of-call-report'], scopeType: 'org' });
    const disabled = await assistant(owner, {});
    const noTranscript = await assistant(owner, { summary: { enabled: true } });
    const a = await endedCall(owner, disabled);
    const b = await endedCall(owner, noTranscript, [{ tool: 'lookup' }]);
    await tick();
    expect(await analysisOf(owner, a)).toMatchObject({ status: 'skipped', skipReason: 'analysis-disabled', summary: null });
    expect(await analysisOf(owner, b)).toMatchObject({ status: 'skipped', skipReason: 'no-transcript' });
    expect(seen).toHaveLength(0);
    expect((await reports()).filter((r) => [a, b].includes(r.call_id))).toHaveLength(2);
    expect(await usageRows(a)).toHaveLength(0);
    await owner.caller.request('DELETE', `/v1/webhooks/${json(hook).id}`);
  });

  it('skips a structured output that was deleted after the assistant was published', async () => {
    const id = await structuredOutput(owner, `Gone ${newId()}`);
    const assistantId = await assistant(owner, { summary: { enabled: true }, structuredOutputIds: [id] });
    await owner.caller.request('DELETE', `/v1/structured-outputs/${id}`);
    const callId = await endedCall(owner, assistantId);
    await tick();
    const analysis = await analysisOf(owner, callId);
    expect(analysis.status).toBe('succeeded');
    expect(analysis.structuredOutputs[0]).toMatchObject({ status: 'skipped', error: 'This structured output was deleted' });
    expect(seen.map((s) => s.step)).toEqual(['summary']);
  });

  it('uses the schema the output had when the call was analysed, and an inline schema is checked at analysis time', async () => {
    const id = await structuredOutput(owner, `Snapshot ${newId()}`);
    const inlineBad = await assistant(owner, { structuredData: { enabled: true, schema: { type: 'object', properties: { a: { type: 'string', pattern: '^(x+)+$' } } } } });
    const callId = await endedCall(owner, inlineBad);
    await tick();
    expect((await analysisOf(owner, callId)).structuredOutputs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('not supported') });
    const assistantId = await assistant(owner, { structuredOutputIds: [id] });
    const ok = await endedCall(owner, assistantId);
    await tick();
    expect((await rowOf(ok)).outputs[id].schema).toEqual(BOOKING_SCHEMA);
    await owner.caller.request('PATCH', `/v1/structured-outputs/${id}`, { schema: { type: 'object', properties: { other: { type: 'string' } } } });
    expect((await rowOf(ok)).outputs[id].schema).toEqual(BOOKING_SCHEMA);
  });

  it('cuts the middle of a very long call instead of exceeding the model context', async () => {
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const lines: Line[] = Array.from({ length: 2500 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', text: `line number ${i} ${'blah '.repeat(10)}` }) as Line);
    const callId = await endedCall(owner, assistantId, lines);
    await tick();
    const prompt = String(seen[0].request.messages[0].content);
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain('line number 0 ');
    expect(prompt).toContain('line number 2499 ');
    expect(prompt).toContain('the middle of a long call was left out');
    expect((await analysisOf(owner, callId)).status).toBe('succeeded');
  }, 30_000);

  it('can be run again: results are replaced, the report is not sent twice, and a running job is refused', async () => {
    const hook = await owner.caller.request('POST', '/v1/webhooks', { url: 'https://hooks.example/rerun', secret: 'a-long-enough-secret', events: ['end-of-call-report'] });
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const callId = await endedCall(owner, assistantId);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/analysis`)).statusCode).toBe(409); // still queued
    await tick();
    expect((await reports()).filter((r) => r.call_id === callId)).toHaveLength(1);
    script.summary = () => 'A better summary.';
    const rerun = await owner.caller.request('POST', `/v1/calls/${callId}/analysis`);
    expect(rerun.statusCode).toBe(202);
    expect(json(rerun)).toMatchObject({ status: 'pending', summary: null });
    await tick();
    expect(await analysisOf(owner, callId)).toMatchObject({ status: 'succeeded', summary: 'A better summary.' });
    expect((await reports()).filter((r) => r.call_id === callId)).toHaveLength(1);
    // Usage keeps both runs
    expect((await analysisOf(owner, callId)).usage.requests).toBe(2);
    expect(await usageRows(callId)).toHaveLength(2);
    // A call that has not ended cannot be analysed
    await t.db.query(`UPDATE call SET status = 'in-progress' WHERE id = $1`, [callId]);
    await t.db.query(`UPDATE call_analysis SET status = 'succeeded' WHERE call_id = $1`, [callId]);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/analysis`)).statusCode).toBe(409);
    expect((await owner.caller.request('POST', `/v1/calls/${newId()}/analysis`)).statusCode).toBe(404);
    expect((await owner.caller.request('GET', `/v1/calls/${newId()}/analysis`)).statusCode).toBe(404);
    await owner.caller.request('DELETE', `/v1/webhooks/${json(hook).id}`);
  });
});

// ---------------------------------------------------------------- filters

describe('filtering calls by analysis', () => {
  let a1: string;
  let a2: string;
  const ids: Record<string, string> = {};
  let outputId: string;
  let otherId: string;

  beforeAll(async () => {
    outputId = await structuredOutput(owner, `Filterable ${newId()}`);
    otherId = await structuredOutput(owner, `Second ${newId()}`, { type: 'object', properties: { appointment_booked: { type: 'string' }, tag: { type: 'string' } } });
    a1 = await assistant(owner, { summary: { enabled: true }, successEvaluation: { enabled: true, rubric: 'numeric-scale' }, structuredOutputIds: [outputId, otherId] });
    a2 = await assistant(owner, { successEvaluation: { enabled: true, rubric: 'categories', categories: ['resolved', 'escalated'] }, structuredOutputIds: [outputId] });
    const plan: [string, string, string, string, string][] = [
      // name, assistant, output values, success reply, text
      ['booked-high', a1, '{"appointment_booked": true, "sentiment": "positive", "score": 9}', '{"score": 9, "reason": "r"}', 'I want a haircut'],
      ['booked-low', a1, '{"appointment_booked": true, "sentiment": "neutral", "score": 3}', '{"score": 3, "reason": "r"}', 'Maybe a haircut'],
      ['not-booked', a1, '{"appointment_booked": false, "sentiment": "negative", "score": 5}', '{"score": 5, "reason": "r"}', 'Never mind, too expensive'],
      ['escalated', a2, '{"appointment_booked": false, "sentiment": "negative"}', '{"category": "escalated", "reason": "r"}', 'Let me speak to a manager'],
      ['resolved', a2, '{"appointment_booked": true, "sentiment": "positive"}', '{"category": "resolved", "reason": "r"}', 'আমি একটি অ্যাপয়েন্টমেন্ট চাই'],
    ];
    let i = 0;
    for (const [name, assistantId, values, success, text] of plan) {
      script.output = (_r, _n, step) => (step.startsWith('Second') ? '{"appointment_booked": "maybe", "tag": "vip"}' : values);
      script.success = () => success;
      ids[name] = await endedCall(owner, assistantId, [{ role: 'assistant', text: 'Hello.' }, { role: 'user', text }], { createdAt: new Date(Date.parse('2026-11-05T04:00:00Z') + i++ * 1000).toISOString() });
      await tick();
      expect((await analysisOf(owner, ids[name])).status).toBe('succeeded');
    }
  }, 60_000);

  /** Scoped to this suite's calls (November 2026); other suites' calls share the org. */
  const list = async (query: string, who = owner, window = true) => {
    const range = window && !query.includes('from=') ? '&from=2026-11-05T00:00:00Z&to=2026-11-06T00:00:00Z' : '';
    const res = await who.caller.request('GET', `/v1/calls?limit=100&${query}${range}`);
    expect(res.statusCode, res.body).toBe(200);
    return (json(res).data as { id: string }[]).map((c) => c.id);
  };
  const names = (found: string[]) => Object.keys(ids).filter((n) => found.includes(ids[n])).sort();

  it('returns each call with its analysis, newest first', async () => {
    const res = json(await owner.caller.request('GET', `/v1/calls?assistantId=${a2}`));
    expect(res.data.map((c: { id: string }) => c.id)).toEqual([ids.resolved, ids.escalated]);
    expect(res.data[0]).toMatchObject({ assistantId: a2, assistantName: expect.any(String), status: 'ended', analysis: { status: 'succeeded', successEvaluation: { category: 'resolved' } } });
  });

  it('filters on an extracted value: output.appointment_booked=true', async () => {
    // booked-* and resolved have it true in their reusable output; "second" stores it as the string "maybe"
    expect(names(await list('output.appointment_booked=true'))).toEqual(['booked-high', 'booked-low', 'resolved']);
    expect(names(await list('output.appointment_booked=false'))).toEqual(['escalated', 'not-booked']);
    // A text field, and a text value in another output (any output of the call matches)
    expect(names(await list('output.sentiment=negative'))).toEqual(['escalated', 'not-booked']);
    expect(names(await list('output.appointment_booked=maybe'))).toEqual(['booked-high', 'booked-low', 'not-booked']);
    expect(names(await list('output.tag=vip')).length).toBe(3);
    expect(await list('output.appointment_booked=nonsense')).toEqual([]);
    expect(await list('output.nonexistent=true')).toEqual([]);
  });

  it('combines filters with AND, supports numeric ranges, and can be restricted to one output', async () => {
    expect(names(await list('output.appointment_booked=true&output.sentiment=positive'))).toEqual(['booked-high', 'resolved']);
    expect(names(await list('output.score.gte=5'))).toEqual(['booked-high', 'not-booked']);
    expect(names(await list('output.score.gt=5'))).toEqual(['booked-high']);
    expect(names(await list('output.score.lte=3'))).toEqual(['booked-low']);
    expect(names(await list('output.score.gte=4&output.score.lt=9'))).toEqual(['not-booked']);
    expect(names(await list(`output.appointment_booked=maybe&outputId=${outputId}`))).toEqual([]);
    expect(names(await list(`output.appointment_booked=maybe&outputId=${otherId}`))).toEqual(['booked-high', 'booked-low', 'not-booked']);
    // A text field never matches a numeric range
    expect(await list('output.sentiment.gte=0')).toEqual([]);
  });

  it('filters on the success evaluation, the analysis state, assistant, text and dates', async () => {
    expect(names(await list('successScore.gte=5'))).toEqual(['booked-high', 'not-booked']);
    expect(names(await list('successScore.lte=5&successScore.gte=3'))).toEqual(['booked-low', 'not-booked']);
    expect(names(await list('successCategory=escalated'))).toEqual(['escalated']);
    expect(names(await list(`assistantId=${a2}&analysisStatus=succeeded`))).toEqual(['escalated', 'resolved']);
    expect(await list(`assistantId=${a1}&analysisStatus=failed`)).toEqual([]);
    expect(names(await list('q=haircut'))).toEqual(['booked-high', 'booked-low']);
    expect(names(await list('q=manager'))).toEqual(['escalated']);
    expect(names(await list('output.appointment_booked=true&q=haircut'))).toEqual(['booked-high', 'booked-low']);
    expect(names(await list('from=2026-11-05T04:00:02Z&to=2026-11-05T04:00:04Z'))).toEqual(['escalated', 'not-booked']);
    expect(names(await list('status=ended&type=web&direction=web')).length).toBeGreaterThanOrEqual(5);
  });

  it('filters on pass-fail results', async () => {
    const a3 = await assistant(owner, { successEvaluation: { enabled: true, rubric: 'pass-fail' } });
    const pass = await endedCall(owner, a3, [{ role: 'user', text: 'Thanks, that was great' }]);
    const fail = await endedCall(owner, a3, [{ role: 'user', text: 'This was terrible service' }]);
    script.success = (request) => (String(request.messages[0].content).includes('terrible') ? '{"passed": false, "reason": "no"}' : '{"passed": true, "reason": "yes"}');
    await tick();
    expect(await list(`assistantId=${a3}&success=true`, owner, false)).toEqual([pass]);
    expect(await list(`assistantId=${a3}&success=false`, owner, false)).toEqual([fail]);
  });

  it('filters on the end reason: one, or any of several', async () => {
    const a4 = await assistant(owner, { summary: { enabled: true } });
    const hungUp = await endedCall(owner, a4, defaultLines(), { endReason: 'customer-ended-call' });
    const failed = await endedCall(owner, a4, defaultLines(), { endReason: 'error-llm-failed' });
    const silent = await endedCall(owner, a4, defaultLines(), { endReason: 'silence-timeout' });
    await tick();
    expect(await list(`assistantId=${a4}&endReason=error-llm-failed`, owner, false)).toEqual([failed]);
    expect((await list(`assistantId=${a4}&endReason=silence-timeout,customer-ended-call`, owner, false)).sort()).toEqual([hungUp, silent].sort());
    expect(await list(`assistantId=${a4}&endReason=transferred`, owner, false)).toEqual([]);
    // Another org's calls with the same reason never match
    expect(await list('endReason=error-llm-failed', other, false)).toEqual([]);
  });

  it('pages through filtered results', async () => {
    const window = 'from=2026-11-05T00:00:00Z&to=2026-11-06T00:00:00Z';
    const first = json(await owner.caller.request('GET', `/v1/calls?output.appointment_booked=true&limit=2&${window}`));
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = json(await owner.caller.request('GET', `/v1/calls?output.appointment_booked=true&limit=2&${window}&cursor=${first.nextCursor}`));
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.data, ...second.data].map((c: { id: string }) => c.id).sort()).toEqual([ids['booked-high'], ids['booked-low'], ids.resolved].sort());
  });

  it.each([
    ['an unknown filter', 'colour=red'],
    ['a malformed output filter', 'output.=true'],
    ['an output field with an operator but no number', 'output.score.gte=abc'],
    ['an invalid operator', 'output.score.between=1'],
    ['a bad assistant id', 'assistantId=nope'],
    ['a bad status', 'status=melting'],
    ['a bad success value', 'success=maybe'],
    ['a bad outputId', 'output.a=1&outputId=nope'],
    ['a bad date', 'from=yesterday'],
    ['a bad score', 'successScore.gte=eleven'],
    ['a repeated filter', 'status=ended&status=failed'],
    ['a malformed end reason', 'endReason=Error%20LLM'],
    ['an empty end reason in a list', 'endReason=silence-timeout,,transferred'],
    ['too many end reasons', `endReason=${Array.from({ length: 11 }, (_, i) => `reason-${i}`).join(',')}`],
  ])('refuses %s', async (_label, query) => {
    const res = await owner.caller.request('GET', `/v1/calls?${query}`);
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('validation_error');
  });

  it("never matches another org's calls", async () => {
    expect(await list('output.appointment_booked=true', other, false)).toEqual([]);
    const theirs = await assistant(other, { summary: { enabled: true } });
    const call = await endedCall(other, theirs);
    await tick();
    expect(await list('', other, false)).toEqual([call]);
    expect(await list('', owner, false)).not.toContain(call);
    expect((await owner.caller.request('GET', `/v1/calls/${call}/analysis`)).statusCode).toBe(404);
    expect((await owner.caller.request('POST', `/v1/calls/${call}/analysis`)).statusCode).toBe(404);
    expect((await owner.caller.request('GET', `/v1/calls/${call}`)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- transcript search

describe('transcript search', () => {
  let mine: string;
  let theirs: string;
  let assistantId: string;

  beforeAll(async () => {
    assistantId = await assistant(owner, {}, 'Searchable');
    mine = await endedCall(owner, assistantId, [
      { role: 'assistant', text: 'Welcome to Rahman Dental.' },
      { role: 'user', text: 'My tooth hurts, can I see the dentist today?' },
      { tool: 'checkAvailability', args: { day: 'today' } },
      { role: 'user', text: 'আমার দাঁতে ব্যথা হচ্ছে' },
    ]);
    theirs = await endedCall(other, await assistant(other, {}), [{ role: 'user', text: 'Rahman dentist question from another org' }]);
  });

  const search = async (query: string, who = owner) => {
    const res = await who.caller.request('GET', `/v1/transcripts/search?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return json(res);
  };

  it('finds lines by word, in English and Bangla, and marks the match', async () => {
    const hits = await search('q=dentist');
    expect(hits.data).toHaveLength(1);
    expect(hits.data[0]).toMatchObject({ callId: mine, assistantId, assistantName: 'Searchable', kind: 'speech', role: 'user', seq: 2, text: 'My tooth hurts, can I see the dentist today?' });
    expect(hits.data[0].snippet).toContain('«dentist»');
    const bangla = await search(`q=${encodeURIComponent('দাঁতে')}`);
    expect(bangla.data.map((h: { callId: string }) => h.callId)).toEqual([mine]);
    expect(bangla.data[0].snippet).toContain('«দাঁতে»');
    expect((await search('q=nothingmatchesthis')).data).toEqual([]);
  });

  it("is per org: one org's words never find another's lines", async () => {
    expect((await search('q=Rahman')).data.map((h: { callId: string }) => h.callId).sort()).toEqual([mine]);
    expect((await search('q=Rahman', other)).data.map((h: { callId: string }) => h.callId)).toEqual([theirs]);
    expect((await search('q=hurts', other)).data).toEqual([]);
  });

  it('finds tool calls by name, supports phrases and exclusions, and narrows by assistant, call and date', async () => {
    expect((await search('q=checkAvailability')).data[0]).toMatchObject({ kind: 'tool-call', role: 'tool' });
    expect((await search('q=%22tooth+hurts%22')).data).toHaveLength(1);
    expect((await search('q=tooth+-hurts')).data).toHaveLength(0);
    expect((await search(`q=Rahman&assistantId=${assistantId}`)).data).toHaveLength(1);
    expect((await search(`q=Rahman&assistantId=${newId()}`)).data).toHaveLength(0);
    expect((await search(`q=dentist&callId=${mine}`)).data).toHaveLength(1);
    expect((await search('q=dentist&from=2027-01-01')).data).toHaveLength(0);
    expect((await search('q=dentist&to=2027-01-01')).data).toHaveLength(1);
  });

  it('pages and validates', async () => {
    const first = await search('q=Rahman&limit=1');
    expect(first.data).toHaveLength(1);
    expect((await search('q=to&limit=1&cursor=' + (first.nextCursor ?? ''))).data.length).toBeLessThanOrEqual(1);
    for (const query of ['', 'q=', `q=${'x'.repeat(201)}`, 'q=a&color=red', 'q=a&from=yesterday', 'q=a&assistantId=nope']) {
      expect((await owner.caller.request('GET', `/v1/transcripts/search?${query}`)).statusCode, query).toBe(400);
    }
  });

  it('treats search text as text: operators and quotes cannot break the query', async () => {
    for (const q of ["'; DROP TABLE call_transcript; --", '&|!()<>', '"unterminated', '   ']) {
      const res = await owner.caller.request('GET', `/v1/transcripts/search?q=${encodeURIComponent(q)}`);
      expect([200, 400]).toContain(res.statusCode);
    }
    expect((await t.db.query('SELECT count(*)::int AS n FROM call_transcript')).rows[0]).toMatchObject({ n: expect.any(Number) });
  });
});

// ---------------------------------------------------------------- the report webhook

describe('end-of-call-report webhook', () => {
  async function endpoint(who: SignedUp, body: Record<string, unknown>): Promise<string> {
    const res = await who.caller.request('POST', '/v1/webhooks', { secret: 'a-long-enough-secret', events: ['end-of-call-report'], ...body });
    expect(res.statusCode, res.body).toBe(201);
    return json(res).id;
  }
  const deliver = () => t.ctx.webhookDelivery.tick();

  it('queues one report when analysis finishes, with the call and the results, and sends it signed', async () => {
    const hook = await endpoint(owner, { url: 'https://hooks.example/reports' });
    const id = await structuredOutput(owner, `Reported ${newId()}`);
    const assistantId = await assistant(owner, { summary: { enabled: true }, successEvaluation: { enabled: true, rubric: 'pass-fail' }, structuredOutputIds: [id] });
    const callId = await endedCall(owner, assistantId);
    expect((await reports()).filter((r) => r.call_id === callId)).toHaveLength(0); // not before the analysis is done
    await tick();
    const queued = (await reports()).filter((r) => r.call_id === callId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ endpoint_id: hook, status: 'pending' });
    const payload = queued[0].payload;
    expect(payload).toMatchObject({ type: 'end-of-call-report', callId, sequence: 1, id: `evt_${callId}_1` });
    expect(payload.data.call).toMatchObject({ id: callId, assistantId, assistantName: expect.any(String), type: 'web', status: 'ended', endReason: 'assistant-ended-call', durationMs: 90000 });
    expect(payload.data.analysis).toMatchObject({
      status: 'succeeded',
      summary: expect.stringContaining('appointment'),
      successEvaluation: { rubric: 'pass-fail', passed: true },
      structuredOutputs: [{ id, status: 'succeeded', values: { appointment_booked: true, sentiment: 'positive' } }],
    });
    expect(payload.data).not.toHaveProperty('transcript'); // the endpoint did not opt in

    expect(await deliver()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(http.requests).toHaveLength(1);
    const request = http.requests[0];
    expect(request.url).toBe('https://hooks.example/reports');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers['x-octo-event']).toBe('end-of-call-report');
    expect(request.init.headers['x-octo-delivery']).toBe(queued[0].id);
    expect(JSON.parse(request.init.body!)).toEqual(payload);
    expect(verifyWebhookSignature('a-long-enough-secret', request.init.headers['x-octo-signature'], request.init.body!, Math.floor(t.webhookClock.now / 1000))).toBe(true);
    expect(verifyWebhookSignature('another-secret-entirely', request.init.headers['x-octo-signature'], request.init.body!, Math.floor(t.webhookClock.now / 1000))).toBe(false);
    expect((await reports()).find((r) => r.id === queued[0].id)!.status).toBe('succeeded');
    expect(await deliver()).toMatchObject({ claimed: 0 });
    await owner.caller.request('DELETE', `/v1/webhooks/${hook}`);
  });

  it('includes the transcript only for endpoints that opted in, and picks the most specific endpoint', async () => {
    const orgHook = await endpoint(owner, { url: 'https://hooks.example/org' });
    const assistantId = await assistant(owner, { summary: { enabled: true } });
    const assistantHook = await endpoint(owner, { url: 'https://hooks.example/assistant', scopeType: 'assistant', scopeId: assistantId, transcriptOptIn: true });
    const callId = await endedCall(owner, assistantId);
    const plain = await assistant(owner, { summary: { enabled: true } });
    const plainCall = await endedCall(owner, plain);
    await tick();
    const all = await reports();
    const specific = all.find((r) => r.call_id === callId)!;
    expect(specific.endpoint_id).toBe(assistantHook);
    expect(specific.payload.data.transcript).toHaveLength(4);
    expect(specific.payload.data.transcript[0]).toMatchObject({ kind: 'speech', role: 'assistant', seq: 1, startOffsetMs: 0 });
    expect(specific.payload.data.transcript[2]).toMatchObject({ kind: 'tool-call', toolCall: { name: 'bookAppointment' } });
    const general = all.find((r) => r.call_id === plainCall)!;
    expect(general.endpoint_id).toBe(orgHook);
    expect(general.payload.data).not.toHaveProperty('transcript');
    // A call-scoped endpoint beats both
    const call2 = await endedCall(owner, assistantId);
    const callHook = await endpoint(owner, { url: 'https://hooks.example/call', scopeType: 'call', scopeId: call2 });
    await tick();
    expect((await reports()).find((r) => r.call_id === call2)!.endpoint_id).toBe(callHook);
    for (const id of [orgHook, assistantHook, callHook]) await owner.caller.request('DELETE', `/v1/webhooks/${id}`);
  });

  it('queues nothing when no endpoint subscribes to the event', async () => {
    const hook = await endpoint(owner, { url: 'https://hooks.example/other', events: ['status-update'] });
    const callId = await endedCall(owner, await assistant(owner, { summary: { enabled: true } }));
    await tick();
    expect((await reports()).filter((r) => r.call_id === callId)).toHaveLength(0);
    expect((await analysisOf(owner, callId)).status).toBe('succeeded');
    await owner.caller.request('DELETE', `/v1/webhooks/${hook}`);
  });

  it('retries a failing receiver with backoff and gives up after the last attempt', async () => {
    const hook = await endpoint(owner, { url: 'https://hooks.example/down' });
    const callId = await endedCall(owner, await assistant(owner, { summary: { enabled: true } }));
    await tick();
    http.statuses = Array.from({ length: 10 }, () => 500);
    const delays = [30, 120, 600, 1800, 3600, 10800, 21600];
    for (const [i, seconds] of delays.entries()) {
      expect(await deliver(), `attempt ${i + 1}`).toMatchObject({ claimed: 1, retried: 1 });
      const row = (await t.db.query<any>(`SELECT status, attempts, response_status, last_error, response_body, next_attempt_at FROM webhook_delivery WHERE call_id = $1`, [callId])).rows[0];
      expect(row).toMatchObject({ status: 'failed', attempts: i + 1, response_status: 500, last_error: 'HTTP 500', response_body: 'receiver said no' });
      expect(new Date(row.next_attempt_at).getTime() - t.webhookClock.now).toBe(seconds * 1000);
      t.webhookClock.now += seconds * 1000 - 1000;
      expect((await deliver()).claimed).toBe(0); // not before it is due
      t.webhookClock.now += 1000;
    }
    expect(await deliver()).toMatchObject({ claimed: 1, dead: 1 });
    expect((await t.db.query<any>(`SELECT status, attempts FROM webhook_delivery WHERE call_id = $1`, [callId])).rows[0]).toEqual({ status: 'dead', attempts: 8 });
    expect((await deliver()).claimed).toBe(0);
    expect(http.requests).toHaveLength(8);
    await owner.caller.request('DELETE', `/v1/webhooks/${hook}`);
  });

  it('recovers a delivery whose worker died mid-send, and succeeds when the receiver recovers', async () => {
    const hook = await endpoint(owner, { url: 'https://hooks.example/flaky' });
    const callId = await endedCall(owner, await assistant(owner, { summary: { enabled: true } }));
    await tick();
    await t.db.query(`UPDATE webhook_delivery SET status = 'delivering', attempts = 1, next_attempt_at = $2::timestamptz WHERE call_id = $1`, [callId, new Date(t.webhookClock.now + 60_000).toISOString()]);
    expect((await deliver()).claimed).toBe(0);
    t.webhookClock.now += 61_000;
    expect(await deliver()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await t.db.query<any>(`SELECT status, attempts FROM webhook_delivery WHERE call_id = $1`, [callId])).rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
    await owner.caller.request('DELETE', `/v1/webhooks/${hook}`);
  });

  it('gives up at once on a deleted or disabled endpoint, and leaves chat events alone', async () => {
    const hook = await endpoint(owner, { url: 'https://hooks.example/disabled', events: ['end-of-call-report', 'chat.started'] });
    const chatAssistant = await assistant(owner, {});
    expect((await owner.caller.request('POST', '/v1/chat', { assistantId: chatAssistant, message: 'hello there' })).statusCode).toBe(200);
    const callId = await endedCall(owner, await assistant(owner, { summary: { enabled: true } }));
    await tick();
    await owner.caller.request('PATCH', `/v1/webhooks/${hook}`, { enabled: false });
    // A chat event waiting for manual redelivery must not be touched by the worker
    const chat = await t.db.query<{ id: string }>(`SELECT id FROM webhook_delivery WHERE call_id IS NULL AND status = 'pending' AND org_id = $1`, [owner.orgId]);
    expect(chat.rows.length).toBeGreaterThan(0);
    expect(await deliver()).toMatchObject({ claimed: 1, dead: 1 });
    expect((await t.db.query<any>(`SELECT status, last_error FROM webhook_delivery WHERE call_id = $1`, [callId])).rows[0]).toMatchObject({ status: 'dead', last_error: 'The webhook endpoint is disabled' });
    expect(http.requests).toHaveLength(0);
    for (const row of chat.rows) expect((await t.db.query<any>('SELECT status FROM webhook_delivery WHERE id = $1', [row.id])).rows[0].status).toBe('pending');
    await owner.caller.request('DELETE', `/v1/webhooks/${hook}`);
  });

  it('refuses to deliver to private addresses (the default client is SSRF-guarded)', async () => {
    const guarded = await createTestApp({ env: {} });
    try {
      const who = await signUp(guarded, { orgName: 'Guarded Org' });
      const res = await who.caller.request('POST', '/v1/webhooks', { url: 'https://127.0.0.1/hook', secret: 'a-long-enough-secret', events: ['end-of-call-report'] });
      expect(res.statusCode).toBe(201);
      const assistantRes = json(await who.caller.request('POST', '/v1/assistants', { name: 'G', config: { firstMessage: 'Hi', analysis: { summary: { enabled: true } } } }));
      const callId = newId();
      await guarded.ctx.tenants.withOrg(who.orgId, async (tx) => {
        await tx.query(
          `INSERT INTO call (id, org_id, type, assistant_id, config_source, assistant_name, config, config_schema, status, created_by_type, direction) VALUES ($1, $2, 'web', $3, 'draft', 'G', '{}'::jsonb, 1, 'ended', 'user', 'web')`,
          [callId, who.orgId, assistantRes.id]
        );
        await enqueueAnalysis(tx, who.orgId, callId, new Date());
      });
      guarded.analysisClock.now = Date.now() + 1000;
      await guarded.ctx.analysis.tick();
      guarded.webhookClock.now = Date.now() + 2000;
      const result = await guarded.ctx.webhookDelivery.tick();
      expect(result).toMatchObject({ claimed: 1, retried: 1 });
      const row = (await guarded.db.query<any>('SELECT status, last_error FROM webhook_delivery WHERE call_id = $1', [callId])).rows[0];
      expect(row.status).toBe('failed');
      expect(row.last_error).toMatch(/private or reserved range/);
    } finally {
      await guarded.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------- isolation and access

describe('access and isolation', () => {
  it("keeps one org's structured outputs, analyses and usage away from another", async () => {
    const id = await structuredOutput(owner, `Private ${newId()}`);
    expect((await other.caller.request('GET', `/v1/structured-outputs/${id}`)).statusCode).toBe(404);
    expect((await other.caller.request('PATCH', `/v1/structured-outputs/${id}`, { name: 'Hijacked' })).statusCode).toBe(404);
    expect((await other.caller.request('DELETE', `/v1/structured-outputs/${id}`)).statusCode).toBe(404);
    expect(json(await other.caller.request('GET', '/v1/structured-outputs?limit=100')).data.map((o: { id: string }) => o.id)).not.toContain(id);
    expect(json(await owner.caller.request('GET', `/v1/structured-outputs/${id}`)).name).toMatch(/^Private/);

    for (const table of ['structured_output', 'call_analysis']) {
      const rows = await t.ctx.tenants.withOrg(owner.orgId, async (tx) => (await tx.query<{ org_id: string }>(`SELECT org_id FROM ${table}`)).rows);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.org_id, table).toBe(owner.orgId);
    }
    await expect(
      t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`INSERT INTO structured_output (id, org_id, name, schema) VALUES (gen_random_uuid(), $1, 'x', '{"type":"object"}'::jsonb)`, [other.orgId]))
    ).rejects.toThrow(/row-level security/);
    const hijack = await t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`UPDATE call_analysis SET summary = 'x' WHERE org_id = $1`, [other.orgId]));
    expect(hijack.rowCount).toBe(0);
  });

  it('lets viewers read calls, analysis and search, but not rerun an analysis', async () => {
    const viewer = await addMember(t, owner, 'viewer');
    const callId = await endedCall(owner, await assistant(owner, { summary: { enabled: true } }));
    await tick();
    expect((await viewer.caller.request('GET', '/v1/calls')).statusCode).toBe(200);
    expect((await viewer.caller.request('GET', `/v1/calls/${callId}/analysis`)).statusCode).toBe(200);
    expect((await viewer.caller.request('GET', '/v1/transcripts/search?q=appointment')).statusCode).toBe(200);
    expect((await viewer.caller.request('POST', `/v1/calls/${callId}/analysis`)).statusCode).toBe(403);
  });
});
