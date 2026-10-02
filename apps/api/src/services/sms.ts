/**
 * Inbound SMS → chat session → SMS reply. Optional per number: only numbers whose capabilities
 * include "sms" answer, with the assistant or squad assigned to the number.
 *
 * Order for each inbound message (after the webhook was verified and acknowledged):
 * 1. Webhook retries of a message already answered (provider message id) are ignored.
 * 2. Keywords: STOP/UNSUBSCRIBE/... records an org-wide opt-out, ends the conversation and sends one
 *    confirmation; START resubscribes; HELP answers with how to opt out. None reach the assistant.
 * 3. An opted-out customer gets no reply and no assistant turn.
 * 4. Otherwise the active SMS session for (our number, customer) continues, or a new one starts.
 * 5. The reply is split to the segment limits and sent message by message.
 */
import type { FastifyBaseLogger } from 'fastify';
import { splitSms, smsKeyword } from '../../../../packages/engine/src/messaging/sms.ts';
import type { InboundMessage, MessagingAdapter } from '../../../../packages/engine/src/messaging/types.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import type { SessionRow } from './chat.ts';

export const SMS_TEXT = {
  optedOut: 'You are unsubscribed and will get no more messages from this number. Reply START to resubscribe.',
  optedIn: 'You are subscribed again. Reply STOP to unsubscribe.',
  help: 'Reply STOP to unsubscribe, START to resubscribe. Message and data rates may apply.',
};

interface PhoneRow {
  id: string;
  org_id: string;
  provider: string;
  e164: string;
  assistant_id: string | null;
  squad_id: string | null;
}

export class SmsService {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly ctx: AppContext) {}

  /** Resolves when every accepted inbound message has been answered (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Accept a verified inbound message; the reply is produced in the background. */
  accept(adapter: MessagingAdapter, inbound: InboundMessage, log: FastifyBaseLogger): void {
    const key = `${adapter.provider}:${inbound.providerMessageId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const work = this.handle(adapter, inbound, log.child({ provider_message_id: inbound.providerMessageId }))
      .catch((err: unknown) => log.error({ err }, 'inbound SMS failed'))
      .finally(() => {
        this.inFlight.delete(key);
        this.pending.delete(work);
      });
    this.pending.add(work);
  }

  private async handle(adapter: MessagingAdapter, inbound: InboundMessage, log: FastifyBaseLogger): Promise<void> {
    // Identity lookup (owner connection): the number says which org this is
    const phone = (
      await this.ctx.db.query<PhoneRow>(`SELECT id, org_id, provider, e164, assistant_id, squad_id FROM phone_number WHERE e164 = $1 AND status = 'active' AND 'sms' = ANY(capabilities)`, [inbound.to])
    ).rows.find((row) => adapter.provider === 'fake' || row.provider === adapter.provider);
    if (!phone) {
      log.warn({ to: inbound.to }, 'inbound SMS for a number without SMS enabled; ignored');
      return;
    }
    const orgId = phone.org_id;
    const smsLog = log.child({ org_id: orgId, phone_number_id: phone.id });
    const send = (text: string) => this.send(adapter, phone, inbound.from, text, smsLog);

    const keyword = smsKeyword(inbound.text);
    const optedOut = await this.ctx.tenants.withOrg(orgId, async (tx) => {
      if (keyword === 'opt-out') {
        await tx.query(
          `INSERT INTO sms_opt_out (org_id, customer_number, keyword, phone_number_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, customer_number) DO UPDATE SET keyword = EXCLUDED.keyword, phone_number_id = EXCLUDED.phone_number_id, created_at = now()`,
          [orgId, inbound.from, inbound.text.trim().toUpperCase().slice(0, 20), phone.id]
        );
        return true;
      }
      if (keyword === 'opt-in') {
        await tx.query('DELETE FROM sms_opt_out WHERE org_id = $1 AND customer_number = $2', [orgId, inbound.from]);
        return false;
      }
      return (await tx.query('SELECT 1 FROM sms_opt_out WHERE org_id = $1 AND customer_number = $2', [orgId, inbound.from])).rows.length > 0;
    });

    if (keyword === 'opt-out') {
      smsLog.info({}, 'customer opted out of SMS');
      const active = await this.ctx.chat.findSmsSession(orgId, phone.id, inbound.from);
      if (active) await this.ctx.chat.endSession(orgId, active.id, 'opted-out');
      await send(SMS_TEXT.optedOut);
      return;
    }
    if (keyword === 'opt-in') {
      smsLog.info({}, 'customer opted back in to SMS');
      await send(SMS_TEXT.optedIn);
      return;
    }
    if (keyword === 'help') {
      await send(SMS_TEXT.help);
      return;
    }
    if (optedOut) {
      smsLog.info({}, 'message from an opted-out customer; not answered');
      return;
    }
    if (!phone.assistant_id && !phone.squad_id) {
      smsLog.warn({}, 'number has SMS enabled but no assistant or squad; not answered');
      return;
    }

    let session: SessionRow | null = await this.ctx.chat.findSmsSession(orgId, phone.id, inbound.from);
    session ??= await this.ctx.chat.createSession(orgId, {
      channel: 'sms',
      actor: { type: 'system', id: null },
      ...(phone.assistant_id ? { assistantId: phone.assistant_id } : { squadId: phone.squad_id as string }),
      variables: { customer_number: inbound.from, phone_number: phone.e164 },
      phoneNumberId: phone.id,
      customerNumber: inbound.from,
    });

    let reply: string;
    try {
      const outcome = await this.ctx.chat.runTurn(orgId, session.id, inbound.text, { logger: smsLog, signal: new AbortController().signal, providerMessageId: inbound.providerMessageId });
      reply = outcome.reply;
    } catch (error) {
      if (error instanceof ApiError && error.details?.reason === 'duplicate_message') return;
      // The model is down: the assistant's fallback message, if it has one, rather than silence
      const fallback = typeof (session.config as { fallbackMessage?: unknown }).fallbackMessage === 'string' ? (session.config as { fallbackMessage: string }).fallbackMessage : '';
      smsLog.error({ err: error }, 'SMS turn failed');
      if (error instanceof ApiError && error.code === 'upstream_unavailable' && fallback.trim()) await send(fallback);
      return;
    }
    await send(reply);
  }

  private async send(adapter: MessagingAdapter, phone: PhoneRow, to: string, text: string, log: FastifyBaseLogger): Promise<void> {
    const parts = splitSms(text, { maxSegmentsPerMessage: this.ctx.config.sms.maxSegmentsPerMessage, maxMessages: this.ctx.config.sms.maxMessagesPerReply });
    for (const [index, part] of parts.entries()) {
      try {
        const sent = await adapter.send({ from: phone.e164, to, text: part }, this.ctx.config.twilio);
        log.info({ part: index + 1, of: parts.length, provider_message_id: sent.providerMessageId, chars: part.length }, 'SMS sent');
      } catch (err) {
        // Later parts would read out of order without this one
        log.error({ err, part: index + 1, of: parts.length }, 'SMS send failed; remaining parts not sent');
        return;
      }
    }
  }
}
