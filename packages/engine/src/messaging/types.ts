/**
 * Messaging channel adapters (SMS now; WhatsApp later through the same interface): verify and
 * parse inbound provider webhooks, send outbound messages.
 */
export type MessagingProvider = 'twilio' | 'fake';

export interface InboundMessage {
  /** Provider's message id, used to ignore webhook retries. */
  providerMessageId: string;
  /** Customer number (E.164). */
  from: string;
  /** Our number (E.164). */
  to: string;
  text: string;
}

export interface OutboundMessage {
  from: string;
  to: string;
  text: string;
}

export interface MessagingCredentials {
  accountSid?: string;
  authToken?: string;
  apiUrl?: string;
}

export interface MessagingAdapter {
  readonly provider: MessagingProvider;
  /** Check the provider's signature on an inbound webhook (url as the provider called it). */
  verifyWebhookSignature(url: string, headers: Record<string, string>, body: Record<string, unknown>, secret: string): boolean;
  /** Null when the webhook is not an inbound text (e.g. a status callback). */
  parseInbound(body: Record<string, unknown>): InboundMessage | null;
  /** Body to answer the webhook with (replies are sent separately with send()). */
  webhookAck(): { contentType: string; body: string };
  send(message: OutboundMessage, credentials: MessagingCredentials, signal?: AbortSignal): Promise<{ providerMessageId: string }>;
}
