import type { Transport } from '../transport/types.ts';

export type TelephonyProvider = 'twilio' | 'telnyx' | 'vonage' | 'sip';
export type CallDirection = 'inbound' | 'outbound';

export interface PhoneNumberRecord {
  id: string;
  provider: TelephonyProvider;
  providerNumberId: string;
  e164: string;
  capabilities: string[];
}

export interface InboundWebhook {
  providerCallId: string;
  to: string;
  from: string;
  streamUrl: string;
  voicemail?: boolean;
  variables?: Record<string, string>;
}

export interface OutboundCallRequest {
  to: string;
  from: PhoneNumberRecord;
  streamUrl: string;
  voicemailDetection: boolean;
  /** The provider posts call progress here (initiated, ringing, answered, completed, busy, no-answer...). */
  statusCallbackUrl?: string;
}

/**
 * An outbound dial that did not produce a call. `callPlaced` tells the dialer whether retrying could
 * ring the person twice: 'no' when the provider answered with an error (nothing was placed),
 * 'maybe' when the request may have reached the provider (timeout, connection lost).
 */
export class TelephonyDialError extends Error {
  constructor(message: string, readonly callPlaced: 'no' | 'maybe', readonly httpStatus?: number) {
    super(message);
    this.name = 'TelephonyDialError';
  }
}

export interface TelephonyCall {
  providerCallId: string;
  streamUrl: string;
  status: 'queued' | 'ringing' | 'in-progress' | 'ended' | 'failed';
}

export interface TelephonyAdapter {
  readonly provider: TelephonyProvider;
  verifyWebhookSignature(rawUrl: string, headers: Record<string, string>, body: string | Record<string, unknown>, secret: string): boolean;
  inboundResponse(streamUrl: string): string;
  startOutbound(request: OutboundCallRequest, credentials: Record<string, string>): Promise<TelephonyCall>;
  importNumber(e164: string, credentials: Record<string, string>): Promise<{ providerNumberId: string; capabilities: string[] }>;
  buyNumber(country: string, credentials: Record<string, string>): Promise<{ providerNumberId: string; e164: string; capabilities: string[] }>;
  createTransport(metadata: { callId: string; streamId?: string }): Transport;
}