/**
 * Campaigns end to end against the real app, real migrations (PGlite) and a scripted telephony
 * provider: CSV import, the dialer (schedule in the contact's zone, pacing, concurrency, do-not-call,
 * restart safety), retry rules, controls, results, and org isolation.
 *
 * The clock is `t.dialerClock`: Monday 2026-10-05 04:00 UTC = 10:00 in Dhaka (UTC+6) = 00:00 in New York (UTC-4).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelephonyAdapter } from '../../../packages/engine/src/telephony/fake.ts';
import { TelephonyDialError, type OutboundCallRequest, type TelephonyCall } from '../../../packages/engine/src/telephony/types.ts';
import { CampaignDialer } from '../src/services/campaigns/dialer.ts';
import { campaignHooksForCall } from '../src/services/campaigns/hooks.ts';
import { addMember, createKey, createTestApp, json, keyCaller, signUp, type SignedUp, type TestApp } from './helpers.ts';

/** A provider whose next dials can be scripted to fail or hang. */
class ScriptedAdapter extends FakeTelephonyAdapter {
  /** Dials run in parallel, so scripts are keyed by the number dialed, or taken in order when `to` is unscripted. */
  byNumber = new Map<string, () => Promise<TelephonyCall>>();
  script: ((request: OutboundCallRequest) => Promise<TelephonyCall>)[] = [];
  override async startOutbound(request: OutboundCallRequest): Promise<TelephonyCall> {
    const keyed = this.byNumber.get(request.to);
    if (keyed) return keyed();
    const next = this.script.shift();
    return next ? next(request) : super.startOutbound(request);
  }
}

const MON = Date.parse('2026-10-05T04:00:00Z');
const MINUTE = 60_000;

let t: TestApp;
let owner: SignedUp;
let fake: ScriptedAdapter;
let assistantId: string;
let phoneId: string;
let phone2Id: string;

async function publishedAssistant(who: SignedUp, name = 'Campaign agent'): Promise<string> {
  const created = json(await who.caller.request('POST', '/v1/assistants', { name, config: { firstMessage: 'Hello {{first_name}}, this is Octo.' } }));
  expect((await who.caller.request('POST', `/v1/assistants/${created.id}/publish`, {})).statusCode).toBe(201);
  return created.id;
}

async function importNumber(who: SignedUp, e164: string, provider: 'sip' | 'twilio' = 'sip'): Promise<string> {
  const res = await who.caller.request('POST', '/v1/phone-numbers/import', { provider, e164 });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).id;
}

const schedule = { startDate: '2026-10-05', endDate: '2026-10-30', allowedDays: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '17:00', defaultTimeZone: 'Asia/Dhaka' };
const body = (over: Record<string, unknown> = {}) => ({
  name: 'Autumn outreach',
  assistantId,
  phoneNumberIds: [phoneId],
  schedule,
  maxConcurrentCalls: 5,
  callsPerMinute: 60,
  retry: { maxRetries: 2, delayMinutes: 60 },
  ...over,
});
const num = (n: number) => `+88018110${String(n).padStart(5, '0')}`;
const csvOf = (...rows: string[]) => ['phone,first_name,timezone', ...rows].join('\n');
const bdRows = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `${num(from + i)},Person${from + i},`);

async function create(over: Record<string, unknown> = {}, who = owner): Promise<string> {
  const res = await who.caller.request('POST', '/v1/campaigns', body(over));
  expect(res.statusCode, res.body).toBe(201);
  return json(res).id;
}
async function upload(id: string, csv: string, extra: Record<string, unknown> = {}, who = owner) {
  const res = await who.caller.request('POST', `/v1/campaigns/${id}/contacts`, { csv, ...extra });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return json(res);
}
async function running(over: Record<string, unknown> = {}, csv = csvOf(...bdRows(3))): Promise<string> {
  const id = await create(over);
  await upload(id, csv);
  const started = await owner.caller.request('POST', `/v1/campaigns/${id}/start`);
  expect(started.statusCode, started.body).toBe(200);
  return id;
}
const tick = () => t.ctx.campaigns.tick();
const attempts = async (campaignId: string) =>
  (
    await t.db.query<{ id: string; attempt_no: number; status: string; outcome: string | null; provider_call_id: string | null; call_id: string; e164: string }>(
      `SELECT a.id, a.attempt_no, a.status, a.outcome, a.provider_call_id, a.call_id, c.e164 FROM campaign_attempt a JOIN campaign_contact c ON c.id = a.contact_id
       WHERE a.campaign_id = $1 ORDER BY a.claimed_at, c.e164, a.attempt_no`,
      [campaignId]
    )
  ).rows;
const contact = async (campaignId: string, e164: string) =>
  (await t.db.query<{ status: string; attempts: number; last_outcome: string | null; next_attempt_at: Date | null; outcome_label: string | null; last_call_id: string | null }>('SELECT * FROM campaign_contact WHERE campaign_id = $1 AND e164 = $2', [campaignId, e164])).rows[0];
const campaignStatus = async (id: string) => json(await owner.caller.request('GET', `/v1/campaigns/${id}`)).status as string;
const callback = (attemptId: string, payload: Record<string, unknown>, provider = 'sip') => t.app.inject({ method: 'POST', url: `/v1/telephony/${provider}/status/${attemptId}`, payload });
/** The provider reports a call's progress; the CallSid is the one the dial returned. */
async function report(campaignId: string, e164: string, payload: Record<string, unknown>) {
  const a = (await attempts(campaignId)).filter((x) => x.e164 === e164).at(-1)!;
  return callback(a.id, { CallSid: a.provider_call_id, ...payload });
}
const dialedNumbers = () => fake.outbound.map((o) => o.to);
const at = (iso: string) => void (t.dialerClock.now = Date.parse(iso));

beforeAll(async () => {
  t = await createTestApp({ env: { MAX_CONCURRENT_CALLS_PER_ORG: '6' } });
  owner = await signUp(t, { orgName: 'Campaign Org' });
  fake = new ScriptedAdapter();
  t.ctx.telephony.adapters.sip = fake;
  assistantId = await publishedAssistant(owner);
  phoneId = await importNumber(owner, '+8801712345678');
  phone2Id = await importNumber(owner, '+8801712345679');
}, 60_000);
afterAll(async () => t.close());

beforeEach(() => {
  t.dialerClock.now = MON;
});
afterEach(async () => {
  // Nothing from one test keeps dialing, or holding concurrency slots, in the next
  await t.db.query(`UPDATE campaign SET status = 'cancelled' WHERE status IN ('draft', 'running', 'paused')`);
  await t.db.query(`UPDATE campaign_attempt SET status = 'done', outcome = 'lost', ended_at = now() WHERE status IN ('claimed', 'dialing', 'ringing', 'in-progress')`);
  await t.db.query(`UPDATE call SET status = 'failed' WHERE campaign_id IS NOT NULL AND status IN ('queued', 'ringing', 'in-progress')`);
  await t.db.query('DELETE FROM do_not_call WHERE org_id = $1', [owner.orgId]);
  fake.outbound.length = 0;
  fake.script.length = 0;
  fake.byNumber.clear();
  fake.verifyResult = true;
  fake.voicemail = false;
});

// ---------------------------------------------------------------- the resource

describe('campaign resource', () => {
  it('creates a draft with the schedule in contact time and the effective calling hours', async () => {
    const res = await owner.caller.request('POST', '/v1/campaigns', body({ disclosureText: 'This is an AI assistant calling on behalf of Octo.', outcomeLabels: ['interested', 'no'], successLabels: ['interested'], defaultCountry: 'BD' }));
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      name: 'Autumn outreach',
      status: 'draft',
      assistantId,
      squadId: null,
      phoneNumberIds: [phoneId],
      schedule: { ...schedule, effectiveWindow: { start: '09:00', end: '17:00' } },
      maxConcurrentCalls: 5,
      callsPerMinute: 60,
      retry: { maxRetries: 2, delayMinutes: 60 },
      defaultCountry: 'BD',
      disclosureText: 'This is an AI assistant calling on behalf of Octo.',
      successLabels: ['interested'],
    });
    const id = json(res).id;
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${id}`)).id).toBe(id);
    expect(json(await owner.caller.request('GET', '/v1/campaigns?status=draft')).data.map((c: { id: string }) => c.id)).toContain(id);
    expect(json(await owner.caller.request('GET', '/v1/campaigns?status=running')).data.map((c: { id: string }) => c.id)).not.toContain(id);
  });

  it('cuts the window to the platform calling hours', async () => {
    const res = await owner.caller.request('POST', '/v1/campaigns', body({ schedule: { ...schedule, windowStart: '06:00', windowEnd: '22:30' } }));
    expect(json(res).schedule.effectiveWindow).toEqual({ start: '08:00', end: '21:00' });
    const outside = await owner.caller.request('POST', '/v1/campaigns', body({ schedule: { ...schedule, windowStart: '21:30', windowEnd: '23:00' } }));
    expect(outside.statusCode).toBe(400);
    expect(json(outside).details.issues[0].message).toContain('platform calling hours');
  });

  it.each([
    ['a window that ends before it starts', { schedule: { ...schedule, windowStart: '17:00', windowEnd: '09:00' } }, 'schedule.windowEnd'],
    ['an end date before the start date', { schedule: { ...schedule, endDate: '2026-10-01' } }, 'schedule.endDate'],
    ['a repeated weekday', { schedule: { ...schedule, allowedDays: [1, 1] } }, 'schedule.allowedDays'],
    ['an unknown time zone', { schedule: { ...schedule, defaultTimeZone: 'Mars/Base' } }, 'schedule.defaultTimeZone'],
    ['both an assistant and a squad', { squadId: '00000000-0000-4000-8000-000000000001' }, 'assistantId'],
    ['no assistant or squad', { assistantId: undefined }, 'assistantId'],
    ['a success label that is not an outcome label', { outcomeLabels: ['a'], successLabels: ['b'] }, 'successLabels'],
    ['a pace above the limit', { callsPerMinute: 601 }, 'callsPerMinute'],
    ['no phone numbers', { phoneNumberIds: [] }, 'phoneNumberIds'],
    ['a phone number that is not ours', { phoneNumberIds: ['00000000-0000-4000-8000-000000000002'] }, 'phoneNumberIds.0'],
    ['an unknown field', { callsPerHour: 5 }, ''],
  ])('refuses %s', async (_label, over, path) => {
    const res = await owner.caller.request('POST', '/v1/campaigns', body(over));
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('validation_error');
    if (path) expect(json(res).details.issues.map((i: { path: string }) => i.path)).toContain(path);
  });

  it('edits a draft or paused campaign, but not a running one, and only a draft may change its assistant', async () => {
    const id = await create();
    const patched = await owner.caller.request('PATCH', `/v1/campaigns/${id}`, { name: 'Renamed', schedule: { windowEnd: '18:00' }, retry: { delayMinutes: 120 }, phoneNumberIds: [phoneId, phone2Id] });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(json(patched)).toMatchObject({ name: 'Renamed', schedule: { windowStart: '09:00', windowEnd: '18:00' }, retry: { maxRetries: 2, delayMinutes: 120 }, phoneNumberIds: [phoneId, phone2Id] });
    expect((await owner.caller.request('PATCH', `/v1/campaigns/${id}`, { schedule: { windowEnd: '08:30' } })).statusCode).toBe(400);

    await upload(id, csvOf(...bdRows(1)));
    await owner.caller.request('POST', `/v1/campaigns/${id}/start`);
    const running = await owner.caller.request('PATCH', `/v1/campaigns/${id}`, { name: 'Too late' });
    expect(running.statusCode).toBe(409);
    await owner.caller.request('POST', `/v1/campaigns/${id}/pause`);
    expect((await owner.caller.request('PATCH', `/v1/campaigns/${id}`, { callsPerMinute: 10 })).statusCode).toBe(200);
    expect((await owner.caller.request('PATCH', `/v1/campaigns/${id}`, { assistantId })).statusCode).toBe(409);
  });

  it('deletes only a draft; a campaign that has run is kept for its results', async () => {
    const draft = await create();
    await upload(draft, csvOf(...bdRows(2)));
    expect((await owner.caller.request('DELETE', `/v1/campaigns/${draft}`)).statusCode).toBe(204);
    expect((await owner.caller.request('GET', `/v1/campaigns/${draft}`)).statusCode).toBe(404);
    expect((await t.db.query('SELECT 1 FROM campaign_contact WHERE campaign_id = $1', [draft])).rowCount).toBe(0);
    const id = await running();
    expect((await owner.caller.request('DELETE', `/v1/campaigns/${id}`)).statusCode).toBe(409);
  });

  it('is created once per Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'campaign-key-1' };
    const first = await owner.caller.request('POST', '/v1/campaigns', body({ name: 'Once' }), headers);
    const second = await owner.caller.request('POST', '/v1/campaigns', body({ name: 'Once' }), headers);
    expect(second.statusCode).toBe(201);
    expect(json(second).id).toBe(json(first).id);
    expect((await t.db.query(`SELECT 1 FROM campaign WHERE name = 'Once'`)).rowCount).toBe(1);
  });

  it('follows the state machine and refuses a start that could not dial', async () => {
    const id = await create();
    const post = async (action: string) => owner.caller.request('POST', `/v1/campaigns/${id}/${action}`);
    expect(json(await post('start')).details.reason).toBe('no_contacts');
    await upload(id, csvOf(...bdRows(1)));
    expect((await post('pause')).statusCode).toBe(409);
    expect((await post('resume')).statusCode).toBe(409);
    expect(json(await post('start')).status).toBe('running');
    expect((await post('start')).statusCode).toBe(409);
    expect(json(await post('pause')).status).toBe('paused');
    expect(json(await post('resume')).status).toBe('running');
    expect(json(await post('cancel')).status).toBe('cancelled');
    for (const action of ['start', 'pause', 'resume', 'cancel']) expect((await post(action)).statusCode, action).toBe(409);
  });

  it('will not start without a published assistant, a usable number, or time left in the schedule', async () => {
    const draftOnly = json(await owner.caller.request('POST', '/v1/assistants', { name: 'Unpublished', config: { firstMessage: 'Hi {{first_name}}' } })).id;
    const unpublished = await create({ assistantId: draftOnly });
    await upload(unpublished, csvOf(...bdRows(1)));
    expect(json(await owner.caller.request('POST', `/v1/campaigns/${unpublished}/start`)).message).toContain('no published version');

    const expired = await create({ schedule: { ...schedule, startDate: '2026-09-01', endDate: '2026-09-30' } });
    await upload(expired, csvOf(...bdRows(1)));
    expect(json(await owner.caller.request('POST', `/v1/campaigns/${expired}/start`)).details.reason).toBe('schedule_ended');

    const released = await importNumber(owner, '+8801712345600');
    const noNumber = await create({ phoneNumberIds: [released] });
    await upload(noNumber, csvOf(...bdRows(1)));
    expect((await owner.caller.request('DELETE', `/v1/phone-numbers/${released}`)).statusCode).toBe(204);
    expect(json(await owner.caller.request('POST', `/v1/campaigns/${noNumber}/start`)).details.reason).toBe('no_active_phone_number');
  });
});

// ---------------------------------------------------------------- contacts

describe('contact upload', () => {
  it('saves valid rows and reports every bad row with its line and reason', async () => {
    const id = await create({ defaultCountry: 'BD' });
    const csv = [
      'phone,first_name,timezone',
      `${num(1)},Asha,`, // 2: ok
      '12345,Bad,', // 3: not E.164
      `${num(1)},Dup,`, // 4: duplicate of line 2
      `${num(2)},,`, // 5: missing {{first_name}}
      `${num(3)},Zed,Mars/Base`, // 6: bad zone
      '01711000009,Rafi,', // 7: national BD number accepted
      '+12125550100,Nina,America/New_York', // 8: ok, own zone
      ',Nobody,', // 9: empty phone
    ].join('\n');
    const report = await upload(id, csv);
    expect(report).toMatchObject({ dryRun: false, totalRows: 8, imported: 3, rejectedCount: 5 });
    expect(report.rejected.map((r: { row: number }) => r.row)).toEqual([3, 4, 5, 6, 9]);
    expect(report.rejected[1].reason).toBe('Duplicate of row 2');
    expect(report.rejected[2].reason).toContain('{{first_name}}');
    expect(report.rejected[3].reason).toContain('time zone');

    const list = json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?limit=10`));
    const byNumber = Object.fromEntries(list.data.map((c: { number: string }) => [c.number, c]));
    expect(Object.keys(byNumber).sort()).toEqual(['+12125550100', '+8801711000009', num(1)]);
    expect(byNumber['+12125550100']).toMatchObject({ name: null, timeZone: 'America/New_York', status: 'pending', attempts: 0, variables: { first_name: 'Nina' } });
    expect(byNumber['+8801711000009'].timeZone).toBe('Asia/Dhaka');
  });

  it('maps CSV columns to {{variables}}', async () => {
    const id = await create();
    const csv = 'Mobile Number,Given name,Full name\n' + `${num(1)},Asha,Asha Rahman`;
    const report = await upload(id, csv, { mapping: { phone: 'Mobile Number', variables: { first_name: 'Given name' }, name: 'Full name' } });
    expect(report.imported).toBe(1);
    const c = json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts`)).data[0];
    expect(c).toMatchObject({ name: 'Asha Rahman', variables: { first_name: 'Asha', customer_name: 'Asha Rahman' } });
    const bad = await owner.caller.request('POST', `/v1/campaigns/${id}/contacts`, { csv, mapping: { phone: 'Nope' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).details.issues[0].path).toBe('csv');
  });

  it('validates without saving on a dry run, and a repeated upload adds nobody twice', async () => {
    const id = await create();
    const csv = csvOf(...bdRows(3));
    const dry = await upload(id, csv, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, imported: 3, rejectedCount: 0 });
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts`)).data).toHaveLength(0);
    expect((await upload(id, csv)).imported).toBe(3);
    const again = await upload(id, csv);
    expect(again).toMatchObject({ imported: 0, rejectedCount: 3 });
    expect(again.rejected.every((r: { reason: string }) => r.reason === 'Already in this campaign')).toBe(true);
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${id}/stats`)).contacts.total).toBe(3);
  });

  it('keeps numbers from the do-not-call list out of a new upload', async () => {
    await owner.caller.request('POST', '/v1/do-not-call', { numbers: [num(2)] });
    const id = await create();
    const report = await upload(id, csvOf(...bdRows(3)));
    expect(report.imported).toBe(2);
    expect(report.rejected).toEqual([{ row: 3, value: num(2), reason: 'On the do-not-call list' }]);
  });

  it('refuses a file with no phone column, and uploads to a finished campaign', async () => {
    const id = await create();
    const noPhone = await owner.caller.request('POST', `/v1/campaigns/${id}/contacts`, { csv: 'name,city\nAsha,Dhaka' });
    expect(noPhone.statusCode).toBe(400);
    expect(json(noPhone).details.issues[0].message).toContain('No phone column');
    await owner.caller.request('POST', `/v1/campaigns/${id}/cancel`);
    expect((await owner.caller.request('POST', `/v1/campaigns/${id}/contacts`, { csv: csvOf(...bdRows(1)) })).statusCode).toBe(409);
  });

  it('filters and pages the contact list', async () => {
    const id = await create();
    await upload(id, csvOf(...bdRows(5)));
    const first = json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?limit=2`));
    expect(first.data).toHaveLength(2);
    const second = json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?limit=2&cursor=${first.nextCursor}`));
    expect(second.data).toHaveLength(2);
    expect(new Set([...first.data, ...second.data].map((c: { id: string }) => c.id)).size).toBe(4);
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?status=completed`)).data).toHaveLength(0);
    expect((await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?status=weird`)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- dialing

describe('dialer', () => {
  it('dials due contacts with a status callback, a call row, their variables, and the disclosure line', async () => {
    const disclosure = 'This is an AI assistant calling on behalf of Octo.';
    const id = await running({ disclosureText: disclosure, outcomeLabels: ['interested'] }, csvOf(...bdRows(2)));
    expect(await tick()).toMatchObject({ claimed: 2, dialed: 2, released: 0 });
    expect(dialedNumbers().sort()).toEqual([num(1), num(2)]);
    const rows = await attempts(id);
    expect(rows.map((a) => [a.attempt_no, a.status])).toEqual([[1, 'ringing'], [1, 'ringing']]);
    const request = fake.outbound[0];
    expect(request.statusCallbackUrl).toBe(`http://127.0.0.1:3300/v1/telephony/sip/status/${rows.find((a) => a.e164 === request.to)!.id}`);
    expect(request.from.e164).toBe('+8801712345678');
    expect(request.voicemailDetection).toBe(true);

    const call = (await t.db.query<{ status: string; type: string; direction: string; customer_number: string; variable_values: Record<string, string>; config: { firstMessage: string; firstMessageMode: string }; provider_call_id: string; campaign_id: string }>('SELECT * FROM call WHERE id = $1', [rows[0].call_id])).rows[0];
    expect(call).toMatchObject({ status: 'ringing', type: 'outbound', direction: 'outbound', campaign_id: id });
    expect(call.config.firstMessage).toBe(`${disclosure} Hello {{first_name}}, this is Octo.`);
    expect(call.config.firstMessageMode).toBe('assistant-speaks-first');
    expect(call.variable_values.first_name).toMatch(/^Person[12]$/);
    expect(call.provider_call_id).toBe(rows[0].provider_call_id);
    expect(await contact(id, num(1))).toMatchObject({ status: 'calling', attempts: 1 });
  });

  it('leaves the assistant first message alone without a disclosure', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const config = (await t.db.query<{ config: { firstMessage: string } }>('SELECT config FROM call WHERE campaign_id = $1', [id])).rows[0].config;
    expect(config.firstMessage).toBe('Hello {{first_name}}, this is Octo.');
  });

  it('keeps to the campaign concurrency limit and fills slots as calls end', async () => {
    const id = await running({ maxConcurrentCalls: 2, callsPerMinute: 600 }, csvOf(...bdRows(5)));
    expect((await tick()).dialed).toBe(2);
    expect((await tick()).dialed).toBe(0);
    expect(fake.outbound).toHaveLength(2);
    const first = (await attempts(id))[0];
    expect((await report(id, first.e164, { CallStatus: 'completed', CallDuration: '30', AnsweredBy: 'human' })).statusCode).toBe(200);
    expect((await tick()).dialed).toBe(1);
    expect(fake.outbound).toHaveLength(3);
    expect(new Set(dialedNumbers()).size).toBe(3);
  });

  it('paces calls per minute', async () => {
    await running({ maxConcurrentCalls: 10, callsPerMinute: 2 }, csvOf(...bdRows(6)));
    expect((await tick()).dialed).toBe(1);
    expect((await tick()).dialed).toBe(1);
    expect((await tick()).dialed).toBe(0);
    t.dialerClock.now += 30_000;
    expect((await tick()).dialed).toBe(0);
    t.dialerClock.now += 31_000;
    expect((await tick()).dialed).toBe(1);
    expect(fake.outbound).toHaveLength(3);
  });

  it('keeps to the org concurrency limit across campaigns', async () => {
    await running({ name: 'X', maxConcurrentCalls: 5, callsPerMinute: 600 }, csvOf(...bdRows(8)));
    await running({ name: 'Y', maxConcurrentCalls: 5, callsPerMinute: 600 }, csvOf(...bdRows(8, 100)));
    expect((await tick()).dialed).toBe(6);
    expect((await tick()).dialed).toBe(0);
    expect(fake.outbound).toHaveLength(6);
  });

  it('rotates through the campaign phone numbers', async () => {
    await running({ phoneNumberIds: [phoneId, phone2Id], maxConcurrentCalls: 4 }, csvOf(...bdRows(4)));
    await tick();
    expect(fake.outbound.map((o) => o.from.e164).sort()).toEqual(['+8801712345678', '+8801712345678', '+8801712345679', '+8801712345679']);
  });

  it('calls each contact only inside the campaign hours of THEIR time zone', async () => {
    const csv = csvOf(`${num(1)},Dhaka,`, '+12125550100,NewYork,America/New_York', '+12125550101,Dhaka-zone-in-NY,Asia/Dhaka');
    const id = await running({}, csv);
    // 10:00 in Dhaka, 00:00 in New York
    expect(await tick()).toMatchObject({ claimed: 2 });
    expect(dialedNumbers().sort()).toEqual(['+12125550101', num(1)]);
    const ny = await contact(id, '+12125550100');
    expect(ny.status).toBe('pending');
    expect(ny.next_attempt_at?.toISOString()).toBe('2026-10-05T13:00:00.000Z'); // 09:00 EDT
    // Still the same night in New York: not dialed
    at('2026-10-05T12:59:00Z');
    expect((await tick()).claimed).toBe(0);
    at('2026-10-05T13:00:00Z');
    expect((await tick()).dialed).toBe(1);
    expect(dialedNumbers().at(-1)).toBe('+12125550100');
  });

  it('never dials outside the platform calling hours, even when the campaign allows them', async () => {
    const id = await running({ schedule: { ...schedule, windowStart: '06:00', windowEnd: '23:00' } }, csvOf(...bdRows(1)));
    at('2026-10-05T00:30:00Z'); // 06:30 Dhaka
    expect((await tick()).claimed).toBe(0);
    at('2026-10-05T15:30:00Z'); // 21:30 Dhaka
    expect((await tick()).claimed).toBe(0);
    expect(fake.outbound).toHaveLength(0);
    expect((await contact(id, num(1))).next_attempt_at?.toISOString()).toBe('2026-10-06T02:00:00.000Z'); // 08:00 Dhaka next day
    at('2026-10-06T02:00:00Z');
    expect((await tick()).dialed).toBe(1);
  });

  it('waits for allowed weekdays and the start date, and gives up after the end date', async () => {
    const id = await running({ schedule: { ...schedule, startDate: '2026-10-07' } }, csvOf(...bdRows(1)));
    expect((await tick()).claimed).toBe(0); // Monday, before the start date
    expect((await contact(id, num(1))).next_attempt_at?.toISOString()).toBe('2026-10-07T03:00:00.000Z');
    at('2026-10-10T04:00:00Z'); // Saturday
    await t.db.query('UPDATE campaign_contact SET next_attempt_at = NULL WHERE campaign_id = $1', [id]);
    expect((await tick()).claimed).toBe(0);
    expect((await contact(id, num(1))).next_attempt_at?.toISOString()).toBe('2026-10-12T03:00:00.000Z'); // Monday 09:00
    at('2026-11-01T00:00:00Z');
    await tick();
    expect((await contact(id, num(1)))).toMatchObject({ status: 'expired', last_outcome: 'schedule-ended' });
    expect(await campaignStatus(id)).toBe('completed');
    expect(fake.outbound).toHaveLength(0);
  });

  it('checks the do-not-call list when claiming, and again right before the dial', async () => {
    const id = await running({ maxConcurrentCalls: 5 }, csvOf(...bdRows(3)));
    await owner.caller.request('POST', '/v1/do-not-call', { numbers: [num(1)] });
    // The number was added after the contact was uploaded: the list is checked at claim time
    expect(await tick()).toMatchObject({ claimed: 2, dialed: 2 });
    expect(dialedNumbers()).not.toContain(num(1));
    expect(await contact(id, num(1))).toMatchObject({ status: 'do_not_call', attempts: 0 });

    // Added between the claim and the dial: the pre-dial check stops it
    const id2 = await running({ name: 'Second' }, csvOf(...bdRows(2, 50)));
    const claims = await t.ctx.tenants.withOrg(owner.orgId, (tx) => t.ctx.campaigns.claim(tx, owner.orgId, new Date(t.dialerClock.now)));
    const second = claims.filter((c) => c.campaign.id === id2);
    expect(second).toHaveLength(2);
    await owner.caller.request('POST', '/v1/do-not-call', { numbers: [num(50)] });
    const before = fake.outbound.length;
    const dialed = await t.ctx.campaigns.dialClaims(second);
    expect(dialed).toEqual(second.map((c) => c.contact.e164 !== num(50)));
    expect(fake.outbound.length - before).toBe(1);
    expect(await contact(id2, num(50))).toMatchObject({ status: 'do_not_call', attempts: 0 });
  });

  it('blocks a call outside the allowed hours even if the clock moved after the claim', async () => {
    const id = await running({ maxConcurrentCalls: 5 }, csvOf(...bdRows(2)));
    const claims = await t.ctx.tenants.withOrg(owner.orgId, (tx) => t.ctx.campaigns.claim(tx, owner.orgId, new Date(t.dialerClock.now)));
    expect(claims).toHaveLength(2);
    at('2026-10-05T16:00:00Z'); // 22:00 Dhaka
    expect(await t.ctx.campaigns.dialClaims(claims)).toEqual([false, false]);
    expect(fake.outbound).toHaveLength(0);
    expect((await attempts(id)).map((a) => a.status)).toEqual(['skipped', 'skipped']);
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('does not dial a claim whose campaign was paused in the meantime', async () => {
    const id = await running({}, csvOf(...bdRows(2)));
    const claims = await t.ctx.tenants.withOrg(owner.orgId, (tx) => t.ctx.campaigns.claim(tx, owner.orgId, new Date(t.dialerClock.now)));
    await owner.caller.request('POST', `/v1/campaigns/${id}/pause`);
    expect(await t.ctx.campaigns.dialClaims(claims)).toEqual([false, false]);
    expect(fake.outbound).toHaveLength(0);
    await owner.caller.request('POST', `/v1/campaigns/${id}/resume`);
    expect((await tick()).dialed).toBe(2);
    expect(await contact(id, num(1))).toMatchObject({ attempts: 1 });
  });
});

// ---------------------------------------------------------------- controls

describe('controls', () => {
  it('pause stops new dials only; calls in progress finish and are recorded; resume carries on', async () => {
    const id = await running({ maxConcurrentCalls: 3, callsPerMinute: 600 }, csvOf(...bdRows(6)));
    expect((await tick()).dialed).toBe(3);
    await owner.caller.request('POST', `/v1/campaigns/${id}/pause`);
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(fake.outbound).toHaveLength(3);

    const first = (await attempts(id))[0];
    await report(id, first.e164, { CallStatus: 'in-progress', AnsweredBy: 'human' });
    await report(id, first.e164, { CallStatus: 'completed', CallDuration: '40', AnsweredBy: 'human' });
    expect(await contact(id, first.e164)).toMatchObject({ status: 'completed', last_outcome: 'answered' });
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(await campaignStatus(id)).toBe('paused');

    await owner.caller.request('POST', `/v1/campaigns/${id}/resume`);
    expect((await tick()).dialed).toBe(1);
    expect(fake.outbound).toHaveLength(4);
  });

  it('cancel stops all dialing, closes waiting contacts, and lets calls in flight finish', async () => {
    const id = await running({ maxConcurrentCalls: 2, callsPerMinute: 600 }, csvOf(...bdRows(5)));
    await tick();
    await owner.caller.request('POST', `/v1/campaigns/${id}/cancel`);
    const stats = json(await owner.caller.request('GET', `/v1/campaigns/${id}/stats`));
    expect(stats.contacts).toMatchObject({ pending: 0, calling: 2, cancelled: 3 });
    // A busy line would be retried in a live campaign; here the contact is closed
    const first = (await attempts(id))[0];
    await report(id, first.e164, { CallStatus: 'busy' });
    expect(await contact(id, first.e164)).toMatchObject({ status: 'cancelled', last_outcome: 'busy' });
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(fake.outbound).toHaveLength(2);
    expect(await campaignStatus(id)).toBe('cancelled');
  });

  it('completes by itself when no contact is left to call', async () => {
    const id = await running({}, csvOf(...bdRows(2)));
    await tick();
    for (const n of [1, 2]) await report(id, num(n), { CallStatus: 'completed', CallDuration: '20', AnsweredBy: 'human' });
    expect(await campaignStatus(id)).toBe('completed');
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${id}`)).completedAt).not.toBeNull();
  });

  it('pauses itself, spending no attempts, when its phone numbers were released', async () => {
    const number = await importNumber(owner, '+8801712345622');
    const id = await running({ phoneNumberIds: [number] });
    await owner.caller.request('DELETE', `/v1/phone-numbers/${number}`);
    await tick();
    const campaign = json(await owner.caller.request('GET', `/v1/campaigns/${id}`));
    expect(campaign).toMatchObject({ status: 'paused', statusReason: 'no-active-phone-number' });
    expect(fake.outbound).toHaveLength(0);
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('pauses itself when its assistant is deleted, and when the provider is not configured', async () => {
    const gone = await publishedAssistant(owner, 'Short-lived agent');
    const a = await running({ assistantId: gone }, csvOf(...bdRows(2)));
    expect((await owner.caller.request('DELETE', `/v1/assistants/${gone}`)).statusCode).toBe(204);
    await tick();
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${a}`))).toMatchObject({ status: 'paused', statusReason: 'assistant-unavailable' });
    expect(fake.outbound).toHaveLength(0);
    expect(await contact(a, num(1))).toMatchObject({ status: 'pending', attempts: 0 });

    // A Twilio number while the platform has no Twilio credentials
    const twilio = await importNumber(owner, '+8801712345633', 'twilio');
    const b = await running({ phoneNumberIds: [twilio], name: 'Twilio' }, csvOf(...bdRows(2, 10)));
    await tick();
    expect(json(await owner.caller.request('GET', `/v1/campaigns/${b}`))).toMatchObject({ status: 'paused', statusReason: 'telephony-not-configured' });
    expect(await contact(b, num(10))).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

// ---------------------------------------------------------------- never double-calling

describe('restart safety', () => {
  it('two dialers (a restart, or a second node) never dial the same attempt twice', async () => {
    const id = await running({ maxConcurrentCalls: 6, callsPerMinute: 600 }, csvOf(...bdRows(10)));
    const other = new CampaignDialer(t.ctx, t.app.log, () => new Date(t.dialerClock.now));
    await Promise.all([tick(), other.tick(), tick(), other.tick()]);
    await Promise.all([tick(), other.tick()]);
    expect(fake.outbound).toHaveLength(6);
    expect(new Set(dialedNumbers()).size).toBe(6);
    const rows = await attempts(id);
    expect(rows.filter((a) => a.status === 'ringing')).toHaveLength(6);
    expect(new Set(rows.map((a) => `${a.e164}#${a.attempt_no}`)).size).toBe(rows.length);
  });

  it('the database refuses a second live attempt with the same number', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const a = (await attempts(id))[0];
    await expect(
      t.db.query(
        `INSERT INTO campaign_attempt (id, org_id, campaign_id, contact_id, attempt_no, status, call_id, claimed_at)
         SELECT gen_random_uuid(), org_id, campaign_id, contact_id, attempt_no, 'claimed', gen_random_uuid(), now() FROM campaign_attempt WHERE id = $1`,
        [a.id]
      )
    ).rejects.toThrow(/campaign_attempt_once_idx|duplicate key/);
  });

  it('releases a claim nobody dialed (a crash before the dial) and dials it exactly once', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    const claims = await t.ctx.tenants.withOrg(owner.orgId, (tx) => t.ctx.campaigns.claim(tx, owner.orgId, new Date(t.dialerClock.now)));
    expect(claims).toHaveLength(1); // ...and the process dies here
    expect(await contact(id, num(1))).toMatchObject({ status: 'calling', attempts: 1 });
    expect((await tick()).claimed).toBe(0); // still fresh: another node may be about to dial it
    t.dialerClock.now += 2 * MINUTE;
    expect(await tick()).toMatchObject({ claimed: 1, dialed: 1 });
    expect(fake.outbound).toHaveLength(1);
    expect((await attempts(id)).map((a) => [a.attempt_no, a.status])).toEqual([[1, 'skipped'], [1, 'ringing']]);
    expect(await contact(id, num(1))).toMatchObject({ status: 'calling', attempts: 1 });
  });

  it('closes a dial that never reported back as unconfirmed, and never dials it again', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    // The process died after the provider request, before the provider id was saved
    await t.db.query(`UPDATE campaign_attempt SET status = 'dialing', provider_call_id = NULL WHERE campaign_id = $1`, [id]);
    t.dialerClock.now += 3 * MINUTE;
    await tick();
    expect((await attempts(id))[0]).toMatchObject({ status: 'done', outcome: 'unconfirmed' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'failed', last_outcome: 'unconfirmed' });
    t.dialerClock.now += 24 * 60 * MINUTE;
    await tick();
    expect(fake.outbound).toHaveLength(1);
    expect(await campaignStatus(id)).toBe('completed');
  });

  it('lets a late provider report correct an unconfirmed attempt', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    await t.db.query(`UPDATE campaign_attempt SET status = 'dialing', provider_call_id = NULL WHERE campaign_id = $1`, [id]);
    t.dialerClock.now += 3 * MINUTE;
    await tick();
    expect((await contact(id, num(1))).status).toBe('failed');
    const a = (await attempts(id))[0];
    const late = await callback(a.id, { CallSid: 'CA-late', CallStatus: 'completed', CallDuration: '25', AnsweredBy: 'human' });
    expect(late.statusCode).toBe(200);
    expect((await attempts(id))[0]).toMatchObject({ outcome: 'answered', provider_call_id: 'CA-late' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'completed', last_outcome: 'answered' });
    expect(fake.outbound).toHaveLength(1);
  });

  it('closes a call that never ended as lost, frees its slot, and does not retry it', async () => {
    const id = await running({ maxConcurrentCalls: 1 }, csvOf(...bdRows(2)));
    await tick();
    expect((await tick()).claimed).toBe(0); // the one slot is busy
    t.dialerClock.now += 121 * MINUTE;
    at('2026-10-05T06:10:00Z'); // keep the clock inside the window; the call is 2 h 10 min old
    await t.db.query(`UPDATE campaign_attempt SET dialed_at = '2026-10-05T04:00:00Z' WHERE campaign_id = $1`, [id]);
    await tick();
    const first = (await attempts(id))[0];
    expect(first).toMatchObject({ status: 'done', outcome: 'lost' });
    expect(await contact(id, first.e164)).toMatchObject({ status: 'failed', last_outcome: 'lost' });
    expect(fake.outbound).toHaveLength(2); // the freed slot went to the next contact
    expect((await t.db.query<{ status: string; end_reason: string }>('SELECT status, end_reason FROM call WHERE id = $1', [first.call_id])).rows[0]).toEqual({ status: 'failed', end_reason: 'call-lost' });
  });

  it('retries a provider server error, but not a rejected request, and never an unconfirmed one', async () => {
    const id = await running({ maxConcurrentCalls: 5 }, csvOf(...bdRows(3)));
    fake.byNumber.set(num(1), async () => { throw new TelephonyDialError('HTTP 503', 'no', 503); });
    fake.byNumber.set(num(2), async () => { throw new TelephonyDialError('HTTP 400 bad number', 'no', 400); });
    fake.byNumber.set(num(3), async () => { throw new TelephonyDialError('socket closed', 'maybe'); });
    await tick();
    const outcomes = Object.fromEntries((await attempts(id)).map((a) => [a.e164, a.outcome]));
    expect(outcomes).toEqual({ [num(1)]: 'dial-error', [num(2)]: 'failed', [num(3)]: 'unconfirmed' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await contact(id, num(1))).next_attempt_at?.toISOString()).toBe('2026-10-05T05:00:00.000Z');
    expect(await contact(id, num(2))).toMatchObject({ status: 'failed' });
    expect(await contact(id, num(3))).toMatchObject({ status: 'failed' });
    fake.byNumber.clear();
    t.dialerClock.now += 61 * MINUTE;
    await tick();
    expect(dialedNumbers()).toEqual([num(1)]); // only the server error is dialed again; the failed requests were never placed
  });
});

describe('dial timeout', () => {
  it('treats a provider that never answers as unconfirmed', async () => {
    const slow = await createTestApp({ env: { CAMPAIGN_DIAL_TIMEOUT_SECONDS: '1', MAX_CONCURRENT_CALLS_PER_ORG: '6' } });
    try {
      const who = await signUp(slow, { orgName: 'Slow Org' });
      const hang = new ScriptedAdapter();
      hang.script = [() => new Promise<TelephonyCall>(() => undefined)];
      slow.ctx.telephony.adapters.sip = hang;
      const assistant = await publishedAssistant(who);
      const number = await importNumber(who, '+8801712345690');
      slow.dialerClock.now = MON;
      const created = json(await who.caller.request('POST', '/v1/campaigns', body({ assistantId: assistant, phoneNumberIds: [number] })));
      await who.caller.request('POST', `/v1/campaigns/${created.id}/contacts`, { csv: csvOf(...bdRows(1)) });
      await who.caller.request('POST', `/v1/campaigns/${created.id}/start`);
      await slow.ctx.campaigns.tick();
      const row = (await slow.db.query<{ outcome: string; error: string }>('SELECT outcome, error FROM campaign_attempt WHERE campaign_id = $1', [created.id])).rows[0];
      expect(row.outcome).toBe('unconfirmed');
      expect(row.error).toContain('did not answer the dial request in time');
    } finally {
      await slow.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------- retry rules and provider events

describe('retries and outcomes', () => {
  it('retries no-answer after the delay, up to the limit, then gives up and completes', async () => {
    const id = await running({ retry: { maxRetries: 2, delayMinutes: 60 } }, csvOf(...bdRows(1)));
    await tick();
    expect((await report(id, num(1), { CallStatus: 'no-answer' })).statusCode).toBe(200);
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', attempts: 1, last_outcome: 'no-answer' });
    expect((await contact(id, num(1))).next_attempt_at?.toISOString()).toBe('2026-10-05T05:00:00.000Z');

    t.dialerClock.now += 59 * MINUTE;
    expect((await tick()).claimed).toBe(0);
    t.dialerClock.now += 2 * MINUTE;
    expect((await tick()).dialed).toBe(1);
    expect((await attempts(id)).map((a) => a.attempt_no)).toEqual([1, 2]);

    await report(id, num(1), { CallStatus: 'busy' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', attempts: 2, last_outcome: 'busy' });
    t.dialerClock.now += 61 * MINUTE;
    expect((await tick()).dialed).toBe(1);
    await report(id, num(1), { CallStatus: 'completed', CallDuration: '12', AnsweredBy: 'machine_end_beep' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'failed', attempts: 3, last_outcome: 'voicemail' });
    expect((await attempts(id)).map((a) => a.outcome)).toEqual(['no-answer', 'busy', 'voicemail']);
    expect(await campaignStatus(id)).toBe('completed');
    t.dialerClock.now += 24 * 60 * MINUTE;
    await tick();
    expect(fake.outbound).toHaveLength(3);
  });

  it('records a voicemail on the call and retries it', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    await report(id, num(1), { CallStatus: 'in-progress', AnsweredBy: 'machine_start' });
    await report(id, num(1), { CallStatus: 'completed', CallDuration: '8' });
    const a = (await attempts(id))[0];
    expect(a.outcome).toBe('voicemail');
    expect((await t.db.query<{ voicemail_detected: boolean; status: string }>('SELECT voicemail_detected, status FROM call WHERE id = $1', [a.call_id])).rows[0]).toEqual({ voicemail_detected: true, status: 'ended' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending' });
  });

  it('never retries a completed conversation', async () => {
    const id = await running({ retry: { maxRetries: 10, delayMinutes: 1 } }, csvOf(...bdRows(1)));
    await tick();
    await report(id, num(1), { CallStatus: 'in-progress', AnsweredBy: 'human' });
    await report(id, num(1), { CallStatus: 'completed', CallDuration: '95', AnsweredBy: 'human' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'completed', attempts: 1, next_attempt_at: null });
    t.dialerClock.now += 5 * 60 * MINUTE;
    await tick();
    expect(fake.outbound).toHaveLength(1);
    const a = (await attempts(id))[0];
    expect((await t.db.query<{ status: string; duration_ms: number }>('SELECT status, duration_ms FROM call WHERE id = $1', [a.call_id])).rows[0]).toEqual({ status: 'ended', duration_ms: 95_000 });
  });

  it('retries an answered call that ended because our platform failed', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const a = (await attempts(id))[0];
    await t.db.query(`UPDATE call SET end_reason = 'error-llm' WHERE id = $1`, [a.call_id]);
    await report(id, num(1), { CallStatus: 'completed', CallDuration: '4', AnsweredBy: 'human' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'pending', last_outcome: 'answered' });
  });

  it('does not retry a number the provider rejected for good', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    await report(id, num(1), { CallStatus: 'failed', ErrorCode: '21211' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'failed', last_outcome: 'failed' });
    expect(await campaignStatus(id)).toBe('completed');
  });

  it('handles duplicate, out-of-order and foreign callbacks without changing the result', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const a = (await attempts(id))[0];
    const sid = a.provider_call_id!;
    expect(json(await callback(a.id, { CallSid: sid, CallStatus: 'ringing' })).result).toBe('progress');
    expect(json(await callback(a.id, { CallSid: sid, CallStatus: 'in-progress', AnsweredBy: 'human' })).result).toBe('progress');
    expect((await attempts(id))[0].status).toBe('in-progress');
    // A ringing event arriving late must not move the attempt back
    await callback(a.id, { CallSid: sid, CallStatus: 'ringing' });
    expect((await attempts(id))[0].status).toBe('in-progress');
    // Another call's id is ignored
    expect(json(await callback(a.id, { CallSid: 'CA-someone-else', CallStatus: 'completed', CallDuration: '9' })).result).toBe('ignored');
    expect((await attempts(id))[0].status).toBe('in-progress');
    expect(json(await callback(a.id, { CallSid: sid, CallStatus: 'completed', CallDuration: '30', AnsweredBy: 'human' })).result).toBe('finished');
    expect(json(await callback(a.id, { CallSid: sid, CallStatus: 'completed', CallDuration: '30', AnsweredBy: 'human' })).result).toBe('duplicate');
    expect(json(await callback(a.id, { CallSid: sid, CallStatus: 'no-answer' })).result).toBe('duplicate');
    expect(await contact(id, num(1))).toMatchObject({ status: 'completed', attempts: 1, last_outcome: 'answered' });
  });

  it('accepts provider callbacks only when signed, for a known attempt, on the right provider', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const a = (await attempts(id))[0];
    const payload = { CallSid: a.provider_call_id, CallStatus: 'completed', CallDuration: '5', AnsweredBy: 'human' };
    fake.verifyResult = false;
    expect((await callback(a.id, payload)).statusCode).toBe(401);
    expect((await attempts(id))[0].status).toBe('ringing');
    fake.verifyResult = true;
    expect((await callback('00000000-0000-4000-8000-000000000009', payload)).statusCode).toBe(404);
    expect((await callback('not-a-uuid', payload)).statusCode).toBe(404);
    expect((await callback(a.id, payload, 'telnyx')).statusCode).toBe(404);
    expect((await callback(a.id, { CallSid: 'x' })).statusCode).toBe(400);
    expect((await callback(a.id, payload)).statusCode).toBe(200);
  });
});

describe('provider safety', () => {
  it('refuses Twilio callbacks when no webhook secret is set (an empty-key signature is one anyone can compute)', async () => {
    const res = await callback('00000000-0000-4000-8000-000000000001', { CallSid: 'CA1', CallStatus: 'completed' }, 'twilio');
    expect(res.statusCode).toBe(503);
    expect(json(res).code).toBe('not_configured');
  });

  it('in production, neither dials through nor trusts callbacks from stand-in providers', async () => {
    const prod = await createTestApp({ env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://unused/unused', SMTP_HOST: 'smtp.invalid', API_PUBLIC_URL: 'https://api.example.test', MAX_CONCURRENT_CALLS_PER_ORG: '6' } });
    try {
      const who = await signUp(prod, { orgName: 'Prod Org' });
      const stub = new ScriptedAdapter();
      prod.ctx.telephony.adapters.sip = stub;
      const assistant = await publishedAssistant(who);
      const number = await importNumber(who, '+8801712345691');
      prod.dialerClock.now = MON;
      const created = json(await who.caller.request('POST', '/v1/campaigns', body({ assistantId: assistant, phoneNumberIds: [number] })));
      await who.caller.request('POST', `/v1/campaigns/${created.id}/contacts`, { csv: csvOf(...bdRows(1)) });
      expect((await who.caller.request('POST', `/v1/campaigns/${created.id}/start`)).statusCode).toBe(200);
      await prod.ctx.campaigns.tick();
      expect(stub.outbound).toHaveLength(0);
      expect(json(await who.caller.request('GET', `/v1/campaigns/${created.id}`))).toMatchObject({ status: 'paused', statusReason: 'telephony-not-configured' });
      const contactRow = (await prod.db.query<{ status: string; attempts: number }>('SELECT status, attempts FROM campaign_contact WHERE campaign_id = $1', [created.id])).rows[0];
      expect(contactRow).toEqual({ status: 'pending', attempts: 0 });
      const res = await prod.app.inject({ method: 'POST', url: '/v1/telephony/sip/status/00000000-0000-4000-8000-000000000001', payload: { CallSid: 'x', CallStatus: 'completed' } });
      expect(res.statusCode).toBe(503);
    } finally {
      await prod.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------- compliance

describe('opt-outs and the do-not-call list', () => {
  it('an opt-out in conversation lists the number, ends all retries, and blocks every campaign', async () => {
    const a = await running({ maxConcurrentCalls: 1 }, csvOf(...bdRows(1)));
    const b = await create({ name: 'Another campaign' });
    await upload(b, csvOf(...bdRows(1)));
    await tick();
    const call = (await attempts(a))[0];
    const hooks = await campaignHooksForCall(t.ctx, owner.orgId, call.call_id, t.app.log);
    expect(hooks).not.toBeNull();
    await hooks!.onOptOut({ source: 'phrase', text: 'please stop calling me', phrase: 'stop calling' });

    const listed = (await t.db.query<{ source: string; call_id: string; campaign_id: string; reason: string }>('SELECT * FROM do_not_call WHERE org_id = $1', [owner.orgId])).rows;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ source: 'opt-out', call_id: call.call_id, campaign_id: a });
    expect(listed[0].reason).toContain('stop calling');
    expect(await contact(a, num(1))).toMatchObject({ status: 'do_not_call' });
    // The other campaign's waiting contact for the same number is closed at once
    expect(await contact(b, num(1))).toMatchObject({ status: 'do_not_call' });

    // The line then drops with "no answer": still no retry
    await report(a, num(1), { CallStatus: 'no-answer' });
    expect(await contact(a, num(1))).toMatchObject({ status: 'do_not_call', last_outcome: 'no-answer' });
    t.dialerClock.now += 3 * 60 * MINUTE;
    await owner.caller.request('POST', `/v1/campaigns/${b}/start`).catch(() => undefined);
    await tick();
    expect(fake.outbound).toHaveLength(1);
    // And a new upload skips the number
    const c = await create({ name: 'Third' });
    expect((await upload(c, csvOf(...bdRows(1)))).rejected[0].reason).toBe('On the do-not-call list');
  });

  it('lists the number even when only the call end reason says opted-out', async () => {
    const id = await running({}, csvOf(...bdRows(1)));
    await tick();
    const a = (await attempts(id))[0];
    await t.db.query(`UPDATE call SET end_reason = 'opted-out' WHERE id = $1`, [a.call_id]);
    await report(id, num(1), { CallStatus: 'completed', CallDuration: '15', AnsweredBy: 'human' });
    expect(await contact(id, num(1))).toMatchObject({ status: 'do_not_call' });
    expect((await t.db.query('SELECT 1 FROM do_not_call WHERE e164 = $1', [num(1)])).rowCount).toBe(1);
  });

  it('gives the engine the campaign phrases, message and outcome labels, and nothing for other calls', async () => {
    const id = await running({ optOutPhrases: ['leave me alone'], optOutMessage: 'Sorry to bother you.', outcomeLabels: ['interested', 'no'] }, csvOf(...bdRows(1)));
    await tick();
    const call = (await attempts(id))[0];
    const hooks = (await campaignHooksForCall(t.ctx, owner.orgId, call.call_id, t.app.log))!;
    expect(hooks.optOutPhrases).toContain('leave me alone');
    expect(hooks.optOutPhrases).toContain('stop calling');
    expect(hooks.optOutMessage).toBe('Sorry to bother you.');
    expect(hooks.outcomeLabels).toEqual(['interested', 'no']);
    await hooks.onOutcome({ label: 'interested', notes: 'wants a demo' });
    expect(await contact(id, num(1))).toMatchObject({ outcome_label: 'interested' });

    const outbound = await owner.caller.request('POST', '/v1/telephony/outbound', { phoneNumberId: phoneId, customerNumber: '+8801812345678', assistantId });
    expect(outbound.statusCode).toBe(201);
    expect(await campaignHooksForCall(t.ctx, owner.orgId, json(outbound).id, t.app.log)).toBeNull();
  });
});

describe('do-not-call API', () => {
  it('normalizes and de-duplicates numbers, reports invalid ones, and closes waiting contacts', async () => {
    const id = await create();
    await upload(id, csvOf(...bdRows(2)));
    const res = await owner.caller.request('POST', '/v1/do-not-call', { numbers: [num(1), `  ${num(1)} `, '00 880 18110 00002', 'abc', '01811000003'], reason: 'Asked by email' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ added: 2, alreadyListed: 0 });
    expect(json(res).invalid.map((i: { value: string }) => i.value)).toEqual(['abc', '01811000003']);
    expect(await contact(id, num(1))).toMatchObject({ status: 'do_not_call' });
    expect(await contact(id, num(2))).toMatchObject({ status: 'do_not_call' });
    expect(json(await owner.caller.request('POST', '/v1/do-not-call', { numbers: [num(1)] }))).toMatchObject({ added: 0, alreadyListed: 1 });
    const list = json(await owner.caller.request('GET', '/v1/do-not-call'));
    expect(list.data.map((e: { number: string }) => e.number).sort()).toEqual([num(1), num(2)]);
    expect(list.data[0]).toMatchObject({ source: 'manual' });
  });

  it('lets members add numbers but only admins take them off', async () => {
    const member = await addMember(t, owner, 'member');
    const admin = await addMember(t, owner, 'admin');
    const viewer = await addMember(t, owner, 'viewer');
    expect((await member.caller.request('POST', '/v1/do-not-call', { numbers: [num(7)] })).statusCode).toBe(200);
    expect((await viewer.caller.request('POST', '/v1/do-not-call', { numbers: [num(8)] })).statusCode).toBe(403);
    expect((await viewer.caller.request('GET', '/v1/do-not-call')).statusCode).toBe(200);
    expect((await member.caller.request('DELETE', `/v1/do-not-call/${encodeURIComponent(num(7))}`)).statusCode).toBe(403);
    expect((await admin.caller.request('DELETE', `/v1/do-not-call/${encodeURIComponent(num(7))}`)).statusCode).toBe(204);
    expect((await admin.caller.request('DELETE', `/v1/do-not-call/${encodeURIComponent(num(7))}`)).statusCode).toBe(404);
    expect((await admin.caller.request('DELETE', '/v1/do-not-call/nonsense')).statusCode).toBe(404);
    const audit = await t.db.query(`SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'do_not_call.%'`, [owner.orgId]);
    expect(audit.rows.map((r) => (r as { action: string }).action)).toContain('do_not_call.removed');
  });
});

// ---------------------------------------------------------------- results

describe('results', () => {
  it('reports per-contact outcomes, dashboard stats and a CSV export', async () => {
    const csv = ['phone,first_name,name,timezone', `${num(1)},Asha,Asha Rahman,`, `${num(2)},Bela,"=SUM(1,2)",`, `${num(3)},Cyrus,Cyrus Khan,`, `${num(4)},Dina,Dina Paul,`, `${num(5)},Eli,Eli Roy,`].join('\n');
    const id = await running({ maxConcurrentCalls: 5, retry: { maxRetries: 0, delayMinutes: 60 }, outcomeLabels: ['interested', 'not-interested'], successLabels: ['interested'] }, csv);
    await tick();
    const callOf = async (n: number) => (await attempts(id)).find((a) => a.e164 === num(n))!;
    const finish = async (n: number, payload: Record<string, unknown>) => report(id, num(n), payload);
    await finish(1, { CallStatus: 'completed', CallDuration: '120', AnsweredBy: 'human' });
    await finish(2, { CallStatus: 'completed', CallDuration: '60', AnsweredBy: 'human' });
    await finish(3, { CallStatus: 'no-answer' });
    await finish(4, { CallStatus: 'completed', CallDuration: '10', AnsweredBy: 'machine_start' });
    // Eli is still on the phone
    for (const [n, label] of [[1, 'interested'], [2, 'not-interested']] as const) {
      const hooks = (await campaignHooksForCall(t.ctx, owner.orgId, (await callOf(n)).call_id, t.app.log))!;
      await hooks.onOutcome({ label });
    }
    await t.db.query('UPDATE call SET usage = $2::jsonb WHERE id = $1', [(await callOf(1)).call_id, JSON.stringify([{ component: 'transcriber', units: { audioSeconds: 118.5 } }, { component: 'model', units: { inputTokens: 900, outputTokens: 120 } }, { component: 'voice', units: { characters: 640 } }])]);
    await t.db.query('UPDATE call SET usage = $2::jsonb WHERE id = $1', [(await callOf(2)).call_id, JSON.stringify([{ component: 'model', units: { inputTokens: 100, outputTokens: 30 } }])]);

    const stats = json(await owner.caller.request('GET', `/v1/campaigns/${id}/stats`));
    expect(stats).toMatchObject({
      campaignId: id,
      status: 'running',
      contacts: { total: 5, pending: 0, calling: 1, completed: 2, failed: 2, doNotCall: 0, cancelled: 0, expired: 0 },
      dialled: 5,
      attempts: 5,
      answered: 2,
      voicemail: 1,
      completed: 2,
      answerRate: 0.4,
      completionRate: 0.4,
      successRate: 0.5,
      outcomes: { interested: 1, 'not-interested': 1 },
      usage: { callSeconds: 190, callMinutes: 3.17, sttAudioSeconds: 118.5, llmInputTokens: 1000, llmOutputTokens: 150, ttsCharacters: 640 },
    });

    const contacts = json(await owner.caller.request('GET', `/v1/campaigns/${id}/contacts?limit=10`)).data;
    const byNumber = Object.fromEntries(contacts.map((c: { number: string }) => [c.number, c]));
    expect(byNumber[num(1)]).toMatchObject({ status: 'completed', outcome: 'answered', outcomeLabel: 'interested', attempts: 1 });
    expect(byNumber[num(3)]).toMatchObject({ status: 'failed', outcome: 'no-answer', outcomeLabel: null });
    expect(byNumber[num(4)]).toMatchObject({ status: 'failed', outcome: 'voicemail' });
    expect(byNumber[num(5)]).toMatchObject({ status: 'calling', outcome: null });

    const exported = await owner.caller.request('GET', `/v1/campaigns/${id}/export.csv`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain(`campaign-${id}.csv`);
    const lines = exported.body.trimEnd().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('phone,name,time_zone,status,outcome,outcome_label,outcome_notes,attempts,last_attempt_ended_at,next_attempt_at,call_id,duration_seconds,answered_by,end_reason,var.customer_name,var.first_name');
    const asha = lines.find((l) => l.startsWith(num(1)))!;
    expect(asha).toContain(',Asha Rahman,Asia/Dhaka,completed,answered,interested,');
    expect(asha).toContain(',120,human,');
    // A spreadsheet must not run a contact-supplied formula
    expect(lines.find((l) => l.startsWith(num(2)))).toContain(`"'=SUM(1,2)"`);
  });

  it('reports no rates when nothing happened, and a null success rate without success labels', async () => {
    const id = await create();
    const stats = json(await owner.caller.request('GET', `/v1/campaigns/${id}/stats`));
    expect(stats).toMatchObject({ dialled: 0, attempts: 0, answerRate: null, completionRate: null, successRate: null, usage: { callSeconds: 0 } });
    expect((await owner.caller.request('GET', `/v1/campaigns/${id}/export.csv`)).body.trimEnd().split('\r\n')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- access

describe('access control', () => {
  it('lets viewers read, members manage, and private keys act as admins; public keys get nothing', async () => {
    const viewer = await addMember(t, owner, 'viewer');
    const member = await addMember(t, owner, 'member');
    expect((await viewer.caller.request('GET', '/v1/campaigns')).statusCode).toBe(200);
    expect((await viewer.caller.request('POST', '/v1/campaigns', body())).statusCode).toBe(403);
    const created = await member.caller.request('POST', '/v1/campaigns', body({ name: 'By member' }));
    expect(created.statusCode).toBe(201);
    const id = json(created).id;
    expect((await viewer.caller.request('GET', `/v1/campaigns/${id}/stats`)).statusCode).toBe(200);
    for (const action of ['start', 'pause', 'resume', 'cancel']) expect((await viewer.caller.request('POST', `/v1/campaigns/${id}/${action}`)).statusCode, action).toBe(403);
    expect((await viewer.caller.request('POST', `/v1/campaigns/${id}/contacts`, { csv: csvOf(...bdRows(1)) })).statusCode).toBe(403);
    expect((await viewer.caller.request('DELETE', `/v1/campaigns/${id}`)).statusCode).toBe(403);

    const key = keyCaller(t, (await createKey(owner.caller)).key);
    expect((await key.request('POST', '/v1/campaigns', body({ name: 'By key' }))).statusCode).toBe(201);
    const pub = keyCaller(t, (await createKey(owner.caller, { name: 'web', type: 'public', allowedOrigins: ['https://site.test'] })).key, 'public key', 'https://site.test');
    expect((await pub.request('GET', '/v1/campaigns')).statusCode).toBe(403);
  });
});

describe("another org's campaigns", () => {
  let other: SignedUp;
  let otherCampaign: string;
  let otherAssistant: string;
  let otherPhone: string;
  beforeAll(async () => {
    other = await signUp(t, { orgName: 'Other Org' });
    otherAssistant = await publishedAssistant(other, 'Other agent');
    otherPhone = await importNumber(other, '+8801712399999');
    otherCampaign = await create({ name: 'Theirs', assistantId: otherAssistant, phoneNumberIds: [otherPhone] }, other);
    await upload(otherCampaign, csvOf(...bdRows(2)), {}, other);
    await other.caller.request('POST', '/v1/do-not-call', { numbers: [num(1)] });
  });

  it('are invisible and untouchable: every foreign id is a 404 and nothing changes', async () => {
    const before = json(await other.caller.request('GET', `/v1/campaigns/${otherCampaign}`));
    const calls: [string, string, unknown?][] = [
      ['GET', `/v1/campaigns/${otherCampaign}`],
      ['PATCH', `/v1/campaigns/${otherCampaign}`, { name: 'Hijacked' }],
      ['DELETE', `/v1/campaigns/${otherCampaign}`],
      ['POST', `/v1/campaigns/${otherCampaign}/start`],
      ['POST', `/v1/campaigns/${otherCampaign}/pause`],
      ['POST', `/v1/campaigns/${otherCampaign}/resume`],
      ['POST', `/v1/campaigns/${otherCampaign}/cancel`],
      ['POST', `/v1/campaigns/${otherCampaign}/contacts`, { csv: csvOf(...bdRows(1, 700)) }],
      ['GET', `/v1/campaigns/${otherCampaign}/contacts`],
      ['GET', `/v1/campaigns/${otherCampaign}/stats`],
      ['GET', `/v1/campaigns/${otherCampaign}/export.csv`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await owner.caller.request(method as 'GET', url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(json(await other.caller.request('GET', `/v1/campaigns/${otherCampaign}`))).toEqual(before);
    expect(json(await other.caller.request('GET', `/v1/campaigns/${otherCampaign}/contacts?limit=10`)).data).toHaveLength(2);
  });

  it('cannot be targeted from a campaign of ours (their assistant or number)', async () => {
    expect((await owner.caller.request('POST', '/v1/campaigns', body({ assistantId: otherAssistant }))).statusCode).toBe(404);
    const withNumber = await owner.caller.request('POST', '/v1/campaigns', body({ phoneNumberIds: [otherPhone] }));
    expect(withNumber.statusCode).toBe(400);
    expect(json(withNumber).details.issues[0].message).toBe('Phone number not found');
  });

  it('are absent from our lists, and each org keeps its own do-not-call list', async () => {
    const ours = json(await owner.caller.request('GET', '/v1/campaigns?limit=100')).data.map((c: { id: string }) => c.id);
    expect(ours).not.toContain(otherCampaign);
    expect(json(await owner.caller.request('GET', '/v1/do-not-call')).data).toEqual([]);
    expect(json(await other.caller.request('GET', '/v1/do-not-call')).data.map((e: { number: string }) => e.number)).toEqual([num(1)]);
    // Their listing does not stop us calling the same number
    const mine = await running({}, csvOf(...bdRows(1)));
    await tick();
    expect(dialedNumbers()).toContain(num(1));
    expect(await contact(mine, num(1))).toMatchObject({ status: 'calling' });
    expect((await owner.caller.request('DELETE', `/v1/do-not-call/${encodeURIComponent(num(1))}`)).statusCode).toBe(404);
    expect(json(await other.caller.request('GET', '/v1/do-not-call')).data).toHaveLength(1);
  });

  it('are protected by row-level security even for a query with no org filter', async () => {
    for (const table of ['campaign', 'campaign_phone_number', 'campaign_contact', 'campaign_attempt', 'do_not_call']) {
      const rows = await t.ctx.tenants.withOrg(owner.orgId, async (tx) => (await tx.query<{ org_id: string }>(`SELECT org_id FROM ${table}`)).rows);
      for (const row of rows) expect(row.org_id, table).toBe(owner.orgId);
    }
    await expect(
      t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`INSERT INTO do_not_call (org_id, e164, source, created_by_type) VALUES ($1, '+8801700000001', 'manual', 'system')`, [other.orgId]))
    ).rejects.toThrow(/row-level security/);
    const update = await t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`UPDATE campaign SET name = 'x' WHERE id = $1`, [otherCampaign]));
    expect(update.rowCount).toBe(0);
  });
});
