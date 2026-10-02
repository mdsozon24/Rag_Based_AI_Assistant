/**
 * What happened on a call attempt, and what happens to the contact next. Pure functions (no clock,
 * no database) so every rule is unit-tested.
 *
 * Retry rules:
 * - no-answer, busy, voicemail and a dial request the provider rejected with a server error are
 *   retried after the campaign's delay, until 1 + maxRetries attempts have been made;
 * - an answered call is a completed conversation and is never retried, unless the platform itself
 *   failed during it (an error-* end reason): then the person did not really get a conversation;
 * - an opt-out ends everything for that number;
 * - calls we cannot account for (unconfirmed dial, lost call) and calls the provider rejected for
 *   good (bad number) are not retried: a retry could ring someone who already picked up.
 */

export const ATTEMPT_OUTCOMES = ['answered', 'voicemail', 'no-answer', 'busy', 'failed', 'canceled', 'dial-error', 'unconfirmed', 'lost'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export type ContactStatus = 'pending' | 'calling' | 'completed' | 'failed' | 'do_not_call' | 'cancelled' | 'expired';

const RETRYABLE: ReadonlySet<AttemptOutcome> = new Set(['no-answer', 'busy', 'voicemail', 'dial-error']);

/** End reasons that mean our side failed, so an answered call was not a real conversation. */
export function isPlatformFailure(endReason: string | null | undefined): boolean {
  return !!endReason && /^(error-|worker-lost$|server-shutdown$)/.test(endReason);
}

export interface NextInput {
  outcome: AttemptOutcome;
  endReason?: string | null;
  /** The person asked not to be called (do-not-call list or opt-out end reason). */
  optedOut: boolean;
  /** Attempts dialed so far, including this one. */
  attemptsMade: number;
  maxRetries: number;
  retryDelayMinutes: number;
  /** The campaign was cancelled while this call was in flight. */
  campaignCancelled: boolean;
  now: Date;
}

export interface Next {
  status: ContactStatus;
  /** When a pending contact may be dialed again (the schedule may push it later). */
  nextAttemptAt: Date | null;
}

export function decideNext(input: NextInput): Next {
  if (input.optedOut || input.endReason === 'opted-out') return { status: 'do_not_call', nextAttemptAt: null };
  if (input.outcome === 'answered' && !isPlatformFailure(input.endReason)) return { status: 'completed', nextAttemptAt: null };
  const retryable = RETRYABLE.has(input.outcome) || input.outcome === 'answered';
  if (!retryable || input.attemptsMade >= 1 + input.maxRetries) return { status: 'failed', nextAttemptAt: null };
  if (input.campaignCancelled) return { status: 'cancelled', nextAttemptAt: null };
  return { status: 'pending', nextAttemptAt: new Date(input.now.getTime() + input.retryDelayMinutes * 60_000) };
}

// ---------------------------------------------------------------- provider events

export type ProviderStatus = 'initiated' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer' | 'canceled';
export type AnsweredBy = 'human' | 'machine' | 'fax' | 'unknown';

export interface ProviderEvent {
  providerCallId: string;
  status: ProviderStatus;
  answeredBy?: AnsweredBy;
  durationSeconds?: number;
  errorCode?: string;
}

const STATUS: Record<string, ProviderStatus> = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in-progress',
  answered: 'in-progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no-answer',
  canceled: 'canceled',
  cancelled: 'canceled',
};

/**
 * A provider call-progress callback, in Twilio's field names (CallSid, CallStatus, AnsweredBy,
 * CallDuration, ErrorCode); other providers' adapters map to the same fields. Null when the body is
 * not a call event.
 */
export function parseProviderEvent(body: unknown): ProviderEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const sid = typeof b.CallSid === 'string' ? b.CallSid : typeof b.callSid === 'string' ? b.callSid : '';
  const rawStatus = String(b.CallStatus ?? b.callStatus ?? '').toLowerCase();
  const status = STATUS[rawStatus];
  if (!sid || sid.length > 200 || !status) return null;
  const by = String(b.AnsweredBy ?? b.answeredBy ?? '').toLowerCase();
  const answeredBy: AnsweredBy | undefined = !by ? undefined : by === 'human' ? 'human' : by.startsWith('machine') ? 'machine' : by === 'fax' ? 'fax' : 'unknown';
  const duration = Number(b.CallDuration ?? b.callDuration);
  return {
    providerCallId: sid,
    status,
    ...(answeredBy ? { answeredBy } : {}),
    ...(Number.isFinite(duration) && duration >= 0 ? { durationSeconds: Math.round(duration) } : {}),
    ...(b.ErrorCode !== undefined && String(b.ErrorCode) ? { errorCode: String(b.ErrorCode).slice(0, 20) } : {}),
  };
}

export function isFinalStatus(status: ProviderStatus): boolean {
  return status === 'completed' || status === 'busy' || status === 'failed' || status === 'no-answer' || status === 'canceled';
}

/** The attempt outcome for a final provider status. An answering machine or fax is a voicemail. */
export function outcomeOf(status: ProviderStatus, answeredBy: AnsweredBy | undefined): AttemptOutcome {
  switch (status) {
    case 'completed':
      return answeredBy === 'machine' || answeredBy === 'fax' ? 'voicemail' : 'answered';
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no-answer';
    case 'canceled':
      return 'canceled';
    default:
      return 'failed';
  }
}

/** The call row's end reason when the call never had a conversation (engine reasons are kept as they are). */
export function endReasonFor(outcome: AttemptOutcome): string | null {
  switch (outcome) {
    case 'voicemail':
      return 'voicemail';
    case 'no-answer':
      return 'no-answer';
    case 'busy':
      return 'busy';
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'dial-error':
      return 'dial-failed';
    case 'unconfirmed':
      return 'dial-unconfirmed';
    case 'lost':
      return 'call-lost';
    default:
      return null;
  }
}
