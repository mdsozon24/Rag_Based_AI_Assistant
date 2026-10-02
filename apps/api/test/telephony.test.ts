import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTelephonyAdapter } from '../../../packages/engine/src/telephony/fake.ts';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('telephony API', () => {
  let t: TestApp; let owner: SignedUp; let fake: FakeTelephonyAdapter;
  beforeAll(async () => { t = await createTestApp(); owner = await signUp(t, { orgName: 'Phone Org' }); fake = new FakeTelephonyAdapter(); t.ctx.telephony.adapters.sip = fake; }, 30_000);
  afterAll(async () => t.close());

  it('imports a Bangladesh number, receives an inbound webhook, and starts outbound calls', async () => {
    const assistantRes = await owner.caller.request('POST', '/v1/assistants', { name: 'Phone agent', config: { firstMessage: 'Hello' } });
    const assistant = json(assistantRes); expect((await owner.caller.request('POST', `/v1/assistants/${assistant.id}/publish`, {})).statusCode).toBe(201);
    const imported = await owner.caller.request('POST', '/v1/phone-numbers/import', { provider: 'sip', e164: '+8801712345678', assistantId: assistant.id });
    expect(imported.statusCode).toBe(201);
    const phone = json(imported); expect(phone.country).toBe('BD');
    const inbound = await t.app.inject({ method: 'POST', url: '/v1/telephony/sip/webhook', payload: { To: '+8801712345678', From: '+8801812345678', CallSid: 'sip-1' } });
    expect(inbound.statusCode).toBe(200); expect(inbound.body).toContain('/v1/telephony/sip/media/');
    const outbound = await owner.caller.request('POST', '/v1/telephony/outbound', { phoneNumberId: phone.id, customerNumber: '+8801812345678', assistantId: assistant.id });
    expect(outbound.statusCode).toBe(201); expect(fake.outbound[0].to).toBe('+8801812345678');
  });

  it('rejects invalid E.164 numbers', async () => {
    const result = await owner.caller.request('POST', '/v1/telephony/outbound', { phoneNumberId: '00000000-0000-0000-0000-000000000000', customerNumber: '01712345678', assistantId: '00000000-0000-0000-0000-000000000000' });
    expect(result.statusCode).toBe(400);
  });
});