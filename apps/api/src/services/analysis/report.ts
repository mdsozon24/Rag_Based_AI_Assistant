/**
 * The end-of-call-report webhook: queued once per call, when its analysis reaches a final state
 * (succeeded, failed, or skipped), so the report carries the results. Queuing writes a delivery row
 * for the most specific subscribed endpoint (call > assistant > phone > org); the delivery worker
 * (services/webhookDelivery.ts) sends it, signed, with retries.
 *
 * Privacy: the call facts and the analysis results always go to a subscribed endpoint (they are the
 * point of the report). The transcript lines go only to endpoints that opted in (`transcriptOptIn`).
 */
import type { EncryptedSecret } from '../../../../../packages/engine/src/credentials/cipher.ts';
import { newId } from '../../auth/crypto.ts';
import type { Queryable } from '../../db/database.ts';
import { iso } from '../../http/validation.ts';
import { selectWebhookEndpoint, webhookBody, type WebhookEndpoint, type WebhookEventType } from '../webhooks.ts';
import { ANALYSIS_COLUMNS, analysisView, type AnalysisFullRow } from './view.ts';
import { loadTranscript, transcriptViews } from './transcript.ts';

interface CallFacts {
  id: string;
  assistant_id: string | null;
  assistant_name: string;
  phone_number_id: string | null;
  type: string;
  direction: string;
  customer_number: string | null;
  campaign_id: string | null;
  status: string;
  end_reason: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
  usage: unknown;
}

/** Queue a call event for the most specific subscribed endpoint. Returns false when nobody subscribed. */
export async function enqueueCallEvent(tx: Queryable, call: { id: string; orgId: string; assistantId: string | null; phoneNumberId: string | null }, event: WebhookEventType, buildData: (endpoint: { transcriptOptIn: boolean }) => Promise<Record<string, unknown>>, dueAt: Date = new Date()): Promise<boolean> {
  const rows = (
    await tx.query<{ id: string; scope_type: WebhookEndpoint['scopeType']; scope_id: string | null; events: WebhookEventType[]; transcript_opt_in: boolean; enabled: boolean }>(
      `SELECT id, scope_type, scope_id, events, transcript_opt_in, enabled FROM webhook_endpoint
        WHERE org_id = $1 AND enabled AND $2 = ANY (events)
          AND (scope_type = 'org' OR (scope_type = 'assistant' AND scope_id = $3) OR (scope_type = 'phone' AND scope_id = $4) OR (scope_type = 'call' AND scope_id = $5))`,
      [call.orgId, event, call.assistantId, call.phoneNumberId, call.id]
    )
  ).rows;
  const endpoint = selectWebhookEndpoint(
    rows.map((r) => ({ id: r.id, orgId: call.orgId, scopeType: r.scope_type, scopeId: r.scope_id, url: '', headers: {}, secretEncrypted: {} as EncryptedSecret, events: r.events, transcriptOptIn: r.transcript_opt_in, enabled: r.enabled })),
    event
  );
  if (!endpoint) return false;
  const sequence = Number((await tx.query<{ next: string }>('SELECT (coalesce(max(sequence), 0) + 1)::text AS next FROM webhook_delivery WHERE org_id = $1 AND call_id = $2', [call.orgId, call.id])).rows[0].next);
  const payload = webhookBody(event, call.id, sequence, await buildData({ transcriptOptIn: endpoint.transcriptOptIn }));
  await tx.query('INSERT INTO webhook_delivery (id, org_id, endpoint_id, call_id, sequence, event_type, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)', [newId(), call.orgId, endpoint.id, call.id, sequence, event, JSON.stringify(payload), dueAt.toISOString()]);
  return true;
}

/** Queue the end-of-call-report for a call whose analysis just finished. Safe to call twice: the report goes out once. */
export async function enqueueEndOfCallReport(tx: Queryable, orgId: string, analysisId: string, now: Date): Promise<boolean> {
  const claimed = await tx.query<{ call_id: string }>(`UPDATE call_analysis SET report_enqueued_at = $3::timestamptz WHERE org_id = $1 AND id = $2 AND report_enqueued_at IS NULL RETURNING call_id`, [orgId, analysisId, now.toISOString()]);
  const callId = claimed.rows[0]?.call_id;
  if (!callId) return false;
  const call = (
    await tx.query<CallFacts>(
      `SELECT id, assistant_id, assistant_name, phone_number_id, type, direction, customer_number, campaign_id, status, end_reason, started_at, ended_at, duration_ms, usage FROM call WHERE org_id = $1 AND id = $2`,
      [orgId, callId]
    )
  ).rows[0];
  if (!call) return false;
  const analysis = (await tx.query<AnalysisFullRow>(`SELECT ${ANALYSIS_COLUMNS} FROM call_analysis WHERE org_id = $1 AND id = $2`, [orgId, analysisId])).rows[0];
  return enqueueCallEvent(tx, { id: call.id, orgId, assistantId: call.assistant_id, phoneNumberId: call.phone_number_id }, 'end-of-call-report', async ({ transcriptOptIn }) => ({
    call: {
      id: call.id,
      type: call.type,
      direction: call.direction,
      assistantId: call.assistant_id,
      assistantName: call.assistant_name,
      customerNumber: call.customer_number,
      campaignId: call.campaign_id,
      status: call.status,
      endReason: call.end_reason,
      startedAt: iso(call.started_at),
      endedAt: iso(call.ended_at),
      durationMs: call.duration_ms,
      usage: call.usage ?? null,
    },
    analysis: analysisView(analysis),
    ...(transcriptOptIn ? { transcript: transcriptViews(await loadTranscript(tx, orgId, call.id), call.started_at) } : {}),
  }), now);
}
