/** Test messaging adapter: JSON webhooks, a switchable signature check, and a record of sent messages. */
import type { InboundMessage, MessagingAdapter, OutboundMessage } from './types.ts';

export class FakeMessagingAdapter implements MessagingAdapter {
  readonly provider = 'fake' as const;
  readonly sent: OutboundMessage[] = [];
  verifyResult = true;
  failSends = 0;

  verifyWebhookSignature(): boolean {
    return this.verifyResult;
  }

  parseInbound(body: Record<string, unknown>): InboundMessage | null {
    if (typeof body.id !== 'string' || typeof body.from !== 'string' || typeof body.to !== 'string') return null;
    return { providerMessageId: body.id, from: body.from, to: body.to, text: typeof body.text === 'string' ? body.text : '' };
  }

  webhookAck() {
    return { contentType: 'application/json', body: '{"ok":true}' };
  }

  async send(message: OutboundMessage): Promise<{ providerMessageId: string }> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('fake send failure');
    }
    this.sent.push({ ...message });
    return { providerMessageId: `fake-out-${this.sent.length}` };
  }
}
