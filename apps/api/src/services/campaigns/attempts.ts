/**
 * The attempt ledger: recording how a dial attempt ended and what happens to its contact.
 *
 * finishAttempt is the only place an attempt reaches "done". It is idempotent (a duplicate provider
 * callback or a second reconcile does nothing) and runs in one org transaction with the contact row
 * locked, so the contact's status always agrees with its attempts.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../../db/database.ts';
import type { Metrics } from '../../observability/metrics.ts';
import { enqueueAnalysis } from '../analysis/worker.ts';
import { addToDnc, isOnDnc } from './dnc.ts';
import { decideNext, endReasonFor, isFinalStatus, outcomeOf, type AttemptOutcome, type ProviderEvent } from './outcome.ts';

export interface AttemptRow {
  id: string;
  org_id: string;
  campaign_id: string;
  contact_id: string;
  attempt_no: number;
  status: 'claimed' | 'dialing' | 'ringing' | 'in-progress' | 'done' | 'skipped';
  outcome: AttemptOutcome | null;
  call_id: string;
  provider_call_id: string | null;
  answered_by: string | null;
  claimed_at: Date;
  dialed_at: Date | null;
  answered_at: Date | null;
}

const ATTEMPT_COLUMNS = 'id, org_id, campaign_id, contact_id, attempt_no, status, outcome, call_id, provider_call_id, answered_by, claimed_at, dialed_at, answered_at';

/** End reasons we write ourselves for calls that never connected; never evidence about a conversation. */
const SYNTHETIC_END_REASONS = new Set(['dial-unconfirmed', 'call-lost', 'dial-failed', 'no-answer', 'busy', 'voicemail', 'canceled']);

export interface Finish {
  orgId: string;
  attemptId: string;
  outcome: AttemptOutcome;
  now: Date;
  answeredBy?: string | null;
  /** From the engine when it knows; otherwise the call row's end reason is used. */
  endReason?: string | null;
  durationSeconds?: number | null;
  error?: string | null;
  providerCallId?: string | null;
}

export interface Finished {
  applied: boolean;
  contactStatus?: string;
}

/**
 * Record the final outcome of an attempt and move its contact on (completed, retry later, failed,
 * do-not-call). A call we had closed as unconfirmed or lost can still be corrected once the provider
 * reports what really happened.
 */
export async function finishAttempt(tx: Queryable, finish: Finish, log: FastifyBaseLogger, metrics?: Metrics): Promise<Finished> {
  const attempt = (await tx.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM campaign_attempt WHERE org_id = $1 AND id = $2 FOR UPDATE`, [finish.orgId, finish.attemptId])).rows[0];
  if (!attempt || attempt.status === 'skipped') return { applied: false };
  const correction = attempt.status === 'done';
  if (correction && !((attempt.outcome === 'unconfirmed' || attempt.outcome === 'lost') && finish.outcome !== 'unconfirmed' && finish.outcome !== 'lost')) return { applied: false };

  const contact = (
    await tx.query<{ id: string; e164: string; status: string; attempts: number; last_call_id: string | null }>(
      'SELECT id, e164, status, attempts, last_call_id FROM campaign_contact WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [finish.orgId, attempt.contact_id]
    )
  ).rows[0];
  const campaign = (await tx.query<{ status: string; max_retries: number; retry_delay_minutes: number }>('SELECT status, max_retries, retry_delay_minutes FROM campaign WHERE org_id = $1 AND id = $2', [finish.orgId, attempt.campaign_id])).rows[0];
  const call = (await tx.query<{ status: string; end_reason: string | null }>('SELECT status, end_reason FROM call WHERE org_id = $1 AND id = $2', [finish.orgId, attempt.call_id])).rows[0];
  if (!contact || !campaign) return { applied: false };

  const callReason = call?.end_reason && !SYNTHETIC_END_REASONS.has(call.end_reason) ? call.end_reason : null;
  const endReason = finish.endReason ?? callReason;
  const now = finish.now.toISOString();
  const optedOut = contact.status === 'do_not_call' || endReason === 'opted-out' || (await isOnDnc(tx, finish.orgId, contact.e164));
  // The engine hook normally listed the number already; make sure an opt-out end reason always does
  if (endReason === 'opted-out') await addToDnc(tx, finish.orgId, contact.e164, { source: 'opt-out', reason: 'The call ended as an opt-out', campaignId: attempt.campaign_id, callId: attempt.call_id, actor: { type: 'system', id: null } });

  const answeredBy = finish.answeredBy ?? attempt.answered_by;
  await tx.query(
    `UPDATE campaign_attempt SET status = 'done', outcome = $3, ended_at = $4::timestamptz, duration_seconds = coalesce($5, duration_seconds), answered_by = $6,
       end_reason = $7, error = $8, provider_call_id = coalesce(provider_call_id, $9) WHERE org_id = $1 AND id = $2`,
    [finish.orgId, finish.attemptId, finish.outcome, now, finish.durationSeconds ?? null, answeredBy ?? null, endReason, finish.error?.slice(0, 500) ?? null, finish.providerCallId ?? null]
  );

  const connected = finish.outcome === 'answered' || finish.outcome === 'voicemail' || finish.outcome === 'no-answer' || finish.outcome === 'busy' || finish.outcome === 'canceled';
  await tx.query(
    `UPDATE call SET status = $3, ended_at = $4::timestamptz, duration_ms = coalesce(duration_ms, $5), voicemail_detected = $6, end_reason = coalesce(end_reason, $7)
     WHERE org_id = $1 AND id = $2 AND (status NOT IN ('ended', 'failed') OR end_reason IN ('dial-unconfirmed', 'call-lost'))`,
    [finish.orgId, attempt.call_id, connected ? 'ended' : 'failed', now, finish.durationSeconds != null ? finish.durationSeconds * 1000 : null, finish.outcome === 'voicemail', endReasonFor(finish.outcome)]
  );
  if (correction) await tx.query(`UPDATE call SET end_reason = $3 WHERE org_id = $1 AND id = $2 AND end_reason IN ('dial-unconfirmed', 'call-lost')`, [finish.orgId, attempt.call_id, endReasonFor(finish.outcome) ?? endReason]);
  // The call is over: queue its analysis (no transcript yet for phone calls, so it is skipped and the report still goes out)
  await enqueueAnalysis(tx, finish.orgId, attempt.call_id, finish.now);
  if (!correction) metrics?.callsEnded.inc({ reason: endReason ?? endReasonFor(finish.outcome) ?? 'completed', type: 'outbound' });

  // A correction only moves the contact if no later attempt has started since
  if (correction && contact.last_call_id !== attempt.call_id) return { applied: true, contactStatus: contact.status };
  if (!correction && contact.status !== 'calling' && contact.status !== 'do_not_call') return { applied: true, contactStatus: contact.status };
  const next = decideNext({
    outcome: finish.outcome,
    endReason,
    optedOut,
    attemptsMade: contact.attempts,
    maxRetries: campaign.max_retries,
    retryDelayMinutes: campaign.retry_delay_minutes,
    campaignCancelled: campaign.status === 'cancelled',
    now: finish.now,
  });
  await tx.query(
    `UPDATE campaign_contact SET status = $3, next_attempt_at = $4::timestamptz, last_outcome = $5, last_call_id = $6, updated_at = now() WHERE org_id = $1 AND id = $2`,
    [finish.orgId, contact.id, next.status, next.nextAttemptAt?.toISOString() ?? null, finish.outcome, attempt.call_id]
  );
  log.info({ org_id: finish.orgId, campaign_id: attempt.campaign_id, contact_id: contact.id, attempt_id: attempt.id, call_id: attempt.call_id, attempt_no: attempt.attempt_no, outcome: finish.outcome, end_reason: endReason, contact_status: next.status, correction }, 'campaign attempt finished');
  return { applied: true, contactStatus: next.status };
}

/**
 * A provider callback for an attempt. Events can arrive out of order or twice, so progress only moves
 * forward and a final event is applied once. Returns the campaign id when the attempt finished.
 */
export async function applyProviderEvent(
  tx: Queryable,
  orgId: string,
  attemptId: string,
  event: ProviderEvent,
  now: Date,
  log: FastifyBaseLogger,
  metrics?: Metrics
): Promise<{ result: 'ignored' | 'progress' | 'finished' | 'duplicate'; campaignId?: string }> {
  const attempt = (await tx.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM campaign_attempt WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, attemptId])).rows[0];
  if (!attempt || attempt.status === 'skipped' || attempt.status === 'claimed') {
    // A call we never dialed (or have not dialed yet): this event cannot belong to this attempt
    log.warn({ org_id: orgId, attempt_id: attemptId, provider_call_id: event.providerCallId }, 'provider event for an attempt that was not dialed; ignored');
    return { result: 'ignored' };
  }
  if (attempt.provider_call_id && attempt.provider_call_id !== event.providerCallId) {
    log.warn({ org_id: orgId, attempt_id: attemptId, call_id: attempt.call_id, expected: attempt.provider_call_id, got: event.providerCallId }, 'provider event for another call; ignored');
    return { result: 'ignored' };
  }
  const nowIso = now.toISOString();
  if (isFinalStatus(event.status)) {
    const outcome = outcomeOf(event.status, event.answeredBy ?? (attempt.answered_by === 'machine' || attempt.answered_by === 'fax' ? (attempt.answered_by as 'machine' | 'fax') : undefined));
    const done = await finishAttempt(
      tx,
      { orgId, attemptId, outcome, now, answeredBy: event.answeredBy ?? null, durationSeconds: event.durationSeconds ?? null, error: event.errorCode ? `Provider error ${event.errorCode}` : null, providerCallId: event.providerCallId },
      log,
      metrics
    );
    return done.applied ? { result: 'finished', campaignId: attempt.campaign_id } : { result: 'duplicate' };
  }
  if (attempt.status === 'done') return { result: 'duplicate' };

  const rank = { dialing: 0, ringing: 1, 'in-progress': 2 } as const;
  const target = event.status === 'in-progress' ? 'in-progress' : 'ringing';
  const advance = rank[target] > rank[attempt.status as keyof typeof rank];
  await tx.query(
    `UPDATE campaign_attempt SET status = CASE WHEN $3 THEN $4 ELSE status END, provider_call_id = coalesce(provider_call_id, $5),
       answered_at = CASE WHEN $4 = 'in-progress' AND answered_at IS NULL THEN $6::timestamptz ELSE answered_at END, answered_by = coalesce($7, answered_by)
     WHERE org_id = $1 AND id = $2`,
    [orgId, attemptId, advance, target, event.providerCallId, nowIso, event.answeredBy ?? null]
  );
  if (advance) {
    await tx.query(
      `UPDATE call SET status = $3, provider_call_id = coalesce(provider_call_id, $4), started_at = CASE WHEN $3 = 'in-progress' THEN coalesce(started_at, $5::timestamptz) ELSE started_at END
       WHERE org_id = $1 AND id = $2 AND status IN ('queued', 'ringing')`,
      [orgId, attempt.call_id, target, event.providerCallId, nowIso]
    );
  }
  return { result: 'progress', campaignId: attempt.campaign_id };
}
