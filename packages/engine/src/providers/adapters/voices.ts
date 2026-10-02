/**
 * Voice synthesizers over HTTP streaming: ElevenLabs, Cartesia, and custom endpoints.
 * All three request raw PCM16 mono and yield whole samples.
 */
import { PCM16_24K, type AudioFormat } from '../../audio/format.ts';
import { alignPcm16, checkEndpointUrl, fetchHttpClient, guardedHttpClient, type EndpointPolicy, type HttpClient } from '../net.ts';
import { ProviderError, type ProviderContext, type SynthesisRequest, type VoiceSynthesizer } from '../types.ts';
import { baseLanguage } from './elevenlabsTranscriber.ts';

async function* postForAudio(
  provider: string,
  http: HttpClient,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  let response;
  try {
    response = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    const blocked = (error as Error).name === 'EndpointNotAllowedError' || (error as NodeJS.ErrnoException).code === 'EENDPOINTBLOCKED';
    throw new ProviderError(`${provider} TTS request failed: ${(error as Error).message}`, 'tts', provider, { retryable: !blocked, cause: error });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const status = response.status;
    throw new ProviderError(`${provider} TTS failed (${status}): ${detail.slice(0, 300)}`, 'tts', provider, {
      retryable: status >= 500 || status === 429 || status === 408,
      code: String(status),
    });
  }
  yield* alignPcm16(response.body);
}

// ---------------------------------------------------------------- ElevenLabs

export interface ElevenLabsVoiceOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  voiceSettings?: Record<string, unknown>;
  baseUrl?: string;
  http?: HttpClient;
}

export class ElevenLabsVoice implements VoiceSynthesizer {
  readonly provider = 'elevenlabs';
  readonly model: string;
  readonly outputFormat: AudioFormat = PCM16_24K;

  constructor(private readonly options: ElevenLabsVoiceOptions) {
    if (!options.apiKey) throw new Error('ElevenLabs voice needs an API key');
    this.model = options.model ?? 'eleven_v3_conversational';
  }

  stream(request: SynthesisRequest, context: ProviderContext & { signal: AbortSignal }): AsyncIterable<Uint8Array> {
    const base = (this.options.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
    return postForAudio(
      this.provider,
      this.options.http ?? fetchHttpClient,
      `${base}/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}/stream?output_format=pcm_${this.outputFormat.sampleRate}`,
      { 'xi-api-key': this.options.apiKey, Accept: 'application/octet-stream' },
      {
        text: request.text,
        model_id: this.model,
        language_code: baseLanguage(request.language),
        ...(this.options.voiceSettings ? { voice_settings: this.options.voiceSettings } : {}),
      },
      context.signal
    );
  }
}

// ---------------------------------------------------------------- Cartesia

export const CARTESIA_API_VERSION = '2026-08-14';

export interface CartesiaVoiceOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  /** 0.6-1.5; omitted = model default. */
  speed?: number;
  baseUrl?: string;
  http?: HttpClient;
}

/** Cartesia /tts/bytes (Sonic 3.6 supports Bengali). Docs: https://docs.cartesia.ai/api-reference/tts/bytes */
export class CartesiaVoice implements VoiceSynthesizer {
  readonly provider = 'cartesia';
  readonly model: string;
  readonly outputFormat: AudioFormat = PCM16_24K;

  constructor(private readonly options: CartesiaVoiceOptions) {
    if (!options.apiKey) throw new Error('Cartesia voice needs an API key');
    this.model = options.model ?? 'sonic-3.6';
  }

  stream(request: SynthesisRequest, context: ProviderContext & { signal: AbortSignal }): AsyncIterable<Uint8Array> {
    const base = (this.options.baseUrl ?? 'https://api.cartesia.ai').replace(/\/$/, '');
    return postForAudio(
      this.provider,
      this.options.http ?? fetchHttpClient,
      `${base}/tts/bytes`,
      { Authorization: `Bearer ${this.options.apiKey}`, 'Cartesia-Version': CARTESIA_API_VERSION },
      {
        model_id: this.model,
        transcript: request.text,
        voice: { id: this.options.voiceId },
        language: baseLanguage(request.language),
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: this.outputFormat.sampleRate },
        ...(this.options.speed !== undefined ? { generation_config: { speed: this.options.speed } } : {}),
      },
      context.signal
    );
  }
}

// ---------------------------------------------------------------- Custom

export interface CustomVoiceOptions {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  voiceId?: string;
  model?: string;
  sampleRate?: number;
  policy: EndpointPolicy;
  http?: HttpClient;
}

/**
 * Custom voice: the customer's HTTPS endpoint.
 * POST {"text","language","voiceId","sampleRate","encoding":"pcm_s16le"} with optional
 * `Authorization: Bearer <secret>`; respond 200 with streamed raw PCM16 LE mono at sampleRate.
 */
export class CustomVoice implements VoiceSynthesizer {
  readonly provider = 'custom';
  readonly model: string;
  readonly outputFormat: AudioFormat;
  private readonly url: string;

  constructor(private readonly options: CustomVoiceOptions) {
    this.url = checkEndpointUrl(options.url, ['https'], options.policy).toString();
    this.model = options.model ?? 'custom';
    this.outputFormat = { encoding: 'pcm16', sampleRate: options.sampleRate ?? 24000 };
  }

  stream(request: SynthesisRequest, context: ProviderContext & { signal: AbortSignal }): AsyncIterable<Uint8Array> {
    return postForAudio(
      this.provider,
      this.options.http ?? guardedHttpClient(this.options.policy),
      this.url,
      { ...this.options.headers, Accept: 'application/octet-stream', ...(this.options.secret ? { Authorization: `Bearer ${this.options.secret}` } : {}) },
      { text: request.text, language: request.language, voiceId: this.options.voiceId, sampleRate: this.outputFormat.sampleRate, encoding: 'pcm_s16le' },
      context.signal
    );
  }
}
