import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechDetector, type SpeechEvent } from '../src/vad/speechDetector.ts';
import { SentenceChunker } from '../src/engine/sentenceChunker.ts';
import { CALL_STATES, CallStateMachine, canTransition, InvalidTransitionError, type CallState } from '../src/engine/stateMachine.ts';
import { cutAtWord, PlayoutTracker } from '../src/engine/playout.ts';
import { computeLatency, percentile, summarizeLatency } from '../src/engine/metrics.ts';
import { streamWithRetry, withTimeout, TimeoutError } from '../src/providers/resilience.ts';
import { ProviderError } from '../src/providers/types.ts';
import { silentLogger, createLogger } from '../src/logger.ts';
import { parseAssistantConfig } from '../src/engine/config.ts';
import { noise, tone } from '../src/testing/simulatedCaller.ts';

describe('SpeechDetector', () => {
  function feed(detector: SpeechDetector, clock: { t: number }, frames: Int16Array[]): SpeechEvent[] {
    const events: SpeechEvent[] = [];
    for (const frame of frames) {
      clock.t += 20;
      events.push(...detector.push(frame));
    }
    return events;
  }
  const quiet = (ms: number) => Array.from({ length: ms / 20 }, (_, i) => noise(16000, 20, 30, i + 1));
  const loud = (ms: number) => Array.from({ length: ms / 20 }, () => tone(16000, 20, 6000));

  it('detects speech start after minSpeechMs and speech end after silenceMs', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 100, silenceMs: 400 }, () => clock.t);
    expect(feed(detector, clock, quiet(600))).toEqual([]);
    const startEvents = feed(detector, clock, loud(100));
    expect(startEvents).toEqual([{ type: 'speech-start', at: 600 }]);
    feed(detector, clock, loud(400));
    expect(feed(detector, clock, quiet(380))).toEqual([]);
    const endEvents = feed(detector, clock, quiet(40));
    expect(endEvents).toEqual([{ type: 'speech-end', at: 1100, durationMs: 500 }]);
  });

  it('ignores short noises shorter than minSpeechMs', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 120 }, () => clock.t);
    feed(detector, clock, quiet(600));
    expect(feed(detector, clock, [...loud(60), ...quiet(100), ...loud(60), ...quiet(200)])).toEqual([]);
  });

  it('detects a caller who talks from the very first frame', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 100 }, () => clock.t);
    expect(feed(detector, clock, loud(200)).map((e) => e.type)).toEqual(['speech-start']);
  });

  it('learns steady background noise within one window and then ignores it', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 100, silenceMs: 300 }, () => clock.t);
    const hum = (n: number, seed: number) => Array.from({ length: n }, (_, i) => noise(16000, 20, 600, seed + i));
    // At most one (empty) turn while the noise is being learned
    expect(feed(detector, clock, hum(100, 7)).map((e) => e.type)).toEqual(['speech-start', 'speech-end']);
    expect(feed(detector, clock, hum(150, 500))).toEqual([]);
    // Real speech well above the hum is still detected
    expect(feed(detector, clock, loud(200)).map((e) => e.type)).toEqual(['speech-start']);
  });

  it('applies the extra margin (echo guard) while the agent is speaking', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 100 }, () => clock.t);
    feed(detector, clock, quiet(600));
    detector.configure({ extraMarginDb: 40 });
    expect(feed(detector, clock, Array.from({ length: 10 }, () => tone(16000, 20, 600)))).toEqual([]);
    detector.configure({ extraMarginDb: 0 });
    detector.resetSpeech();
    expect(feed(detector, clock, Array.from({ length: 10 }, () => tone(16000, 20, 600))).map((e) => e.type)).toEqual(['speech-start']);
  });

  it('accepts chunks that are not frame aligned', () => {
    const clock = { t: 0 };
    const detector = new SpeechDetector({ minSpeechMs: 100, silenceMs: 200 }, () => clock.t);
    const audio = [...quiet(600), ...loud(300), ...quiet(300)];
    const joined = new Int16Array(audio.reduce((n, f) => n + f.length, 0));
    audio.reduce((at, f) => (joined.set(f, at), at + f.length), 0);
    const events: SpeechEvent[] = [];
    for (let i = 0; i < joined.length; i += 333) events.push(...detector.push(joined.subarray(i, i + 333)));
    expect(events.map((e) => e.type)).toEqual(['speech-start', 'speech-end']);
  });
});

describe('SentenceChunker', () => {
  it('emits the first sentence as soon as it is complete', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello there')).toEqual([]);
    expect(chunker.push('! How')).toEqual(['Hello there!']);
    expect(chunker.push(' are you today? I')).toEqual(['How are you today?']);
    expect(chunker.flush()).toEqual(['I']);
  });

  it('splits Bangla on the danda without waiting for whitespace', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('আমি ভালো আছি।')).toEqual(['আমি ভালো আছি।']);
    expect(chunker.push('আপনি কেমন আছেন?')).toEqual([]);
    expect(chunker.flush()).toEqual(['আপনি কেমন আছেন?']);
  });

  it('does not split decimals or dots inside words', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('The price is 3.5 dollars per item on example.com today. ')).toEqual(['The price is 3.5 dollars per item on example.com today.']);
  });

  it('lets the first chunk end at a clause boundary once long enough', () => {
    const chunker = new SentenceChunker({ firstClauseMinChars: 20 });
    expect(chunker.push('Well, ')).toEqual([]);
    expect(chunker.push('that is a really good question, and the answer')).toEqual(['Well, that is a really good question,']);
    // Later chunks wait for a full sentence
    expect(chunker.push(' depends, mostly, on context')).toEqual([]);
  });

  it('merges very short follow-up sentences and caps long text', () => {
    const chunker = new SentenceChunker({ minChars: 12, maxChars: 40 });
    expect(chunker.push('First sentence here. ')).toEqual(['First sentence here.']);
    expect(chunker.push('Ok. ')).toEqual([]);
    expect(chunker.push('Then a longer one. ')).toEqual(['Ok. Then a longer one.']);
    const long = chunker.push('word '.repeat(20));
    expect(long.length).toBeGreaterThan(0);
    for (const c of long) expect(c.length).toBeLessThanOrEqual(40);
  });
});

describe('CallStateMachine', () => {
  it('allows the documented transitions and timestamps them', () => {
    let t = 1000;
    const changes: string[] = [];
    const sm = new CallStateMachine(() => t, (c) => changes.push(`${c.from}->${c.to}@${c.at}`));
    t = 1100;
    sm.transition('speaking', 'first message');
    t = 1500;
    sm.transition('listening');
    t = 2000;
    sm.transition('thinking');
    t = 2600;
    sm.transition('speaking');
    t = 3000;
    sm.transition('transferring');
    t = 3100;
    sm.transition('ended');
    expect(changes).toEqual([
      'connecting->speaking@1100',
      'speaking->listening@1500',
      'listening->thinking@2000',
      'thinking->speaking@2600',
      'speaking->transferring@3000',
      'transferring->ended@3100',
    ]);
    expect(sm.enteredAt).toMatchObject({ connecting: 1000, speaking: 1100, listening: 1500, thinking: 2000, transferring: 3000, ended: 3100 });
    expect(sm.history[0].reason).toBe('first message');
  });

  it('rejects illegal transitions', () => {
    const sm = new CallStateMachine();
    expect(() => sm.transition('thinking')).toThrow(InvalidTransitionError);
    sm.transition('listening');
    sm.transition('thinking');
    sm.transition('speaking');
    expect(() => sm.transition('thinking')).toThrow(/speaking -> thinking/);
    sm.transition('ended');
    for (const state of CALL_STATES) if (state !== 'ended') expect(() => sm.transition(state)).toThrow();
  });

  it('can end from every state except ended', () => {
    for (const state of CALL_STATES) expect(canTransition(state, 'ended')).toBe(state !== 'ended');
    expect(canTransition('transferring' as CallState, 'listening')).toBe(false);
  });

  it('treats a same-state transition as a no-op', () => {
    const sm = new CallStateMachine();
    sm.transition('listening');
    expect(sm.transition('listening')).toBeNull();
    expect(sm.history).toHaveLength(1);
  });
});

describe('PlayoutTracker', () => {
  it('schedules audio back to back and reports what was heard at a barge-in', () => {
    let t = 0;
    const tracker = new PlayoutTracker(() => t, 0);
    const a = tracker.beginSegment('Hello there, nice to meet you.'); // 30 chars
    tracker.addAudio(a, 1000);
    tracker.addAudio(a, 1000);
    tracker.completeSegment(a);
    const b = tracker.beginSegment('Here is the second sentence.');
    t = 100;
    tracker.addAudio(b, 2000);
    tracker.completeSegment(b);
    expect(tracker.playbackEndsAt).toBe(4000);

    expect(tracker.heardText(2000).text).toBe('Hello there, nice to meet you.');
    const mid = tracker.heardText(3000); // half of the second segment
    expect(mid.text).toBe('Hello there, nice to meet you. Here is the');
    expect(mid.complete).toBe(false);
    expect(tracker.heardText(4000)).toMatchObject({ complete: true, heardMs: 4000, sentMs: 4000 });
  });

  it('accounts for gaps and the client start-up lead', () => {
    let t = 0;
    const tracker = new PlayoutTracker(() => t, 100);
    const a = tracker.beginSegment('one two three four');
    tracker.addAudio(a, 400); // plays 100..500
    tracker.completeSegment(a);
    t = 900; // buffer ran dry; next audio starts at 900 + 100
    const b = tracker.beginSegment('five six');
    expect(tracker.addAudio(b, 400)).toBe(1000);
    expect(tracker.heardText(950).text).toBe('one two three four');
    expect(tracker.heardText(80).text).toBe('');
  });

  it('estimates an incomplete segment from the speaking rate', () => {
    let t = 0;
    const tracker = new PlayoutTracker(() => t, 0);
    const a = tracker.beginSegment('aaaa bbbb cccc dddd'); // 19 chars
    tracker.addAudio(a, 1900);
    tracker.completeSegment(a); // 10 chars/s
    const b = tracker.beginSegment('eeee ffff gggg hhhh');
    tracker.addAudio(b, 500); // only part of the audio has arrived
    expect(tracker.heardText(2400).text).toBe('aaaa bbbb cccc dddd eeee');
  });

  it('cuts at whole words', () => {
    expect(cutAtWord('one two three', 0.5)).toBe('one');
    expect(cutAtWord('one two three', 7 / 13)).toBe('one two');
    expect(cutAtWord('one two three', 0)).toBe('');
    expect(cutAtWord('one two three', 1)).toBe('one two three');
  });
});

describe('latency metrics', () => {
  it('computes per-stage latencies from timestamps', () => {
    expect(
      computeLatency({
        userSpeechStartAt: 0,
        userSpeechEndAt: 1000,
        endpointAt: 1600,
        sttFinalAt: 1750,
        llmRequestAt: 1750,
        llmFirstTokenAt: 2050,
        ttsRequestAt: 2100,
        ttsFirstByteAt: 2220,
        agentAudioStartAt: 2225,
      })
    ).toEqual({
      endpointingMs: 600,
      sttFinalMs: 150,
      llmFirstTokenMs: 300,
      ttsFirstByteMs: 120,
      voiceToVoiceMs: 1225,
      pipelineMs: 625,
      bargeInStopMs: undefined,
    });
  });

  it('computes percentiles with interpolation', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBeCloseTo(50.5);
    expect(percentile(values, 95)).toBeCloseTo(95.05);
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([7], 95)).toBe(7);
  });

  it('summarizes p50/p95 per metric, ignoring missing values', () => {
    const summary = summarizeLatency([{ latency: { voiceToVoiceMs: 700 } }, { latency: { voiceToVoiceMs: 900 } }, { latency: {} }]);
    expect(summary.voiceToVoiceMs).toEqual({ count: 2, p50: 800, p95: 890, min: 700, max: 900 });
    expect(summary.sttFinalMs.count).toBe(0);
  });
});

describe('streamWithRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
  }

  const base = { stage: 'llm' as const, provider: 'test', logger: silentLogger, firstChunkTimeoutMs: 1000, idleTimeoutMs: 1000, retryDelayMs: 0 };

  it('retries once when the stream fails before its first chunk', async () => {
    let attempts = 0;
    const result = await collect(
      streamWithRetry(async function* () {
        attempts++;
        if (attempts === 1) throw new Error('503 overloaded');
        yield 'a';
        yield 'b';
      }, { ...base, signal: new AbortController().signal })
    );
    expect(result).toEqual(['a', 'b']);
    expect(attempts).toBe(2);
  });

  it('does not retry after output was produced (would repeat audio)', async () => {
    let attempts = 0;
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const v of streamWithRetry(async function* () {
          attempts++;
          yield 'a';
          throw new Error('connection reset');
        }, { ...base, signal: new AbortController().signal }))
          seen.push(v);
      })()
    ).rejects.toBeInstanceOf(ProviderError);
    expect(attempts).toBe(1);
    expect(seen).toEqual(['a']);
  });

  it('does not retry fatal errors such as a bad API key', async () => {
    let attempts = 0;
    await expect(
      collect(
        streamWithRetry(async function* () {
          attempts++;
          throw new Error('401 Unauthorized: invalid api key');
        }, { ...base, signal: new AbortController().signal })
      )
    ).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  it('times out a stalled first chunk, aborts the attempt and retries', async () => {
    const signals: AbortSignal[] = [];
    const promise = collect(
      streamWithRetry(async function* (signal) {
        signals.push(signal);
        if (signals.length === 1) await new Promise(() => {}); // hangs forever
        yield 'ok';
      }, { ...base, signal: new AbortController().signal })
    );
    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).resolves.toEqual(['ok']);
    expect(signals[0].aborted).toBe(true);
  });

  it('fails with a timeout code after the retry also stalls', async () => {
    const promise = collect(
      streamWithRetry(async function* () {
        await new Promise(() => {});
        yield 'never';
      }, { ...base, signal: new AbortController().signal })
    );
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout', stage: 'llm' });
    await vi.advanceTimersByTimeAsync(2100);
    await assertion;
  });

  it('ends quietly when the caller aborts', async () => {
    const controller = new AbortController();
    const promise = collect(
      streamWithRetry(async function* (signal) {
        yield 1;
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        yield 2;
      }, { ...base, signal: controller.signal })
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(promise).resolves.toEqual([1]);
  });

  it('withTimeout rejects with TimeoutError', async () => {
    const promise = withTimeout(new Promise(() => {}), 50, 'thing');
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });
});

describe('logger and config', () => {
  it('writes JSON lines with bindings and serialized errors', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) }).child({ call_id: 'c1' });
    log.debug({}, 'hidden');
    log.warn({ err: new Error('boom'), stage: 'tts' }, 'provider failed');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', call_id: 'c1', stage: 'tts', err: { message: 'boom' }, msg: 'provider failed' });
  });

  it('fills defaults and validates fallback transfer targets', () => {
    const config = parseAssistantConfig({});
    expect(config.endpointing.silenceMs).toBe(600);
    expect(config.firstMessage.mode).toBe('assistant-speaks-first');
    expect(() => parseAssistantConfig({ fallback: { action: 'transfer', transferTo: 'nobody' } })).toThrow(/transferTo/);
    expect(() => parseAssistantConfig({ endpointing: { silenceMs: 10 } })).toThrow();
  });
});
