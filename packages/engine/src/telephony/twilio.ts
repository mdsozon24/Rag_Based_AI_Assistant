import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Transport } from '../transport/types.ts';
import { TelephonyDialError, type OutboundCallRequest, type TelephonyAdapter, type TelephonyCall } from './types.ts';

export class TwilioAdapter implements TelephonyAdapter {
  readonly provider = 'twilio' as const;

  verifyWebhookSignature(rawUrl: string, headers: Record<string, string>, body: string | Record<string, unknown>, secret: string): boolean {
    const signature = headers['x-twilio-signature'] ?? headers['X-Twilio-Signature'];
    if (!signature) return false;
    const params = typeof body === 'string' ? body : Object.keys(body).sort().map((key) => `${key}${String(body[key])}`).join('');
    const digest = createHmac('sha1', secret).update(rawUrl + params).digest('base64');
    return signature.length === digest.length && timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }

  inboundResponse(streamUrl: string): string {
    return `<Response><Connect><Stream url="${escapeXml(streamUrl)}" /></Connect></Response>`;
  }

  async startOutbound(request: OutboundCallRequest, credentials: Record<string, string>): Promise<TelephonyCall> {
    const accountSid = credentials.accountSid;
    const authToken = credentials.authToken;
    if (!accountSid || !authToken || !credentials.apiUrl) throw new Error('Twilio accountSid, authToken and apiUrl are required');
    const form = new URLSearchParams({ To: request.to, From: request.from.e164, Twiml: this.inboundResponse(request.streamUrl), MachineDetection: request.voicemailDetection ? 'Enable' : 'Disable' });
    if (request.statusCallbackUrl) {
      form.set('StatusCallback', request.statusCallbackUrl);
      form.set('StatusCallbackMethod', 'POST');
      for (const event of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', event);
    }
    let response: Response;
    try {
      response = await fetch(`${credentials.apiUrl.replace(/\/$/, '')}/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // The request may have reached Twilio before the connection failed or timed out
      throw new TelephonyDialError(`Twilio outbound call request failed: ${(error as Error).message}`, 'maybe');
    }
    if (!response.ok) throw new TelephonyDialError(`Twilio outbound call failed with HTTP ${response.status}`, 'no', response.status);
    const data = await response.json() as { sid: string; status?: string };
    return { providerCallId: data.sid, streamUrl: request.streamUrl, status: data.status === 'in-progress' ? 'in-progress' : 'queued' };
  }

  async importNumber(e164: string, _credentials: Record<string, string>) { return { providerNumberId: e164, capabilities: ['voice', 'sms'] }; }
  async buyNumber(_country: string, _credentials: Record<string, string>): Promise<{ providerNumberId: string; e164: string; capabilities: string[] }> { throw new Error('Twilio number search and purchase must be enabled with an account-specific implementation'); }
  createTransport(_metadata: { callId: string; streamId?: string }): Transport { throw new Error('Twilio media transport gateway is not configured'); }
}

function escapeXml(value: string): string { return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] as string); }