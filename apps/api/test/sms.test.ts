/**
 * SMS channel end to end: inbound webhook → chat session → split reply, opt-out keywords, webhook
 * retries, numbers without SMS, signatures, and the real Twilio wire format (form body, signature,
 * REST send) against a mocked Twilio API.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMessagingAdapter } from '../../../packages/engine/src/messaging/fake.ts';
import { smsLength } from '../../../packages/engine/src/messaging/sms.ts';
import { TwilioMessagingAdapter } from '../../../packages/engine/src/messaging/twilio.ts';
import { fakeEngine } from '../../../packages/engine/src/testing/fakeEngine.ts';
import { SMS_TEXT } from '../src/services/sms.ts';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

const OUR = '+8801711000000';
const NO_SMS = '+8801711000001';
const TWILIO_NUMBER = '+15005550006';
const CUSTOMER = '+8801819000000';
const LONG = 'Your appointment is confirmed for Tuesday at ten in the morning. Please arrive fifteen minutes early. Bring your previous prescriptions and your national ID card. Parking is available behind the clinic building. ';
const BANGLA = 'আপনার অ্যাপয়েন্টমেন্ট মঙ্গলবার সকাল দশটায় নিশ্চিত করা হয়েছে। অনুগ্রহ করে পনেরো মিনিট আগে আসবেন। ';

describe('SMS channel', () => {
  let t: TestApp;
  let owner: SignedUp;
  let fake: FakeMessagingAdapter;
  let assistantId: string;
  const twilioCalls: { url: string; auth: string; body: URLSearchParams }[] = [];
  const engine = fakeEngine({
    reply: (text) => (/long/i.test(text) ? LONG.repeat(2) : /bangla/i.test(text) ? BANGLA.repeat(3) : `You said: ${text}`),
  });
  let counter = 0;

  async function sms(text: string, options: { from?: string; to?: string; id?: string } = {}) {
    const before = fake.sent.length;
    const res = await t.app.inject({ method: 'POST', url: '/v1/messaging/fake/webhook', payload: { id: options.id ?? `SM${++counter}`, from: options.from ?? CUSTOMER, to: options.to ?? OUR, text } });
    expect(res.statusCode).toBe(200);
    await t.ctx.sms.idle();
    return fake.sent.slice(before);
  }
  const llmCalls = () => engine.llms.reduce((n, llm) => n + llm.requests.length, 0);

  beforeAll(async () => {
    const twilio = new TwilioMessagingAdapter((async (url: string, init: RequestInit) => {
      twilioCalls.push({ url, auth: String((init.headers as Record<string, string>).authorization), body: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify({ sid: `SMout${twilioCalls.length}` }), { status: 201 });
    }) as typeof fetch);
    t = await createTestApp({
      modelForCall: engine.modelForCall,
      messaging: { twilio },
      env: { TWILIO_WEBHOOK_SECRET: 'twilio-auth-token', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'twilio-auth-token', SMS_MAX_SEGMENTS_PER_MESSAGE: '1', SMS_MAX_MESSAGES_PER_REPLY: '3', API_PUBLIC_URL: 'https://api.octo.test' },
    });
    fake = t.ctx.messaging.fake as FakeMessagingAdapter;
    owner = await signUp(t, { orgName: 'SMS Clinic' });
    const created = json(await owner.caller.request('POST', '/v1/assistants', { name: 'Texting receptionist', config: { systemPrompt: 'You help {{customer_number}} by text.', fallbackMessage: 'Sorry, please try again later.' } }));
    await owner.caller.request('POST', `/v1/assistants/${created.id}/publish`, {});
    assistantId = created.id;
    for (const [e164, capabilities, provider] of [[OUR, ['voice', 'sms'], 'sip'], [NO_SMS, ['voice'], 'sip'], [TWILIO_NUMBER, ['sms'], 'twilio']] as const) {
      const res = await owner.caller.request('POST', '/v1/phone-numbers/import', { provider, e164, assistantId, capabilities });
      expect(res.statusCode).toBe(201);
    }
  }, 60_000);

  afterAll(async () => t.close());

  it('starts a conversation, replies by SMS from our number, and continues it', async () => {
    const first = await sms('Do you open on Friday?');
    expect(first).toEqual([{ from: OUR, to: CUSTOMER, text: 'You said: Do you open on Friday?' }]);
    const request = engine.llms.at(-1)!.requests[0];
    expect(request.systemPrompt).toContain(`You help ${CUSTOMER} by text.`);
    expect(request.systemPrompt).toContain('This conversation is by SMS');

    await sms('And Saturday?');
    expect(engine.llms.at(-1)!.requests[0].messages.map((m) => m.content)).toEqual(['Do you open on Friday?', 'You said: Do you open on Friday?', 'And Saturday?']);
    const sessions = await t.ctx.tenants.withOrg(owner.orgId, async (tx) => (await tx.query<{ channel: string; customer_number: string; message_count: number }>(`SELECT channel, customer_number, message_count FROM chat_session WHERE channel = 'sms'`)).rows);
    expect(sessions).toEqual([{ channel: 'sms', customer_number: CUSTOMER, message_count: 4 }]);
  });

  it('splits long replies into messages within the segment limit', async () => {
    const sent = await sms('send the long version', { from: '+8801819000111' });
    expect(sent.length).toBe(3);
    for (const message of sent) expect(smsLength(message.text)).toBeLessThanOrEqual(160);
    expect(sent.at(-1)!.text.endsWith('…')).toBe(true);

    const bangla = await sms('bangla please', { from: '+8801819000112' });
    expect(bangla.length).toBeGreaterThan(1);
    for (const message of bangla) expect(message.text.length).toBeLessThanOrEqual(70);
  });

  it('honours STOP, HELP and START, and never sends the assistant to an opted-out customer', async () => {
    const customer = '+8801819000200';
    await sms('hello', { from: customer });
    expect(await sms(' Stop. ', { from: customer })).toEqual([{ from: OUR, to: customer, text: SMS_TEXT.optedOut }]);
    const ended = await t.ctx.tenants.withOrg(owner.orgId, async (tx) => (await tx.query<{ status: string; end_reason: string }>('SELECT status, end_reason FROM chat_session WHERE customer_number = $1', [customer])).rows);
    expect(ended).toEqual([{ status: 'ended', end_reason: 'opted-out' }]);

    const calls = llmCalls();
    expect(await sms('are you there?', { from: customer })).toEqual([]);
    expect(llmCalls()).toBe(calls);
    expect(await sms('HELP', { from: customer })).toEqual([{ from: OUR, to: customer, text: SMS_TEXT.help }]);
    expect(await sms('start', { from: customer })).toEqual([{ from: OUR, to: customer, text: SMS_TEXT.optedIn }]);
    expect(await sms('hello again', { from: customer })).toEqual([{ from: OUR, to: customer, text: 'You said: hello again' }]);

    // UNSUBSCRIBE works too, and the opt-out covers every number of the org
    expect((await sms('UNSUBSCRIBE', { from: customer }))[0].text).toBe(SMS_TEXT.optedOut);
    const optOut = await t.ctx.tenants.withOrg(owner.orgId, async (tx) => (await tx.query<{ customer_number: string; keyword: string }>('SELECT customer_number, keyword FROM sms_opt_out')).rows);
    expect(optOut).toEqual([{ customer_number: customer, keyword: 'UNSUBSCRIBE' }]);
  });

  it('answers a provider webhook retry only once', async () => {
    const before = fake.sent.length;
    await Promise.all([
      t.app.inject({ method: 'POST', url: '/v1/messaging/fake/webhook', payload: { id: 'SM-dup', from: '+8801819000300', to: OUR, text: 'once' } }),
      t.app.inject({ method: 'POST', url: '/v1/messaging/fake/webhook', payload: { id: 'SM-dup', from: '+8801819000300', to: OUR, text: 'once' } }),
    ]);
    await t.ctx.sms.idle();
    expect(await sms('once', { from: '+8801819000300', id: 'SM-dup' })).toEqual([]);
    expect(fake.sent.length - before).toBe(1);
  });

  it('ignores numbers without SMS enabled and unknown numbers', async () => {
    expect(await sms('hello', { to: NO_SMS })).toEqual([]);
    expect(await sms('hello', { to: '+8801711999999' })).toEqual([]);
  });

  it('rejects unsigned webhooks', async () => {
    fake.verifyResult = false;
    try {
      const res = await t.app.inject({ method: 'POST', url: '/v1/messaging/fake/webhook', payload: { id: 'SMx', from: CUSTOMER, to: OUR, text: 'hi' } });
      expect(res.statusCode).toBe(401);
    } finally {
      fake.verifyResult = true;
    }
    expect((await t.app.inject({ method: 'POST', url: '/v1/messaging/whatsapp/webhook', payload: {} })).statusCode).toBe(404);
  });

  it('speaks Twilio: form-encoded, signed webhooks and REST replies', async () => {
    const params = { MessageSid: 'SMtwilio1', AccountSid: 'AC123', From: '+8801819000400', To: TWILIO_NUMBER, Body: 'Hi from Twilio' };
    const url = 'https://api.octo.test/v1/messaging/twilio/webhook';
    const signature = createHmac('sha1', 'twilio-auth-token').update(url + Object.keys(params).sort().map((k) => `${k}${params[k as keyof typeof params]}`).join('')).digest('base64');
    const form = new URLSearchParams(params).toString();

    const forged = await t.app.inject({ method: 'POST', url: '/v1/messaging/twilio/webhook', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged' }, payload: form });
    expect(forged.statusCode).toBe(401);

    const res = await t.app.inject({ method: 'POST', url: '/v1/messaging/twilio/webhook', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: form });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toBe('<Response></Response>');
    await t.ctx.sms.idle();
    expect(twilioCalls).toHaveLength(1);
    expect(twilioCalls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(twilioCalls[0].auth).toBe(`Basic ${Buffer.from('AC123:twilio-auth-token').toString('base64')}`);
    expect(Object.fromEntries(twilioCalls[0].body)).toEqual({ From: TWILIO_NUMBER, To: '+8801819000400', Body: 'You said: Hi from Twilio' });
  });
});
