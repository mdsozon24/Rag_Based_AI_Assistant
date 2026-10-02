/**
 * ElevenLabs Scribe v2 Realtime speech-to-text over WebSocket.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *
 * commit_strategy=manual: the engine's endpointer decides when the user finished and commits, so
 * the silence threshold stays per-assistant config (DECISIONS D25).
 */
import { pcm16ToBytes } from '../../audio/format.ts';
import { ProviderError, type ProviderContext, type Transcriber, type TranscriberHandlers, type TranscriberStartOptions, type TranscriberStream } from '../types.ts';
import { connectSocketTranscriber } from './wsTranscriber.ts';

export interface ElevenLabsTranscriberOptions {
  apiKey: string;
  model?: string;
  keyterms?: string[];
  /** Default wss://api.elevenlabs.io (US/EU/India residency endpoints also exist). */
  baseUrl?: string;
}

const FATAL_ERRORS = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request']);
const NON_FATAL_ERRORS = new Set([
  'error',
  'transcriber_error',
  'input_error',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'chunk_size_exceeded',
  'insufficient_audio_activity',
]);

/** Primary language subtag ("bn-BD" -> "bn"). */
export function baseLanguage(language: string): string {
  return language.split(/[-_]/)[0].toLowerCase();
}

export function buildScribeUrl(baseUrl: string, model: string, options: TranscriberStartOptions, keyterms: string[] = []): string {
  const params = new URLSearchParams({
    model_id: model,
    audio_format: `pcm_${options.sampleRate}`,
    commit_strategy: 'manual',
    language_code: baseLanguage(options.language),
  });
  for (const term of keyterms) params.append('keyterms', term);
  return `${baseUrl.replace(/\/$/, '')}/v1/speech-to-text/realtime?${params}`;
}

export class ElevenLabsTranscriber implements Transcriber {
  readonly provider = 'elevenlabs';
  readonly model: string;

  constructor(private readonly options: ElevenLabsTranscriberOptions) {
    if (!options.apiKey) throw new Error('ElevenLabs transcriber needs an API key');
    this.model = options.model ?? 'scribe_v2_realtime';
  }

  connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, context: ProviderContext & { signal: AbortSignal }): Promise<TranscriberStream> {
    const sampleRate = options.sampleRate;
    return connectSocketTranscriber(
      this.provider,
      {
        url: buildScribeUrl(this.options.baseUrl ?? 'wss://api.elevenlabs.io', this.model, options, this.options.keyterms),
        headers: { 'xi-api-key': this.options.apiKey },
        readyOn: 'message',
        batchMs: 100, // the API recommends 0.1-1 s chunks
        commitInAudioMessage: true,
        encodeAudio: (samples, commit) =>
          JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(pcm16ToBytes(samples)).toString('base64'), commit, sample_rate: sampleRate }),
        onMessage: (data, _isBinary, control) => {
          const message = JSON.parse(data.toString()) as { message_type?: string; text?: string; error?: string; message?: string };
          const type = message.message_type ?? '';
          if (type === 'session_started') control.ready();
          else if (type === 'partial_transcript') control.partial(message.text ?? '');
          else if (type === 'committed_transcript') control.final(message.text ?? '');
          else if (type === 'commit_throttled' || type === 'warning') context.logger.warn({ provider: this.provider, type, detail: message.error ?? message.message }, 'scribe warning');
          else if (FATAL_ERRORS.has(type) || NON_FATAL_ERRORS.has(type)) {
            const detail = message.error ?? message.message ?? type;
            control.fail(new ProviderError(`ElevenLabs STT ${type}: ${detail}`, 'stt', this.provider, { retryable: !FATAL_ERRORS.has(type), code: type }));
          }
        },
      },
      sampleRate,
      handlers,
      context
    );
  }
}
