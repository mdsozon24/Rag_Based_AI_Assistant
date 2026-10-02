/**
 * Deterministic fake providers. They behave like real streaming providers (latency, chunking,
 * abort handling, failures) but run offline, so tests can script whole conversations.
 * All delays use setTimeout, so they follow fake timers in tests.
 */
import { PCM16_24K, pcm16ToBytes, type AudioFormat } from '../audio/format.ts';
import {
  ProviderError,
  type LanguageModel,
  type LlmEvent,
  type LlmRequest,
  type ProviderContext,
  type SynthesisRequest,
  type Transcriber,
  type TranscriberHandlers,
  type TranscriberStartOptions,
  type TranscriberStream,
  type VoiceSynthesizer,
} from '../providers/types.ts';

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------- STT

export interface FakeSttOptions {
  /** Text recognized for each successive utterance (one per commit that followed speech). */
  utterances?: string[];
  /** Commit -> final transcript delay. */
  finalLatencyMs?: number;
  connectLatencyMs?: number;
  /** Peak amplitude above which a chunk counts as speech. */
  speechThreshold?: number;
  /** Fail this many connect() calls before succeeding. */
  failConnects?: number;
  /** Never send a final transcript (tests the final-timeout path). */
  dropFinals?: boolean;
  /** Registry id reported for billing (default "fake-stt"). */
  provider?: string;
}

export class FakeSttStream implements TranscriberStream {
  speechMs = 0;
  closed = false;
  readonly commits: number[] = [];
  private lastPartialAt = 0;

  constructor(
    private readonly provider: FakeSttProvider,
    private readonly handlers: TranscriberHandlers,
    private readonly sampleRate: number
  ) {}

  sendAudio(samples: Int16Array): void {
    if (this.closed) return;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < this.provider.speechThreshold) return;
    this.speechMs += (samples.length / this.sampleRate) * 1000;
    const next = this.provider.peekUtterance();
    if (next && this.speechMs - this.lastPartialAt >= 200) {
      this.lastPartialAt = this.speechMs;
      const words = next.split(' ');
      this.handlers.onPartial(words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(' '));
    }
  }

  commit(): void {
    if (this.closed) return;
    this.commits.push(Date.now());
    const hadSpeech = this.speechMs > 0;
    this.speechMs = 0;
    this.lastPartialAt = 0;
    if (this.provider.options.dropFinals) return;
    const text = hadSpeech ? this.provider.takeUtterance() : '';
    setTimeout(() => {
      if (!this.closed) this.handlers.onFinal(text);
    }, this.provider.options.finalLatencyMs ?? 150);
  }

  /** Simulate the provider connection dropping. */
  fail(message = 'fake stt connection lost', retryable = true): void {
    this.handlers.onError(new ProviderError(message, 'stt', this.provider.provider, { retryable }));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeSttProvider implements Transcriber {
  readonly provider: string;
  readonly model = 'fake-stt-1';
  readonly streams: FakeSttStream[] = [];
  connectCalls = 0;
  private utterances: string[];
  private failConnects: number;

  constructor(readonly options: FakeSttOptions = {}) {
    this.provider = options.provider ?? 'fake-stt';
    this.utterances = [...(options.utterances ?? [])];
    this.failConnects = options.failConnects ?? 0;
  }

  get speechThreshold(): number {
    return this.options.speechThreshold ?? 1000;
  }

  get current(): FakeSttStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  peekUtterance(): string | undefined {
    return this.utterances[0];
  }

  takeUtterance(): string {
    return this.utterances.shift() ?? '';
  }

  readonly languages: string[] = [];

  async connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, context: ProviderContext & { signal: AbortSignal }): Promise<TranscriberStream> {
    this.languages.push(options.language);
    this.connectCalls++;
    if (context.signal.aborted) throw abortError();
    // No timer when there is no latency, so start() resolves without advancing fake timers
    if (this.options.connectLatencyMs) await delay(this.options.connectLatencyMs, context.signal);
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new ProviderError('fake stt connect failed', 'stt', this.provider);
    }
    const stream = new FakeSttStream(this, handlers, options.sampleRate);
    this.streams.push(stream);
    return stream;
  }
}

// ---------------------------------------------------------------- LLM

export interface FakeLlmReply {
  text?: string;
  toolCall?: { name: string; args?: Record<string, unknown> };
  firstTokenMs?: number;
  tokenMs?: number;
  /** Fail this reply: before any token, or after half the tokens. */
  error?: 'before-first-token' | 'mid-stream';
  /** Fail only the first N attempts of this reply (then succeed). Default: every attempt. */
  errorAttempts?: number;
  /** Token usage reported at the end; default: ~4 characters per token. false = report none. */
  usage?: { inputTokens: number; outputTokens: number } | false;
}

export type FakeLlmScript = (string | FakeLlmReply)[] | ((request: LlmRequest, index: number) => string | FakeLlmReply);

export class FakeLlmProvider implements LanguageModel {
  readonly provider: string;
  readonly model: string;
  readonly requests: LlmRequest[] = [];
  aborts = 0;
  private replyIndex = 0;
  private attemptsForReply = 0;

  constructor(
    private readonly script: FakeLlmScript,
    private readonly defaults: { firstTokenMs?: number; tokenMs?: number; provider?: string; model?: string } = {}
  ) {
    this.provider = defaults.provider ?? 'fake-llm';
    this.model = defaults.model ?? 'fake-llm-1';
  }

  private replyFor(request: LlmRequest): FakeLlmReply {
    const raw = typeof this.script === 'function' ? this.script(request, this.replyIndex) : (this.script[this.replyIndex] ?? 'Okay.');
    return typeof raw === 'string' ? { text: raw } : raw;
  }

  async *stream(request: LlmRequest, context: ProviderContext & { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    this.requests.push(structuredClone(request));
    const reply = this.replyFor(request);
    const attempt = this.attemptsForReply++;
    const shouldFail = reply.error && (reply.errorAttempts === undefined || attempt < reply.errorAttempts);
    // A reply is used up once it starts producing output. Requests cancelled or failed before
    // that (barge-in while thinking, timeout, retry) get the same reply next time.
    let consumed = false;
    const consume = () => {
      if (consumed) return;
      consumed = true;
      this.replyIndex++;
      this.attemptsForReply = 0;
    };
    try {
      await delay(reply.firstTokenMs ?? this.defaults.firstTokenMs ?? 200, context.signal);
      if (shouldFail && reply.error === 'before-first-token') throw new ProviderError('fake llm failure', 'llm', this.provider);
      const tokens = (reply.text ?? '').match(/\S+\s*/g) ?? [];
      for (let i = 0; i < tokens.length; i++) {
        if (shouldFail && reply.error === 'mid-stream' && i >= Math.ceil(tokens.length / 2)) {
          throw new ProviderError('fake llm failure mid-stream', 'llm', this.provider);
        }
        if (i > 0) await delay(reply.tokenMs ?? this.defaults.tokenMs ?? 20, context.signal);
        consume();
        yield { type: 'text', text: tokens[i] };
      }
      consume();
      if (reply.toolCall) yield { type: 'tool-call', id: `call-${this.replyIndex}`, name: reply.toolCall.name, args: reply.toolCall.args ?? {} };
      if (reply.usage !== false) {
        const promptChars = request.systemPrompt.length + request.messages.reduce((n, m) => n + m.content.length, 0);
        yield { type: 'usage', ...(reply.usage ?? { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil((reply.text ?? '').length / 4) }) };
      }
    } catch (error) {
      if (context.signal.aborted) this.aborts++;
      throw error;
    }
  }
}

// ---------------------------------------------------------------- TTS

export interface FakeTtsOptions {
  outputFormat?: AudioFormat;
  firstByteMs?: number;
  /** Audio duration per character of text. */
  msPerChar?: number;
  /** Audio per chunk. */
  chunkMs?: number;
  /** Generation speed relative to real time (4 = four times faster than playback). */
  speed?: number;
  /** Fail the next N requests before their first byte. */
  failRequests?: number;
  /** Fail every request whose text includes this string. */
  failWhenTextIncludes?: string;
  /** Registry id reported for billing (default "fake-tts"). */
  provider?: string;
}

export class FakeTtsProvider implements VoiceSynthesizer {
  readonly provider: string;
  readonly model = 'fake-tts-1';
  readonly outputFormat: AudioFormat;
  readonly requests: SynthesisRequest[] = [];
  aborts = 0;
  private failRequests: number;

  constructor(private readonly options: FakeTtsOptions = {}) {
    this.provider = options.provider ?? 'fake-tts';
    this.outputFormat = options.outputFormat ?? PCM16_24K;
    this.failRequests = options.failRequests ?? 0;
  }

  /** Make the next `count` requests fail before their first byte. */
  failNext(count: number): void {
    this.failRequests = count;
  }

  /** Audio duration the fake produces for `text`. */
  durationFor(text: string): number {
    return text.length * (this.options.msPerChar ?? 50);
  }

  async *stream(request: SynthesisRequest, context: ProviderContext & { signal: AbortSignal }): AsyncGenerator<Uint8Array> {
    this.requests.push({ ...request });
    try {
      await delay(this.options.firstByteMs ?? 120, context.signal);
      if (this.failRequests > 0 || (this.options.failWhenTextIncludes && request.text.includes(this.options.failWhenTextIncludes))) {
        if (this.failRequests > 0) this.failRequests--;
        throw new ProviderError('fake tts failure', 'tts', this.provider);
      }
      const chunkMs = this.options.chunkMs ?? 100;
      const speed = this.options.speed ?? 4;
      let remaining = this.durationFor(request.text);
      let phase = 0;
      while (remaining > 0) {
        const ms = Math.min(chunkMs, remaining);
        const samples = new Int16Array(Math.round((this.outputFormat.sampleRate * ms) / 1000));
        for (let i = 0; i < samples.length; i++, phase++) samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * phase) / this.outputFormat.sampleRate));
        yield pcm16ToBytes(samples);
        remaining -= ms;
        if (remaining > 0) await delay(ms / speed, context.signal);
      }
    } catch (error) {
      if (context.signal.aborted) this.aborts++;
      throw error;
    }
  }
}
