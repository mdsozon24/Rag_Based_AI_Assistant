import { describe, expect, it } from 'vitest';
import { segmentCount, smsEncoding, smsKeyword, smsLength, splitSms } from '../src/messaging/sms.ts';
import { TwilioMessagingAdapter } from '../src/messaging/twilio.ts';
import { createHmac } from 'node:crypto';

describe('SMS encoding and segments', () => {
  it('detects GSM-7 and UCS-2 (Bangla, emoji)', () => {
    expect(smsEncoding('Hello, your order ships today!')).toBe('gsm7');
    expect(smsEncoding('আপনার অর্ডার আজ পাঠানো হবে')).toBe('ucs2');
    expect(smsEncoding('Thanks 👍')).toBe('ucs2');
  });
  it('counts extension characters twice and UCS-2 in code units', () => {
    expect(smsLength('a€b')).toBe(4);
    expect(smsLength('👍')).toBe(2);
  });
  it('counts segments with the concatenation header', () => {
    expect(segmentCount('x'.repeat(160))).toBe(1);
    expect(segmentCount('x'.repeat(161))).toBe(2);
    expect(segmentCount('অ'.repeat(70))).toBe(1);
    expect(segmentCount('অ'.repeat(71))).toBe(2);
  });
});

describe('splitSms', () => {
  it('keeps short replies whole', () => {
    expect(splitSms('We open at nine.')).toEqual(['We open at nine.']);
    expect(splitSms('   ')).toEqual([]);
  });

  it('splits at sentence boundaries within the segment budget', () => {
    const sentence = 'This is a sentence that is exactly long enough to matter here. ';
    const parts = splitSms(sentence.repeat(6), { maxSegmentsPerMessage: 1 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(smsLength(part)).toBeLessThanOrEqual(160);
      expect(part.endsWith('.')).toBe(true);
    }
    expect(parts.join(' ')).toBe(sentence.repeat(6).trim());
  });

  it('uses the smaller UCS-2 limits for Bangla and splits at the Bangla full stop', () => {
    const sentence = 'আপনার অ্যাপয়েন্টমেন্ট মঙ্গলবার সকাল দশটায় নিশ্চিত করা হয়েছে। ';
    const parts = splitSms(sentence.repeat(4), { maxSegmentsPerMessage: 1 });
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(70);
      expect(part.endsWith('।')).toBe(true);
    }
  });

  it('splits a single huge word by characters and caps the number of messages', () => {
    const parts = splitSms('x'.repeat(2000), { maxSegmentsPerMessage: 1, maxMessages: 3 });
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => smsLength(p) <= 160)).toBe(true);
    expect(parts[2].endsWith('…')).toBe(true);
  });
});

describe('SMS keywords', () => {
  it.each([
    ['STOP', 'opt-out'],
    [' stop. ', 'opt-out'],
    ['Unsubscribe', 'opt-out'],
    ['STOPALL', 'opt-out'],
    ['start', 'opt-in'],
    ['UNSTOP', 'opt-in'],
    ['help', 'help'],
  ])('%j is %s', (text, keyword) => expect(smsKeyword(text)).toBe(keyword));

  it('only matches the whole message', () => {
    expect(smsKeyword('please stop calling me about the bill')).toBeNull();
    expect(smsKeyword('Can you help me?')).toBeNull();
  });

  it('accepts extra keywords', () => {
    expect(smsKeyword('বন্ধ', { 'বন্ধ': 'opt-out' })).toBe('opt-out');
  });
});

describe('Twilio messaging adapter', () => {
  const adapter = (fetcher: typeof fetch) => new TwilioMessagingAdapter(fetcher);

  it('verifies the X-Twilio-Signature of form webhooks', () => {
    const url = 'https://api.example.com/v1/messaging/twilio/webhook';
    const body = { MessageSid: 'SM1', From: '+8801711111111', To: '+8801722222222', Body: 'Hi' };
    const params = Object.keys(body).sort().map((k) => `${k}${body[k as keyof typeof body]}`).join('');
    const signature = createHmac('sha1', 'token').update(url + params).digest('base64');
    const twilio = adapter(fetch);
    expect(twilio.verifyWebhookSignature(url, { 'x-twilio-signature': signature }, body, 'token')).toBe(true);
    expect(twilio.verifyWebhookSignature(url, { 'x-twilio-signature': signature }, { ...body, Body: 'changed' }, 'token')).toBe(false);
    expect(twilio.parseInbound(body)).toEqual({ providerMessageId: 'SM1', from: '+8801711111111', to: '+8801722222222', text: 'Hi' });
    expect(twilio.parseInbound({ MessageStatus: 'delivered' })).toBeNull();
  });

  it('sends with basic auth, retries one 503, and never retries a network error', async () => {
    const statuses = [503, 201];
    const requests: RequestInit[] = [];
    const ok = adapter((async (_url: string, init: RequestInit) => {
      requests.push(init);
      const status = statuses.shift()!;
      return new Response(JSON.stringify(status === 201 ? { sid: 'SMout' } : { code: 20500 }), { status });
    }) as typeof fetch);
    await expect(ok.send({ from: '+1', to: '+2', text: 'hi' }, { accountSid: 'AC1', authToken: 't' })).resolves.toEqual({ providerMessageId: 'SMout' });
    expect(requests).toHaveLength(2);
    expect(String(requests[0].body)).toContain('Body=hi');

    let calls = 0;
    const offline = adapter((async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(offline.send({ from: '+1', to: '+2', text: 'hi' }, { accountSid: 'AC1', authToken: 't' })).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
    await expect(ok.send({ from: '+1', to: '+2', text: 'hi' }, {})).rejects.toThrow(/TWILIO_ACCOUNT_SID/);
  });
});
