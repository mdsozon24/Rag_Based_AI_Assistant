/**
 * Custom transcriber: the customer's own WebSocket speech-to-text endpoint.
 *
 * Protocol (v1, documented in packages/engine/README.md):
 * - Connect to `wss://...` with optional `Authorization: Bearer <secret>`.
 * - Client -> server text: {"type":"start","encoding":"pcm_s16le","sampleRate":16000,"language":"bn"}
 * - Client -> server binary: PCM16 little-endian mono audio.
 * - Client -> server text: {"type":"commit"} (the user finished a turn; send the final).
 * - Server -> client text: {"type":"partial","text":"..."} / {"type":"final","text":"..."} /
 *   {"type":"error","message":"...","fatal":false}
 */
import type { LookupFunction } from 'node:net';
import { pcm16ToBytes } from '../../audio/format.ts';
import { checkEndpointUrl, guardedLookup, type EndpointPolicy } from '../net.ts';
import { ProviderError, type ProviderContext, type Transcriber, type TranscriberHandlers, type TranscriberStartOptions, type TranscriberStream } from '../types.ts';
import { connectSocketTranscriber } from './wsTranscriber.ts';

export interface CustomTranscriberOptions {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  model?: string;
  policy: EndpointPolicy;
}

export class CustomTranscriber implements Transcriber {
  readonly provider = 'custom';
  readonly model: string;
  private readonly url: string;

  constructor(private readonly options: CustomTranscriberOptions) {
    this.url = checkEndpointUrl(options.url, ['wss'], options.policy).toString();
    this.model = options.model ?? 'custom';
  }

  connect(options: TranscriberStartOptions, handlers: TranscriberHandlers, context: ProviderContext & { signal: AbortSignal }): Promise<TranscriberStream> {
    return connectSocketTranscriber(
      this.provider,
      {
        url: this.url,
        headers: { ...this.options.headers, ...(this.options.secret ? { Authorization: `Bearer ${this.options.secret}` } : {}) },
        lookup: guardedLookup(this.options.policy) as unknown as LookupFunction,
        readyOn: 'open',
        batchMs: 50,
        commitInAudioMessage: false,
        onOpen: (control) => control.send(JSON.stringify({ type: 'start', encoding: 'pcm_s16le', sampleRate: options.sampleRate, language: options.language })),
        encodeAudio: (samples) => pcm16ToBytes(samples),
        onCommit: (control) => control.send(JSON.stringify({ type: 'commit' })),
        onMessage: (data, isBinary, control) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString()) as { type?: string; text?: string; message?: string; fatal?: boolean };
          if (message.type === 'partial') control.partial(message.text ?? '');
          else if (message.type === 'final') control.final(message.text ?? '');
          else if (message.type === 'error') {
            control.fail(new ProviderError(`Custom STT error: ${message.message ?? 'unknown'}`, 'stt', this.provider, { retryable: !message.fatal, code: 'custom-error' }));
          }
        },
      },
      options.sampleRate,
      handlers,
      context
    );
  }
}
