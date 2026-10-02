/**
 * Provider chains: a component's primary provider plus its ordered fallbacks, wrapped with
 * timeouts, per-provider retries and usage metering.
 *
 * Rules:
 * - A provider is retried (`retries` times) and then abandoned for the next one only if it failed
 *   before producing any output; after output, a failure is reported to the session (switching
 *   would repeat or mix speech).
 * - Switching is sticky for the rest of the call: once B replaced A, later turns start at B.
 * - Units are recorded against the provider that actually ran.
 */
import { AudioConverter, durationMs, formatsEqual, type AudioFormat } from '../audio/format.ts';
import { estimateTokens, type MeteredProvider, type UsageMeter } from '../engine/usage.ts';
import type { Logger } from '../logger.ts';
import type { Billing } from './registry.ts';
import { linkedController, streamWithRetry, toProviderError, withTimeout } from './resilience.ts';
import {
  ProviderError,
  type ComponentKind,
  type LanguageModel,
  type LlmEvent,
  type LlmRequest,
  type ProviderIdentity,
  type SynthesisRequest,
  type Transcriber,
  type TranscriberHandlers,
  type TranscriberStartOptions,
  type TranscriberStream,
  type VoiceSynthesizer,
} from './types.ts';

export interface ChainEntry<T extends ProviderIdentity> {
  instance: T;
  provider: string;
  model: string;
  credentialSource: 'org' | 'platform' | 'none';
  credentialId?: string;
  billing: Billing;
}

export type ProviderChain<T extends ProviderIdentity> = ChainEntry<T>[];

/** Wrap a bare instance (tests, simple setups) as a one-entry chain. */
export function chainOf<T extends ProviderIdentity>(instance: T, billing: Billing = 'platform'): ProviderChain<T> {
  return [{ instance, provider: instance.provider, model: instance.model, credentialSource: billing === 'platform' ? 'platform' : 'org', billing }];
}

export function toChain<T extends ProviderIdentity>(value: T | ProviderChain<T>): ProviderChain<T> {
  return Array.isArray(value) ? value : chainOf(value);
}

export interface FallbackInfo {
  component: ComponentKind;
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  code?: string;
  message: string;
}

interface ChainOptions {
  /** Told when a provider failed and the next one took over (diagnostics; never throws). */
  onFallback?: (info: FallbackInfo) => void;
  component: ComponentKind;
  callId: string;
  logger: Logger;
  meter: UsageMeter;
  retries: number;
}

abstract class ChainBase<T extends ProviderIdentity> {
  protected active = 0;

  constructor(
    protected readonly chain: ProviderChain<T>,
    protected readonly options: ChainOptions
  ) {
    if (chain.length === 0) throw new Error(`${options.component} chain is empty`);
  }

  /** The provider currently in use (after any fallback). */
  get current(): ChainEntry<T> {
    return this.chain[this.active];
  }

  get primary(): ChainEntry<T> {
    return this.chain[0];
  }

  protected metered(index: number): MeteredProvider {
    const entry = this.chain[index];
    return {
      component: this.options.component,
      provider: entry.provider,
      model: entry.model,
      credentialSource: entry.credentialSource,
      ...(entry.credentialId ? { credentialId: entry.credentialId } : {}),
      billing: entry.billing,
      index,
    };
  }

  protected fallingBack(from: number, error: ProviderError): void {
    const next = this.chain[from + 1];
    this.options.logger.warn(
      { component: this.options.component, from: this.chain[from].provider, from_model: this.chain[from].model, to: next.provider, to_model: next.model, err: error, code: error.code },
      'provider failed, switching to fallback'
    );
    this.active = from + 1;
    try {
      this.options.onFallback?.({ component: this.options.component, from: { provider: this.chain[from].provider, model: this.chain[from].model }, to: { provider: next.provider, model: next.model }, ...(error.code ? { code: error.code } : {}), message: error.message });
    } catch {
      // diagnostics must never break a call
    }
  }
}

// ---------------------------------------------------------------- model

export class ModelChain extends ChainBase<LanguageModel> {
  constructor(
    chain: ProviderChain<LanguageModel>,
    options: ChainOptions,
    private readonly timeouts: { firstTokenTimeoutMs: number; idleTimeoutMs: number }
  ) {
    super(chain, options);
  }

  /** Stream with timeouts, retries and fallback. Throws ProviderError; returns quietly on abort. */
  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    for (let i = this.active; i < this.chain.length; i++) {
      const entry = this.chain[i];
      let produced = false;
      let outputChars = 0;
      let reported: { inputTokens: number; outputTokens: number } | null = null;
      let attempts = 0;
      try {
        const events = streamWithRetry((s) => entry.instance.stream(request, { callId: this.options.callId, logger: this.options.logger, signal: s }), {
          stage: 'llm',
          provider: entry.provider,
          logger: this.options.logger,
          signal,
          retries: this.options.retries,
          firstChunkTimeoutMs: this.timeouts.firstTokenTimeoutMs,
          idleTimeoutMs: this.timeouts.idleTimeoutMs,
          onAttempt: () => attempts++,
        });
        for await (const event of events) {
          if (event.type === 'usage') {
            reported = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            continue;
          }
          produced = true;
          if (event.type === 'text') outputChars += event.text.length;
          yield event;
        }
        return;
      } catch (error) {
        const providerError = toProviderError(error, 'llm', entry.provider);
        if (produced || i === this.chain.length - 1 || signal.aborted) throw providerError;
        this.fallingBack(i, providerError);
      } finally {
        if (produced || reported) {
          const estimated = !reported;
          const promptChars = request.systemPrompt.length + request.messages.reduce((n, m) => n + m.content.length, 0);
          this.options.meter.add(
            this.metered(i),
            reported ?? { inputTokens: estimateTokens(promptChars), outputTokens: estimateTokens(outputChars) },
            { estimated }
          );
        }
        this.options.meter.add(this.metered(i), { requests: attempts });
      }
    }
  }
}

// ---------------------------------------------------------------- voice

export class VoiceChain extends ChainBase<VoiceSynthesizer> {
  /** Audio always leaves the chain in the primary's format, whichever provider made it. */
  readonly outputFormat: AudioFormat;

  constructor(
    chain: ProviderChain<VoiceSynthesizer>,
    options: ChainOptions,
    private readonly timeouts: { firstByteTimeoutMs: number; idleTimeoutMs: number }
  ) {
    super(chain, options);
    this.outputFormat = chain[0].instance.outputFormat;
  }

  async *stream(request: SynthesisRequest, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    for (let i = this.active; i < this.chain.length; i++) {
      const entry = this.chain[i];
      const format = entry.instance.outputFormat;
      const converter = formatsEqual(format, this.outputFormat) ? null : new AudioConverter(format, this.outputFormat);
      let produced = false;
      let receivedMs = 0;
      let attempts = 0;
      try {
        const audio = streamWithRetry((s) => entry.instance.stream(request, { callId: this.options.callId, logger: this.options.logger, signal: s }), {
          stage: 'tts',
          provider: entry.provider,
          logger: this.options.logger,
          signal,
          retries: this.options.retries,
          firstChunkTimeoutMs: this.timeouts.firstByteTimeoutMs,
          idleTimeoutMs: this.timeouts.idleTimeoutMs,
          onAttempt: () => attempts++,
        });
        for await (const chunk of audio) {
          produced = true;
          receivedMs += durationMs(format, chunk.length);
          const out = converter ? converter.convert(chunk) : chunk;
          if (out.length > 0) yield out;
        }
        return;
      } catch (error) {
        const providerError = toProviderError(error, 'tts', entry.provider);
        if (produced || i === this.chain.length - 1 || signal.aborted) throw providerError;
        this.fallingBack(i, providerError);
      } finally {
        this.options.meter.add(this.metered(i), {
          requests: attempts,
          ...(produced ? { characters: request.text.length, audioSecondsOut: receivedMs / 1000 } : {}),
        });
      }
    }
  }
}

// ---------------------------------------------------------------- transcriber

export class TranscriberChain extends ChainBase<Transcriber> {
  constructor(
    chain: ProviderChain<Transcriber>,
    options: ChainOptions,
    private readonly timeouts: { connectTimeoutMs: number }
  ) {
    super(chain, options);
  }

  /**
   * Connect the current provider (retrying), else the next ones in order. The returned stream
   * meters streamed audio against the provider that accepted it.
   */
  async connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, signal: AbortSignal): Promise<TranscriberStream> {
    let lastError: ProviderError | null = null;
    for (let i = this.active; i < this.chain.length; i++) {
      const entry = this.chain[i];
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        if (signal.aborted) throw new ProviderError('stt connect aborted', 'stt', entry.provider, { code: 'aborted' });
        const { controller, dispose } = linkedController(signal);
        const startedAt = Date.now();
        try {
          const stream = await withTimeout(
            entry.instance.connect(options, handlers, { callId: this.options.callId, logger: this.options.logger, signal: controller.signal }),
            this.timeouts.connectTimeoutMs,
            `${entry.provider} stt connect`,
            () => controller.abort()
          );
          this.options.meter.add(this.metered(i), { requests: 1 });
          this.options.logger.info({ component: 'transcriber', provider: entry.provider, model: entry.model, attempt, connect_ms: Date.now() - startedAt }, 'stt connected');
          if (i !== this.active) this.active = i;
          return this.meteredStream(stream, i, options.sampleRate);
        } catch (error) {
          lastError = toProviderError(error, 'stt', entry.provider);
          if (signal.aborted) throw lastError;
          this.options.logger.warn(
            { component: 'transcriber', provider: entry.provider, attempt, err: lastError, code: lastError.code, retrying: lastError.retryable && attempt < this.options.retries },
            'stt connect failed'
          );
          if (!lastError.retryable) break;
        } finally {
          dispose();
        }
      }
      if (i < this.chain.length - 1 && lastError) this.fallingBack(i, lastError);
    }
    throw lastError ?? new ProviderError('no transcriber available', 'stt', this.chain[0].provider);
  }

  private meteredStream(stream: TranscriberStream, index: number, sampleRate: number): TranscriberStream {
    const meter = this.options.meter;
    const entry = this.metered(index);
    return {
      sendAudio(samples: Int16Array) {
        meter.add(entry, { audioSeconds: samples.length / sampleRate });
        stream.sendAudio(samples);
      },
      commit: () => stream.commit(),
      close: () => stream.close(),
    };
  }
}
