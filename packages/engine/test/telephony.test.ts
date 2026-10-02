import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bangladeshE164Schema, countryFromE164, isE164 } from '../src/telephony/numbers.ts';
import { TwilioAdapter } from '../src/telephony/twilio.ts';
import { TelephonyDialError, type OutboundCallRequest } from '../src/telephony/types.ts';

describe('telephony contracts', () => {
  it('treats Bangladesh numbers as first-class E.164 values', () => {
    expect(isE164('+8801712345678')).toBe(true);
    expect(bangladeshE164Schema.safeParse('+8801712345678').success).toBe(true);
    expect(countryFromE164('+8801712345678')).toBe('BD');
    expect(isE164('01712345678')).toBe(false);
  });

  it('verifies Twilio webhook signatures', () => {
    const adapter = new TwilioAdapter();
    const url = 'https://api.example.test/v1/telephony/twilio/webhook';
    const body = { CallSid: 'CA123', To: '+8801712345678', From: '+14155550100' };
    const signature = createHmac('sha1', 'secret').update(url + 'CallSidCA123From+14155550100To+8801712345678').digest('base64');
    expect(adapter.verifyWebhookSignature(url, { 'x-twilio-signature': signature }, body, 'secret')).toBe(true);
    expect(adapter.verifyWebhookSignature(url, { 'x-twilio-signature': 'bad' }, body, 'secret')).toBe(false);
  });
});

describe('Twilio outbound dialing', () => {
  const credentials = { accountSid: 'AC123', authToken: 'token', apiUrl: 'https://twilio.example.test/' };
  const request: OutboundCallRequest = {
    to: '+8801811000001',
    from: { id: 'p1', provider: 'twilio', providerNumberId: 'PN1', e164: '+8801712345678', capabilities: ['voice'] },
    streamUrl: 'wss://api.example.test/v1/telephony/twilio/media/c1',
    voicemailDetection: true,
    statusCallbackUrl: 'https://api.example.test/v1/telephony/twilio/status/a1',
  };
  afterEach(() => vi.unstubAllGlobals());

  it('asks Twilio to post call progress to the status callback and to detect answering machines', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'CA999', status: 'queued' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const call = await new TwilioAdapter().startOutbound(request, credentials);
    expect(call).toMatchObject({ providerCallId: 'CA999', status: 'queued' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://twilio.example.test/2010-04-01/Accounts/AC123/Calls.json');
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+8801811000001');
    expect(form.get('From')).toBe('+8801712345678');
    expect(form.get('MachineDetection')).toBe('Enable');
    expect(form.get('StatusCallback')).toBe(request.statusCallbackUrl);
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
  });

  it('sends no status callback when none is given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'CA1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await new TwilioAdapter().startOutbound({ ...request, statusCallbackUrl: undefined }, credentials);
    const form = new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(form.has('StatusCallback')).toBe(false);
  });

  it('says whether a failed dial may have placed a call', async () => {
    const adapter = new TwilioAdapter();
    // Twilio answered with an error: nothing was placed
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(adapter.startOutbound(request, credentials)).rejects.toMatchObject({ name: 'TelephonyDialError', callPlaced: 'no', httpStatus: 503, message: 'Twilio outbound call failed with HTTP 503' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    await expect(adapter.startOutbound(request, credentials)).rejects.toMatchObject({ callPlaced: 'no', httpStatus: 400 });
    // The connection failed after the request may have been sent: unknown
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const error = await adapter.startOutbound(request, credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelephonyDialError);
    expect(error).toMatchObject({ callPlaced: 'maybe' });
  });

  it('refuses to dial without credentials', async () => {
    await expect(new TwilioAdapter().startOutbound(request, {})).rejects.toThrow('accountSid, authToken and apiUrl are required');
  });
});
