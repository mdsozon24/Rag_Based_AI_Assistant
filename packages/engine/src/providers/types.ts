/**
 * Provider interfaces for the cascaded pipeline: Transcriber (STT), LanguageModel (LLM) and
 * VoiceSynthesizer (TTS). All three stream, all three are cancellable through an AbortSignal, and
 * all report failures as ProviderError. Adapters (ElevenLabs, Deepgram, Gemini, OpenAI, Cartesia,
 * custom endpoints) and test fakes implement these; the engine depends only on this file.
 */
import type { AudioFormat } from '../audio/format.ts';
import type { Logger } from '../logger.ts';

export type ProviderStage = 'stt' | 'llm' | 'tts';
/** Assistant config component names (Vapi-style): transcriber, model, voice. */
export type ComponentKind = 'transcriber' | 'model' | 'voice';

export const STAGE_OF: Record<ComponentKind, ProviderStage> = { transcriber: 'stt', model: 'llm', voice: 'tts' };

export interface ProviderContext {
  callId: string;
  logger: Logger;
}

/** The one error type every provider throws or reports. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly stage: ProviderStage,
    readonly provider: string,
    readonly options: { retryable?: boolean; code?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
  }

  /** False for errors that will not go away by retrying (bad key, no credit, invalid request). */
  get retryable(): boolean {
    return this.options.retryable ?? true;
  }

  get code(): string | undefined {
    return this.options.code;
  }
}

/** Identity shared by every provider instance (recorded per call for billing). */
export interface ProviderIdentity {
  /** Registry id, e.g. "deepgram", "openai", "custom". */
  readonly provider: string;
  readonly model: string;
}

// ---------- Transcriber (speech-to-text) ----------

export interface TranscriberStartOptions {
  /** PCM16 mono sample rate of the audio passed to sendAudio. */
  sampleRate: number;
  language: string;
}

export interface TranscriberHandlers {
  /** Interim text for the current segment; later partials replace earlier ones. */
  onPartial(text: string): void;
  /** Settled text for a segment (after commit()). May be empty when nothing was said. */
  onFinal(text: string): void;
  /** The stream failed and is unusable. Reported at most once per stream. */
  onError(error: ProviderError): void;
}

export interface TranscriberStream {
  sendAudio(samples: Int16Array): void;
  /** Finalize the current segment now (the engine's endpointer decided the user finished). */
  commit(): void;
  close(): Promise<void>;
}

export interface Transcriber extends ProviderIdentity {
  /** Resolves once the stream accepts audio. Rejects with ProviderError; aborting the signal cancels. */
  connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, context: ProviderContext & { signal: AbortSignal }): Promise<TranscriberStream>;
}

// ---------- LanguageModel (LLM) ----------

export interface ToolCall {
  /** Provider call id (generated when the provider has none); echoed back in the tool result. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Conversation messages. `tool` messages and `toolCalls` on assistant messages are accepted by
 * every adapter now; the tool runtime that produces them arrives with the tools phase.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | ({ type: 'tool-call' } & ToolCall)
  /** Token counts as reported by the provider, usually last. */
  | ({ type: 'usage' } & TokenUsage);

export interface LanguageModel extends ProviderIdentity {
  /** Streams text deltas, tool calls and usage. Must stop promptly when `signal` aborts. */
  stream(request: LlmRequest, context: ProviderContext & { signal: AbortSignal }): AsyncIterable<LlmEvent>;
}

// ---------- VoiceSynthesizer (text-to-speech) ----------

export interface SynthesisRequest {
  text: string;
  language: string;
}

export interface VoiceSynthesizer extends ProviderIdentity {
  /** Format of the bytes yielded by stream(). PCM16 chunks are always whole samples. */
  readonly outputFormat: AudioFormat;
  /** Streams encoded audio. Must stop promptly when `signal` aborts. */
  stream(request: SynthesisRequest, context: ProviderContext & { signal: AbortSignal }): AsyncIterable<Uint8Array>;
}
