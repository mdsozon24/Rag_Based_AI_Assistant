import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PCM16_16K, PCM16_24K } from '../src/audio/format.ts';
import { CallSession } from '../src/engine/callSession.ts';
import { parseAssistantConfig } from '../src/engine/config.ts';
import { EndReason } from '../src/engine/endReason.ts';
import { UsageMeter } from '../src/engine/usage.ts';
import { silentLogger } from '../src/logger.ts';
import { ModelChain, TranscriberChain, VoiceChain, type ChainEntry } from '../src/providers/chain.ts';
import { ProviderError, type LanguageModel, type LlmEvent, type ProviderIdentity } from '../src/providers/types.ts';
import { FakeLlmProvider, FakeSttProvider, FakeTtsProvider } from '../src/testing/fakes.ts';
import { SimulatedCaller } from '../src/testing/simulatedCaller.ts';
import { LoopbackTransport } from '../src/transport/loopback.ts';

function entry<T extends ProviderIdentity>(instance: T, billing: 'platform' | 'customer' = 'platform'): ChainEntry<T> {
  return { instance, provider: instance.provider, model: instance.model, credentialSource: billing === 'platform' ? 'platform' : 'org', billing };
}
const base = (meter: UsageMeter, component: 'transcriber' | 'model' | 'voice', retries = 1) => ({ component, callId: 'c', logger: silentLogger, meter, retries });

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

const request = { systemPrompt: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };

describe('model fallback', () => {
  it('switches to the next model when the primary fails before output, and stays there', async () => {
    const meter = new UsageMeter();
    const a = new FakeLlmProvider([{ error: 'before-first-token' }], { firstTokenMs: 1, provider: 'llm-a' });
    const b = new FakeLlmProvider(['Answer one.', 'Answer two.'], { firstTokenMs: 1, provider: 'llm-b' });
    const chain = new ModelChain([entry(a), entry(b)], base(meter, 'model'), { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });

    const first = await collect(chain.stream(request, new AbortController().signal));
    expect(first.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Answer one.');
    expect(a.requests).toHaveLength(2); // first attempt + one retry
    expect(chain.current.provider).toBe('llm-b');

    await collect(chain.stream(request, new AbortController().signal));
    expect(a.requests).toHaveLength(2); // sticky: the failed primary is not tried again this call
    expect(b.requests).toHaveLength(2);

    const usage = meter.snapshot();
    expect(usage.find((u) => u.provider === 'llm-a')).toMatchObject({ fallback: false, units: { requests: 2 } });
    expect(usage.find((u) => u.provider === 'llm-b')).toMatchObject({ fallback: true, estimated: false, units: { requests: 2 } });
    expect(usage.find((u) => u.provider === 'llm-b')!.units.outputTokens).toBeGreaterThan(0);
  });

  it('does not retry a non-retryable failure (e.g. bad key): goes straight to the fallback', async () => {
    let calls = 0;
    const broken: LanguageModel = {
      provider: 'llm-broken',
      model: 'm',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<LlmEvent> {
        calls++;
        throw new ProviderError('401 invalid key', 'llm', 'llm-broken', { retryable: false });
      },
    };
    const b = new FakeLlmProvider(['ok'], { firstTokenMs: 1, provider: 'llm-b' });
    const chain = new ModelChain([entry(broken), entry(b)], base(new UsageMeter(), 'model'), { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });
    await collect(chain.stream(request, new AbortController().signal));
    expect(calls).toBe(1);
  });

  it('does not switch after output (would mix two answers): the error surfaces', async () => {
    const a = new FakeLlmProvider([{ text: 'one two three four five six', error: 'mid-stream' }], { firstTokenMs: 1, tokenMs: 1, provider: 'llm-a' });
    const b = new FakeLlmProvider(['never'], { firstTokenMs: 1, provider: 'llm-b' });
    const chain = new ModelChain([entry(a), entry(b)], base(new UsageMeter(), 'model'), { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });
    await expect(collect(chain.stream(request, new AbortController().signal))).rejects.toMatchObject({ stage: 'llm' });
    expect(b.requests).toHaveLength(0);
  });

  it('fails with the last error when every model fails', async () => {
    const a = new FakeLlmProvider([{ error: 'before-first-token' }], { firstTokenMs: 1, provider: 'llm-a' });
    const b = new FakeLlmProvider([{ error: 'before-first-token' }], { firstTokenMs: 1, provider: 'llm-b' });
    const chain = new ModelChain([entry(a), entry(b)], base(new UsageMeter(), 'model', 0), { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });
    await expect(collect(chain.stream(request, new AbortController().signal))).rejects.toMatchObject({ provider: 'llm-b' });
  });
});

describe('voice and transcriber fallback', () => {
  it('uses the fallback voice and converts its audio to the primary format', async () => {
    const meter = new UsageMeter();
    const a = new FakeTtsProvider({ provider: 'tts-a', failRequests: 99, firstByteMs: 1 });
    const b = new FakeTtsProvider({ provider: 'tts-b', outputFormat: PCM16_16K, firstByteMs: 1, speed: 100 });
    const chain = new VoiceChain([entry(a), entry(b)], base(meter, 'voice'), { firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 });
    expect(chain.outputFormat).toEqual(PCM16_24K);
    const audio = await collect(chain.stream({ text: 'Hello there.', language: 'en' }, new AbortController().signal));
    const bytes = audio.reduce((n, c) => n + c.length, 0);
    // 12 chars x 50 ms = 600 ms; at 24 kHz PCM16 that is 28800 bytes (B produced it at 16 kHz)
    expect(Math.abs(bytes - 28800)).toBeLessThanOrEqual(8);
    const usage = meter.snapshot();
    expect(usage.find((u) => u.provider === 'tts-a')!.units).toEqual({ requests: 2 });
    expect(usage.find((u) => u.provider === 'tts-b')).toMatchObject({ fallback: true, units: { characters: 12, requests: 1 } });
  });

  it('connects the fallback transcriber when the primary cannot connect, and meters audio there', async () => {
    const meter = new UsageMeter();
    const a = new FakeSttProvider({ provider: 'stt-a', failConnects: 99 });
    const b = new FakeSttProvider({ provider: 'stt-b' });
    const chain = new TranscriberChain([entry(a), entry(b)], base(meter, 'transcriber'), { connectTimeoutMs: 1000 });
    const handlers = { onPartial() {}, onFinal() {}, onError() {} };
    const stream = await chain.connect({ sampleRate: 16000, language: 'bn' }, handlers, new AbortController().signal);
    stream.sendAudio(new Int16Array(16000)); // 1 s
    expect(a.connectCalls).toBe(2);
    expect(chain.current.provider).toBe('stt-b');
    expect(meter.snapshot().find((u) => u.provider === 'stt-b')).toMatchObject({ fallback: true, units: { audioSeconds: 1, requests: 1 } });
  });
});

describe('fallback and usage in a call', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  function call(voices: FakeTtsProvider[], llm: FakeLlmProvider, utterances: string[]) {
    const transport = new LoopbackTransport(PCM16_16K, PCM16_24K, 0, Date.now);
    const stt = new FakeSttProvider({ utterances });
    const config = parseAssistantConfig({ firstMessage: { mode: 'wait-for-user' }, idle: { timeoutMs: 0 }, maxDurationMs: 0, fallback: { prefetchAudio: false } });
    const session = new CallSession({
      config,
      transport,
      orgId: 'org_a',
      providers: { transcriber: [entry(stt)], model: [entry(llm, 'customer')], voice: voices.map((v) => entry(v)) },
      logger: silentLogger,
      now: Date.now,
    });
    const caller = new SimulatedCaller(transport, async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return { session, caller, transport };
  }

  it('keeps the call going on the fallback voice when the primary voice fails mid-call', async () => {
    const a = new FakeTtsProvider({ provider: 'tts-a', failWhenTextIncludes: 'second' });
    const b = new FakeTtsProvider({ provider: 'tts-b' });
    const llm = new FakeLlmProvider(['First answer.', 'The second answer.']);
    const { session, caller, transport } = call([a, b], llm, ['one', 'two']);
    await session.start();
    await caller.speak(400);
    await caller.silenceUntil(() => session.turns.length === 1);
    await caller.speak(400);
    await caller.silenceUntil(() => session.turns.length === 2);
    transport.hangup();
    const summary = await session.ended;

    expect(summary.endReason).toBe(EndReason.CustomerHungUp);
    expect(summary.turns.map((t) => t.heardText)).toEqual(['First answer.', 'The second answer.']);
    const voice = summary.usage.filter((u) => u.component === 'voice');
    expect(voice.find((u) => u.provider === 'tts-a')).toMatchObject({ fallback: false, units: { characters: 'First answer.'.length } });
    expect(voice.find((u) => u.provider === 'tts-b')).toMatchObject({ fallback: true, units: { characters: 'The second answer.'.length } });
  });

  it('records units and billing per component for the whole call', async () => {
    const tts = new FakeTtsProvider();
    const llm = new FakeLlmProvider(['Hello there.']);
    const { session, caller, transport } = call([tts], llm, ['hi']);
    await session.start();
    const startedAt = Date.now();
    await caller.speak(400);
    await caller.silenceUntil(() => session.turns.length === 1);
    transport.hangup();
    const summary = await session.ended;
    const streamedSeconds = (Date.now() - startedAt) / 1000;

    expect(summary.orgId).toBe('org_a');
    const by = (c: string) => summary.usage.find((u) => u.component === c)!;
    expect(by('transcriber')).toMatchObject({ provider: 'fake-stt', billing: 'platform', credentialSource: 'platform', units: { requests: 1 } });
    expect(by('transcriber').units.audioSeconds).toBeCloseTo(streamedSeconds, 1);
    expect(by('model')).toMatchObject({ provider: 'fake-llm', billing: 'customer', credentialSource: 'org', estimated: false, units: { requests: 1, outputTokens: 3 } });
    expect(by('model').units.inputTokens).toBeGreaterThan(0);
    expect(by('voice')).toMatchObject({ provider: 'fake-tts', billing: 'platform', units: { characters: 'Hello there.'.length, requests: 1 } });
    expect(by('voice').units.audioSecondsOut).toBeCloseTo(0.6, 2);
  });

  it('estimates tokens (flagged) when the reply is cut off by a barge-in', async () => {
    const tts = new FakeTtsProvider({ speed: 1.5 });
    const llm = new FakeLlmProvider([{ text: 'Sure. This is a very long answer that keeps going and going for quite some time indeed.', tokenMs: 80 }]);
    const { session, caller, transport } = call([tts], llm, ['hi', 'stop']);
    await session.start();
    await caller.speak(400);
    await caller.silenceUntil(() => session.state === 'speaking');
    await caller.silence(300);
    await caller.speak(300);
    expect(session.turns[0].interrupted).toBe(true);
    transport.hangup();
    const summary = await session.ended;
    expect(summary.usage.find((u) => u.component === 'model')).toMatchObject({ estimated: true });
    expect(summary.usage.find((u) => u.component === 'model')!.units.outputTokens).toBeGreaterThan(0);
  });
});
