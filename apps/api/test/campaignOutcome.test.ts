/** Retry rules, provider events and dial-error classification: pure logic, no database. */
import { describe, expect, it } from 'vitest';
import { TelephonyDialError } from '../../../packages/engine/src/telephony/types.ts';
import { classifyDialError } from '../src/services/campaigns/dialer.ts';
import { decideNext, endReasonFor, isFinalStatus, outcomeOf, parseProviderEvent, type NextInput } from '../src/services/campaigns/outcome.ts';

const now = new Date('2026-10-05T04:00:00Z');
const base: NextInput = { outcome: 'no-answer', endReason: null, optedOut: false, attemptsMade: 1, maxRetries: 2, retryDelayMinutes: 90, campaignCancelled: false, now };

describe('retry rules (decideNext)', () => {
  it.each(['no-answer', 'busy', 'voicemail', 'dial-error'] as const)('retries %s after the delay while attempts remain', (outcome) => {
    expect(decideNext({ ...base, outcome })).toEqual({ status: 'pending', nextAttemptAt: new Date('2026-10-05T05:30:00Z') });
  });

  it('stops after 1 + maxRetries attempts, keeping the failure', () => {
    expect(decideNext({ ...base, attemptsMade: 2 }).status).toBe('pending');
    expect(decideNext({ ...base, attemptsMade: 3 })).toEqual({ status: 'failed', nextAttemptAt: null });
    expect(decideNext({ ...base, attemptsMade: 1, maxRetries: 0 })).toEqual({ status: 'failed', nextAttemptAt: null });
  });

  it('never retries a completed conversation, however many retries are left', () => {
    expect(decideNext({ ...base, outcome: 'answered', maxRetries: 10 })).toEqual({ status: 'completed', nextAttemptAt: null });
    expect(decideNext({ ...base, outcome: 'answered', endReason: 'assistant-ended-call' }).status).toBe('completed');
    expect(decideNext({ ...base, outcome: 'answered', endReason: 'customer-ended-call' }).status).toBe('completed');
  });

  it('retries an answered call when our platform failed during it', () => {
    for (const endReason of ['error-llm', 'error-stt', 'error-internal', 'worker-lost', 'server-shutdown']) {
      expect(decideNext({ ...base, outcome: 'answered', endReason }).status, endReason).toBe('pending');
    }
  });

  it('never retries after an opt-out, whatever the outcome', () => {
    for (const outcome of ['answered', 'no-answer', 'busy', 'voicemail'] as const) {
      expect(decideNext({ ...base, outcome, optedOut: true })).toEqual({ status: 'do_not_call', nextAttemptAt: null });
    }
    expect(decideNext({ ...base, outcome: 'answered', endReason: 'opted-out' }).status).toBe('do_not_call');
  });

  it('does not retry what it cannot account for or what the provider rejected for good', () => {
    for (const outcome of ['failed', 'canceled', 'unconfirmed', 'lost'] as const) {
      expect(decideNext({ ...base, outcome }), outcome).toEqual({ status: 'failed', nextAttemptAt: null });
    }
  });

  it('closes a retry as cancelled when the campaign was cancelled in the meantime', () => {
    expect(decideNext({ ...base, campaignCancelled: true })).toEqual({ status: 'cancelled', nextAttemptAt: null });
    expect(decideNext({ ...base, outcome: 'answered', campaignCancelled: true }).status).toBe('completed');
  });
});

describe('provider events', () => {
  it('reads Twilio field names and maps statuses', () => {
    expect(parseProviderEvent({ CallSid: 'CA1', CallStatus: 'queued' })).toEqual({ providerCallId: 'CA1', status: 'initiated' });
    expect(parseProviderEvent({ CallSid: 'CA1', CallStatus: 'in-progress', AnsweredBy: 'human' })).toEqual({ providerCallId: 'CA1', status: 'in-progress', answeredBy: 'human' });
    expect(parseProviderEvent({ CallSid: 'CA1', CallStatus: 'completed', CallDuration: '42', AnsweredBy: 'machine_end_beep' })).toEqual({ providerCallId: 'CA1', status: 'completed', answeredBy: 'machine', durationSeconds: 42 });
    expect(parseProviderEvent({ CallSid: 'CA1', CallStatus: 'failed', ErrorCode: '21211' })).toMatchObject({ status: 'failed', errorCode: '21211' });
    expect(parseProviderEvent({ CallSid: 'CA1', CallStatus: 'no-answer' })?.status).toBe('no-answer');
  });

  it('rejects bodies that are not call events', () => {
    for (const body of [null, 'x', {}, { CallSid: 'CA1' }, { CallStatus: 'completed' }, { CallSid: 'CA1', CallStatus: 'exploded' }, { CallSid: 'x'.repeat(300), CallStatus: 'completed' }]) {
      expect(parseProviderEvent(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('turns final statuses into outcomes; an answering machine or fax is a voicemail', () => {
    expect(outcomeOf('completed', 'human')).toBe('answered');
    expect(outcomeOf('completed', undefined)).toBe('answered');
    expect(outcomeOf('completed', 'unknown')).toBe('answered');
    expect(outcomeOf('completed', 'machine')).toBe('voicemail');
    expect(outcomeOf('completed', 'fax')).toBe('voicemail');
    expect(outcomeOf('busy', undefined)).toBe('busy');
    expect(outcomeOf('no-answer', undefined)).toBe('no-answer');
    expect(outcomeOf('failed', undefined)).toBe('failed');
    expect(outcomeOf('canceled', undefined)).toBe('canceled');
    expect(['completed', 'busy', 'failed', 'no-answer', 'canceled'].every((s) => isFinalStatus(s as never))).toBe(true);
    expect(['initiated', 'ringing', 'in-progress'].some((s) => isFinalStatus(s as never))).toBe(false);
    expect(endReasonFor('answered')).toBeNull();
    expect(endReasonFor('lost')).toBe('call-lost');
  });
});

describe('dial errors', () => {
  it('retries only when the provider answered with a server error (nothing was placed)', () => {
    expect(classifyDialError(new TelephonyDialError('HTTP 503', 'no', 503)).outcome).toBe('dial-error');
    expect(classifyDialError(new TelephonyDialError('HTTP 429', 'no', 429)).outcome).toBe('dial-error');
  });

  it('does not retry a rejected request (bad number or credentials)', () => {
    expect(classifyDialError(new TelephonyDialError('HTTP 400', 'no', 400)).outcome).toBe('failed');
    expect(classifyDialError(new TelephonyDialError('HTTP 401', 'no', 401)).outcome).toBe('failed');
  });

  it('marks a request that may have reached the provider as unconfirmed (never retried)', () => {
    expect(classifyDialError(new TelephonyDialError('timeout', 'maybe')).outcome).toBe('unconfirmed');
    expect(classifyDialError(new Error('socket hang up')).outcome).toBe('unconfirmed');
    expect(classifyDialError('boom').outcome).toBe('unconfirmed');
  });
});
