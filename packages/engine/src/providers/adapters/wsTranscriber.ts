/**
 * Shared WebSocket plumbing for streaming transcribers: connect with timeout-friendly abort,
 * handshake error mapping, audio batching, at most one failure report per stream, and a clean
 * close that is not reported as an error. Each adapter supplies only its protocol.
 */
import WebSocket from 'ws';
import type { LookupFunction } from 'node:net';
import { ProviderError, type ProviderContext, type TranscriberHandlers, type TranscriberStream } from '../types.ts';

export interface TranscriberSocketControl {
  /** The provider accepted the session: connect() resolves. */
  ready(): void;
  partial(text: string): void;
  final(text: string): void;
  fail(error: ProviderError): void;
  send(data: string | Uint8Array): void;
}

export interface TranscriberProtocol {
  url: string;
  headers?: Record<string, string>;
  /** Connect-time DNS check for customer endpoints. */
  lookup?: LookupFunction;
  /** Resolve connect() on socket open, or wait for the protocol to call ready(). */
  readyOn: 'open' | 'message';
  /** Audio per message sent to the provider. */
  batchMs: number;
  onOpen?(control: TranscriberSocketControl): void;
  onMessage(data: WebSocket.RawData, isBinary: boolean, control: TranscriberSocketControl): void;
  encodeAudio(samples: Int16Array, commit: boolean): string | Uint8Array;
  /** Called after any buffered audio was flushed with commit=false semantics handled by encodeAudio. */
  onCommit?(control: TranscriberSocketControl): void;
  /** Whether commit() sends the buffered audio with the commit flag (Scribe) or separately. */
  commitInAudioMessage: boolean;
  /** Sent before a clean close (e.g. Deepgram CloseStream). */
  closeMessage?: string;
  /** Map an HTTP handshake status to retryability. */
  isFatalStatus?(status: number): boolean;
}

const MAX_BUFFERED_BYTES = 1 << 20;

class SocketTranscriberStream implements TranscriberStream {
  closed = false;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private readonly batchSamples: number;

  constructor(
    private readonly socket: WebSocket,
    private readonly protocol: TranscriberProtocol,
    private readonly control: TranscriberSocketControl,
    sampleRate: number,
    private readonly context: ProviderContext,
    private readonly providerName: string
  ) {
    this.batchSamples = Math.max(1, Math.round((sampleRate * protocol.batchMs) / 1000));
  }

  sendAudio(samples: Int16Array): void {
    if (this.closed) return;
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    if (this.pendingSamples >= this.batchSamples) this.flush(false);
  }

  commit(): void {
    if (this.closed) return;
    if (this.protocol.commitInAudioMessage) {
      this.flush(true);
    } else {
      if (this.pendingSamples > 0) this.flush(false);
      this.protocol.onCommit?.(this.control);
    }
  }

  private flush(commit: boolean): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const joined = new Int16Array(this.pendingSamples);
    let offset = 0;
    for (const chunk of this.pending) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES && !commit) {
      this.context.logger.warn({ provider: this.providerName, buffered_bytes: this.socket.bufferedAmount }, 'stt socket backlog, dropping audio');
      return;
    }
    if (joined.length === 0 && !commit) return;
    this.socket.send(this.protocol.encodeAudio(joined, commit));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN) {
      if (this.protocol.closeMessage) this.socket.send(this.protocol.closeMessage);
      this.socket.close(1000);
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
    }
  }
}

export function connectSocketTranscriber(
  providerName: string,
  protocol: TranscriberProtocol,
  sampleRate: number,
  handlers: TranscriberHandlers,
  context: ProviderContext & { signal: AbortSignal }
): Promise<TranscriberStream> {
  const log = context.logger.child({ provider: providerName });
  return new Promise<TranscriberStream>((resolve, reject) => {
    let ready = false;
    let failed = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(protocol.url, { headers: protocol.headers, ...(protocol.lookup ? { lookup: protocol.lookup } : {}) });
    } catch (error) {
      reject(new ProviderError(`${providerName} STT: ${(error as Error).message}`, 'stt', providerName, { retryable: false, cause: error }));
      return;
    }

    const control: TranscriberSocketControl = {
      ready: () => {
        if (ready || failed) return;
        ready = true;
        context.signal.removeEventListener('abort', onAbort);
        resolve(stream);
      },
      partial: (text) => {
        if (!stream.closed) handlers.onPartial(text);
      },
      final: (text) => {
        if (!stream.closed) handlers.onFinal(text);
      },
      fail: (error) => fail(error),
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      },
    };
    const stream = new SocketTranscriberStream(socket, protocol, control, sampleRate, context, providerName);

    // Report at most one failure per stream (an error is usually followed by a close)
    function fail(error: ProviderError) {
      if (failed) return;
      failed = true;
      stream.closed = true;
      if (!ready) {
        context.signal.removeEventListener('abort', onAbort);
        reject(error);
        socket.terminate();
      } else {
        handlers.onError(error);
      }
    }
    function onAbort() {
      fail(new ProviderError(`${providerName} STT connect aborted`, 'stt', providerName, { code: 'aborted' }));
    }
    socket.on('open', () => {
      protocol.onOpen?.(control);
      if (protocol.readyOn === 'open') control.ready();
    });
    socket.on('message', (data, isBinary) => {
      try {
        protocol.onMessage(data, isBinary, control);
      } catch (error) {
        log.warn({ err: error }, 'unparseable stt message');
      }
    });
    socket.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      const fatal = protocol.isFatalStatus ? protocol.isFatalStatus(status) : status === 400 || status === 401 || status === 402 || status === 403;
      fail(new ProviderError(`${providerName} STT handshake failed (${status})`, 'stt', providerName, { retryable: !fatal, code: String(status) }));
    });
    socket.on('error', (err) => {
      const blocked = (err as NodeJS.ErrnoException).code === 'EENDPOINTBLOCKED';
      fail(new ProviderError(`${providerName} STT socket error: ${err.message}`, 'stt', providerName, { retryable: !blocked, cause: err, code: blocked ? 'endpoint-blocked' : undefined }));
    });
    socket.on('close', (code, reason) => {
      if (!ready) {
        fail(new ProviderError(`${providerName} STT closed before the session started (${code} ${reason.toString()})`, 'stt', providerName, { code: String(code) }));
      } else if (!stream.closed) {
        // A close we did not ask for is a dropped stream
        fail(new ProviderError(`${providerName} STT connection closed (${code} ${reason.toString()})`, 'stt', providerName, { code: String(code) }));
      }
    });

    // Only after the listeners exist: terminating a connecting socket emits 'error', which would
    // otherwise be an uncaught exception
    if (context.signal.aborted) return onAbort();
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}
