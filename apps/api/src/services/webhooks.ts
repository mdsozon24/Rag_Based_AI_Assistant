import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CredentialCipher, EncryptedSecret } from '../../../../packages/engine/src/credentials/cipher.ts';
import { newId } from '../auth/crypto.ts';
import type { Queryable } from '../db/database.ts';

export const WEBHOOK_EVENTS = ['call.started', 'status-update', 'transcript', 'conversation-update', 'tool-calls', 'transfer-destination-request', 'assistant-request', 'hang', 'speech-update', 'end-of-call-report', 'chat.started', 'chat.message', 'chat.tool-calls', 'chat.ended'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEndpoint {
  id: string;
  orgId: string;
  scopeType: 'org' | 'phone' | 'assistant' | 'call';
  scopeId: string | null;
  url: string;
  headers: Record<string, string>;
  secretEncrypted: EncryptedSecret;
  events: WebhookEventType[];
  transcriptOptIn: boolean;
  enabled: boolean;
}

/** Most-specific endpoint wins: call > assistant > phone > org. */
export function selectWebhookEndpoint(endpoints: WebhookEndpoint[], event: WebhookEventType): WebhookEndpoint | undefined {
  const rank = { call: 4, assistant: 3, phone: 2, org: 1 } as const;
  return endpoints.filter((endpoint) => endpoint.enabled && endpoint.events.includes(event)).sort((a, b) => rank[b.scopeType] - rank[a.scopeType])[0];
}

export function webhookBody(event: WebhookEventType, callId: string, sequence: number, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `evt_${callId}_${sequence}`, type: event, createdAt: new Date().toISOString(), callId, sequence, data };
}

export function signWebhook(secret: string, timestamp: number, payload: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhookSignature(secret: string, signature: string, payload: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const timestamp = Number(/^t=(\d+)/.exec(signature)?.[1]);
  const received = /^t=\d+,v1=([a-f0-9]+)$/.exec(signature)?.[1];
  if (!Number.isInteger(timestamp) || !received || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = signWebhook(secret, timestamp, payload).split(',v1=')[1];
  return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function backoffMs(attempt: number): number { return Math.min(60_000, 500 * 2 ** Math.max(0, attempt - 1)); }

export async function callSyncWebhook(endpoint: WebhookEndpoint, secret: string, body: Record<string, unknown>, fetcher: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>, timeoutMs: number, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body); const timestamp = Math.floor(Date.now() / 1000); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetcher(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', ...endpoint.headers, 'x-octo-signature': signWebhook(secret, timestamp, payload), 'x-octo-event': String(body.type) }, body: payload, signal: controller.signal }); return response.ok ? await response.json() as Record<string, unknown> : fallback; } catch { return fallback; } finally { clearTimeout(timer); }
}

export function decryptWebhookSecret(cipher: CredentialCipher, encrypted: EncryptedSecret, orgId: string, endpointId: string): string { return cipher.decrypt(encrypted, `${orgId}:webhook:${endpointId}:secret`); }

/**
 * Queue a chat event for the most specific subscribed endpoint (assistant > phone > org) as a
 * pending delivery row, numbered per session. Message text is included only for endpoints that
 * opted in to transcripts. Sending is the delivery worker's job (manual redelivery until it exists).
 */
export async function enqueueChatEvent(
  tx: Queryable,
  session: { id: string; orgId: string; assistantId: string | null; phoneNumberId: string | null },
  event: Extract<WebhookEventType, `chat.${string}`>,
  data: Record<string, unknown>,
  transcriptFields: string[] = []
): Promise<boolean> {
  const rows = (
    await tx.query<{ id: string; scope_type: WebhookEndpoint['scopeType']; scope_id: string | null; events: WebhookEventType[]; transcript_opt_in: boolean; enabled: boolean }>(
      `SELECT id, scope_type, scope_id, events, transcript_opt_in, enabled FROM webhook_endpoint
        WHERE org_id = $1 AND enabled AND $2 = ANY(events)
          AND (scope_type = 'org' OR (scope_type = 'assistant' AND scope_id = $3) OR (scope_type = 'phone' AND scope_id = $4))`,
      [session.orgId, event, session.assistantId, session.phoneNumberId]
    )
  ).rows;
  const endpoint = selectWebhookEndpoint(
    rows.map((r) => ({ id: r.id, orgId: session.orgId, scopeType: r.scope_type, scopeId: r.scope_id, url: '', headers: {}, secretEncrypted: {} as EncryptedSecret, events: r.events, transcriptOptIn: r.transcript_opt_in, enabled: r.enabled })),
    event
  );
  if (!endpoint) return false;
  const payloadData = endpoint.transcriptOptIn ? data : Object.fromEntries(Object.entries(data).filter(([key]) => !transcriptFields.includes(key)));
  const sequence = Number((await tx.query<{ next: string }>('SELECT (coalesce(max(sequence), 0) + 1)::text AS next FROM webhook_delivery WHERE org_id = $1 AND chat_session_id = $2', [session.orgId, session.id])).rows[0].next);
  const payload = { id: `evt_${session.id}_${sequence}`, type: event, createdAt: new Date().toISOString(), sessionId: session.id, sequence, data: payloadData };
  await tx.query(
    `INSERT INTO webhook_delivery (id, org_id, endpoint_id, chat_session_id, sequence, event_type, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), session.orgId, endpoint.id, session.id, sequence, event, JSON.stringify(payload)]
  );
  return true;
}
