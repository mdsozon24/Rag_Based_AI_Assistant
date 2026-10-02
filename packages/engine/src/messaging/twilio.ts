/**
 * Twilio Programmable Messaging: inbound webhook (form-encoded, X-Twilio-Signature) and
 * POST /2010-04-01/Accounts/{sid}/Messages.json for replies.
 *
 * Sending is not idempotent at Twilio, so a timeout or network error is NOT retried (the message
 * may have been accepted); only a 429 or 5xx response (rejected before acceptance) is retried once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage, MessagingAdapter, MessagingCredentials, OutboundMessage } from './types.ts';

const SEND_TIMEOUT_MS = 10_000;
type Fetch = typeof fetch;

export class TwilioMessagingAdapter implements MessagingAdapter {
  readonly provider = 'twilio' as const;

  constructor(private readonly fetcher: Fetch = (...args) => fetch(...args)) {}

  verifyWebhookSignature(url: string, headers: Record<string, string>, body: Record<string, unknown>, secret: string): boolean {
    const signature = headers['x-twilio-signature'];
    if (!signature || !secret) return false;
    const params = Object.keys(body).sort().map((key) => `${key}${String(body[key])}`).join('');
    const digest = createHmac('sha1', secret).update(url + params).digest('base64');
    return signature.length === digest.length && timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }

  parseInbound(body: Record<string, unknown>): InboundMessage | null {
    const sid = body.MessageSid ?? body.SmsSid;
    if (typeof sid !== 'string' || typeof body.From !== 'string' || typeof body.To !== 'string') return null;
    return { providerMessageId: sid, from: body.From, to: body.To, text: typeof body.Body === 'string' ? body.Body : '' };
  }

  webhookAck() {
    return { contentType: 'text/xml', body: '<Response></Response>' };
  }

  async send(message: OutboundMessage, credentials: MessagingCredentials, signal?: AbortSignal): Promise<{ providerMessageId: string }> {
    const { accountSid, authToken } = credentials;
    if (!accountSid || !authToken) throw new Error('Twilio messaging needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    const base = (credentials.apiUrl ?? 'https://api.twilio.com').replace(/\/$/, '');
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetcher(`${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: message.from, To: message.to, Body: message.text }).toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) : AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.ok) {
        const data = (await response.json()) as { sid?: string };
        return { providerMessageId: data.sid ?? '' };
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= 2) {
        const detail = (await response.json().catch(() => null)) as { code?: number; message?: string } | null;
        throw new Error(`Twilio send failed with HTTP ${response.status}${detail?.code ? ` (code ${detail.code}: ${detail.message})` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
