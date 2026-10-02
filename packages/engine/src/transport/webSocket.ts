/**
 * Browser WebSocket transport (protocol v1).
 *
 * - Binary frames, client -> server: caller audio in `inputFormat` (default PCM16 16 kHz mono).
 * - Binary frames, server -> client: agent audio in `outputFormat` (default PCM16 24 kHz mono).
 * - Text frames: JSON. Client -> server: {"type":"hangup"}.
 *   Server -> client: every SessionEvent, plus {"type":"clear"} (stop playback now) and
 *   {"type":"transfer","destination":...}.
 */
import WebSocket from 'ws';
import { PCM16_16K, PCM16_24K, type AudioFormat } from '../audio/format.ts';
import type { TransferDestination } from '../engine/config.ts';
import type { SessionEvent } from '../engine/events.ts';
import type { Logger } from '../logger.ts';
import type { Transport, TransportHandlers } from './types.ts';

const MAX_SEND_BUFFER_BYTES = 4 << 20;

export class WebSocketTransport implements Transport {
  private handlers: TransportHandlers | null = null;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly logger: Logger,
    readonly inputFormat: AudioFormat = PCM16_16K,
    readonly outputFormat: AudioFormat = PCM16_24K,
    readonly playbackLeadMs = 120
  ) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        this.handlers?.onAudio(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return;
      }
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === 'hangup') this.hangup();
      } catch {
        this.logger.warn({}, 'ignoring malformed control message');
      }
    });
    this.ws.on('close', () => this.hangup());
    this.ws.on('error', (err) => {
      this.logger.warn({ err }, 'client socket error');
      this.hangup();
    });
  }

  private hangup(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers?.onHangup();
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
      this.logger.warn({ buffered_bytes: this.ws.bufferedAmount }, 'client socket backlog, dropping agent audio');
      return;
    }
    this.ws.send(chunk, { binary: true });
  }

  clearAudio(): void {
    this.sendJson({ type: 'clear' });
  }

  sendEvent(event: SessionEvent): void {
    this.sendJson(event);
  }

  async transfer(destination: TransferDestination): Promise<void> {
    // A browser call cannot be bridged to a phone number; tell the client (telephony in Phase 8)
    this.sendJson({ type: 'transfer', destination: { name: destination.name, target: destination.target } });
  }

  close(): void {
    this.closed = true;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'call ended');
  }

  private sendJson(value: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }
}
