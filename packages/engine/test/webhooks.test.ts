import { describe, expect, it } from 'vitest';
import { backoffMs, signWebhook, verifyWebhookSignature, webhookBody, callSyncWebhook, type WebhookEndpoint } from '../../../apps/api/src/services/webhooks.ts';

const endpoint: WebhookEndpoint = { id: 'endpoint-1', orgId: 'org-1', scopeType: 'org', scopeId: null, url: 'https://customer.example.test/events', headers: { 'x-tenant': 'bd' }, secretEncrypted: {} as never, events: ['assistant-request'], transcriptOptIn: false, enabled: true };

describe('webhook delivery contracts', () => {
  it('signs and verifies timestamped payloads, rejecting replay', () => {
    const payload = JSON.stringify(webhookBody('call.started', 'call-1', 1)); const signature = signWebhook('secret', 1000, payload);
    expect(verifyWebhookSignature('secret', signature, payload, 1000)).toBe(true);
    expect(verifyWebhookSignature('secret', signature, payload, 1401)).toBe(false);
    expect(verifyWebhookSignature('wrong', signature, payload, 1000)).toBe(false);
  });

  it('uses bounded exponential retry delays', () => {
    expect(backoffMs(1)).toBe(500); expect(backoffMs(2)).toBe(1000); expect(backoffMs(5)).toBe(8000); expect(backoffMs(20)).toBe(60000);
  });

  it('returns the sync fallback when the customer server times out', async () => {
    const result = await callSyncWebhook(endpoint, 'secret', { type: 'assistant-request' }, async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')))), 5, { assistantId: 'fallback-assistant' });
    expect(result).toEqual({ assistantId: 'fallback-assistant' });
  });

  it('keeps event ids and sequences stable for snapshots', () => {
    expect(webhookBody('transcript', 'call-1', 2, { text: 'সেবা' })).toEqual({ id: 'evt_call-1_2', type: 'transcript', createdAt: expect.any(String), callId: 'call-1', sequence: 2, data: { text: 'সেবা' } });
  });
});