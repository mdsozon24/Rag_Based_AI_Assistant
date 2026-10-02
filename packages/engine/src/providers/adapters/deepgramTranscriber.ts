/**
 * Deepgram streaming speech-to-text (Nova-3; Bengali "bn" supported).
 * Docs: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 *
 * Raw linear16 audio as binary frames, interim results on, Deepgram's own endpointing off (the
 * engine endpoints). commit() sends {"type":"Finalize"}; the segment's text is every is_final
 * result since the last commit, delivered when Deepgram answers with from_finalize, or after
 * FINALIZE_GRACE_MS (Deepgram does not always answer when little audio was buffered).
 */
import { pcm16ToBytes } from '../../audio/format.ts';
import { ProviderError, type ProviderContext, type Transcriber, type TranscriberHandlers, type TranscriberStartOptions, type TranscriberStream } from '../types.ts';
import { connectSocketTranscriber } from './wsTranscriber.ts';

export interface DeepgramTranscriberOptions {
  apiKey: string;
  model?: string;
  keyterms?: string[];
  smartFormat?: boolean;
  baseUrl?: string;
  /** Wait this long for from_finalize before delivering the final anyway. */
  finalizeGraceMs?: number;
}

interface DeepgramResults {
  type?: string;
  is_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
  err_code?: string;
  err_msg?: string;
  description?: string;
}

export function buildDeepgramUrl(baseUrl: string, model: string, options: TranscriberStartOptions, extra: { keyterms?: string[]; smartFormat?: boolean }): string {
  const params = new URLSearchParams({
    model,
    language: options.language,
    encoding: 'linear16',
    sample_rate: String(options.sampleRate),
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    endpointing: 'false',
  });
  if (extra.smartFormat) params.set('smart_format', 'true');
  for (const term of extra.keyterms ?? []) params.append('keyterm', term);
  return `${baseUrl.replace(/\/$/, '')}/v1/listen?${params}`;
}

export class DeepgramTranscriber implements Transcriber {
  readonly provider = 'deepgram';
  readonly model: string;

  constructor(private readonly options: DeepgramTranscriberOptions) {
    if (!options.apiKey) throw new Error('Deepgram transcriber needs an API key');
    this.model = options.model ?? 'nova-3';
  }

  connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, context: ProviderContext & { signal: AbortSignal }): Promise<TranscriberStream> {
    let finals: string[] = [];
    let interim = '';
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
    const grace = this.options.finalizeGraceMs ?? 1000;
    const deliver = (control: { final(text: string): void }) => {
      if (finalizeTimer) clearTimeout(finalizeTimer);
      finalizeTimer = null;
      const text = finals.join(' ').trim();
      finals = [];
      interim = '';
      control.final(text);
    };
    return connectSocketTranscriber(
      this.provider,
      {
        url: buildDeepgramUrl(this.options.baseUrl ?? 'wss://api.deepgram.com', this.model, options, this.options),
        headers: { Authorization: `Token ${this.options.apiKey}` },
        readyOn: 'open',
        batchMs: 50,
        commitInAudioMessage: false,
        closeMessage: JSON.stringify({ type: 'CloseStream' }),
        encodeAudio: (samples) => pcm16ToBytes(samples),
        onCommit: (control) => {
          control.send(JSON.stringify({ type: 'Finalize' }));
          if (finalizeTimer) clearTimeout(finalizeTimer);
          finalizeTimer = setTimeout(() => deliver(control), grace);
        },
        onMessage: (data, isBinary, control) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString()) as DeepgramResults;
          if (message.type === 'Results') {
            const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
            if (message.is_final) {
              if (text) finals.push(text);
              interim = '';
            } else {
              interim = text;
            }
            const live = [...finals, interim].filter(Boolean).join(' ');
            if (live) control.partial(live);
            if (message.from_finalize && finalizeTimer) deliver(control);
          } else if (message.type === 'Error' || message.err_code) {
            control.fail(new ProviderError(`Deepgram STT error: ${message.err_msg ?? message.description ?? 'unknown'}`, 'stt', this.provider, { code: message.err_code }));
          }
        },
      },
      options.sampleRate,
      handlers,
      context
    );
  }
}
