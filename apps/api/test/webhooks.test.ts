import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('webhook API', () => {
  let t: TestApp; let owner: SignedUp; let other: SignedUp;
  beforeAll(async () => { t = await createTestApp({ env: { CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }); owner = await signUp(t, { orgName: 'Webhook A' }); other = await signUp(t, { orgName: 'Webhook B' }); }, 30_000);
  afterAll(async () => t.close());
  it('creates a scoped endpoint without returning its secret and lists delivery logs', async () => {
    const created = await owner.caller.request('POST', '/v1/webhooks', { url: 'https://customer.example.test/events', secret: 'bangladesh-webhook-secret', scopeType: 'org', events: ['call.started', 'transcript'], headers: { 'x-region': 'bd' } });
    expect(created.statusCode).toBe(201); expect(JSON.stringify(json(created))).not.toContain('bangladesh-webhook-secret');
    const deliveries = await owner.caller.request('GET', '/v1/webhook-deliveries'); expect(deliveries.statusCode).toBe(200); expect(json(deliveries).data).toEqual([]);
    expect((await other.caller.request('GET', '/v1/webhooks')).statusCode).toBe(200); expect(json(await other.caller.request('GET', '/v1/webhooks')).data).toHaveLength(0);
  });
});