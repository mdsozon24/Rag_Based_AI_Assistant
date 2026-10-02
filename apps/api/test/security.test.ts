import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createTestApp } from './helpers.ts';
import { messagingWebhookEnabled } from '../src/routes/messaging.ts';
import { inboundWebhookEnabled } from '../src/routes/telephony.ts';

describe('production telephony webhook gate', () => {
  it('allows only a signed real provider in production', () => {
    expect(inboundWebhookEnabled('twilio', 'production', 'configured-secret')).toBe(true);
    expect(inboundWebhookEnabled('twilio', 'production')).toBe(false);
    expect(inboundWebhookEnabled('sip', 'production', 'configured-secret')).toBe(false);
    expect(inboundWebhookEnabled('telnyx', 'production', 'configured-secret')).toBe(false);
  });

  it('keeps fake providers available outside production', () => {
    expect(inboundWebhookEnabled('sip', 'test')).toBe(true);
  });

  it('refuses production Twilio SMS webhooks when no signing secret is configured', () => {
    expect(messagingWebhookEnabled('twilio', 'production', 'configured-secret')).toBe(true);
    expect(messagingWebhookEnabled('twilio', 'production', '')).toBe(false);
    expect(messagingWebhookEnabled('twilio', 'test', '')).toBe(true);
  });

  it('requires secure public URLs for production deployments', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://octo:secret@db.example.test/octo',
      API_PUBLIC_URL: 'https://api.example.test',
      DASHBOARD_URL: 'https://app.example.test',
      SMTP_HOST: 'smtp.example.test',
    };
    expect(loadConfig(base).publicUrl).toBe(base.API_PUBLIC_URL);
    expect(() => loadConfig({ ...base, API_PUBLIC_URL: 'http://api.example.test' })).toThrow(/API_PUBLIC_URL must use HTTPS/);
    expect(() => loadConfig({ ...base, DASHBOARD_URL: 'http://app.example.test' })).toThrow(/DASHBOARD_URL must use HTTPS/);
  });
});

describe('client address behind proxies (TRUST_PROXY)', () => {
  it('parses false, true and proxy address lists, and refuses anything else', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1,fd00::/8, loopback' }).trustProxy).toEqual(['10.0.0.0/8', '127.0.0.1', 'fd00::/8', 'loopback']);
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY must be/);
    expect(() => loadConfig({ TRUST_PROXY: '10.0.0.0/33' })).toThrow(/TRUST_PROXY must be/);
  });

  async function ipSeen(trust: string, remoteAddress: string, forwardedFor?: string): Promise<string> {
    const t = await createTestApp({
      env: { TRUST_PROXY: trust },
      extraRoutes: (app) => app.get('/test/ip', { config: { auth: 'none' } }, async (request) => ({ ip: request.ip })),
    });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/test/ip', remoteAddress, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} });
      return JSON.parse(res.body).ip;
    } finally {
      await t.close();
    }
  }

  it('believes X-Forwarded-For only from the listed proxies', async () => {
    // A request through a trusted proxy (the dashboard server): the client is the address it reported
    expect(await ipSeen('10.0.0.0/8', '10.1.2.3', '203.0.113.9')).toBe('203.0.113.9');
    // A client that sets the header itself, through an ingress that appends the real address
    expect(await ipSeen('10.0.0.0/8', '10.1.2.3', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    // Straight from the internet: the header is the caller's own claim and is ignored
    expect(await ipSeen('10.0.0.0/8', '198.51.100.7', '6.6.6.6')).toBe('198.51.100.7');
    // Not trusting proxies at all: always the socket address
    expect(await ipSeen('false', '10.1.2.3', '203.0.113.9')).toBe('10.1.2.3');
  }, 60_000);
});
