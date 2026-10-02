import type { Transport } from '../transport/types.ts';
import type { OutboundCallRequest, TelephonyAdapter, TelephonyCall } from './types.ts';

export class FakeTelephonyAdapter implements TelephonyAdapter {
  readonly provider = 'sip' as const;
  readonly outbound: OutboundCallRequest[] = [];
  readonly imported: string[] = [];
  verifyResult = true;
  voicemail = false;
  verifyWebhookSignature(): boolean { return this.verifyResult; }
  inboundResponse(streamUrl: string): string { return JSON.stringify({ streamUrl }); }
  async startOutbound(request: OutboundCallRequest): Promise<TelephonyCall> { this.outbound.push(request); return { providerCallId: `fake-${this.outbound.length}`, streamUrl: request.streamUrl, status: this.voicemail ? 'ended' : 'ringing' }; }
  async importNumber(e164: string): Promise<{ providerNumberId: string; capabilities: string[] }> { this.imported.push(e164); return { providerNumberId: `fake-${e164}`, capabilities: ['voice', 'sms'] }; }
  async buyNumber(): Promise<{ providerNumberId: string; e164: string; capabilities: string[] }> { return { providerNumberId: 'fake-bought', e164: '+8801712345678', capabilities: ['voice'] }; }
  createTransport(): Transport { throw new Error('Fake transport is test-controlled'); }
}