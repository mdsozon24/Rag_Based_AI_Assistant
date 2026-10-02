/**
 * Browser call transport (protocol v1, used by the @octo/web SDK), resumable.
 *
 * One BrowserTransport lives for the whole call; the WebSocket under it can be replaced when the
 * client reconnects after a network drop (`attach` again). While no socket is attached, agent audio
 * is dropped, session events are buffered (up to MAX_BUFFERED_EVENTS) and the call keeps running;
 * if no client is back within `resumeGraceMs`, the call ends as a hang-up.
 *
 * Wire format:
 * - Binary, client -> server: caller audio in `inputFormat` (PCM16 16 kHz mono).
 * - Binary, server -> client: agent audio in `outputFormat` (PCM16 24 kHz mono).
 * - Text, client -> server: ClientControl JSON ({"type":"hangup"|"message"|"say"|"ping", ...}).
 * - Text, server -> client: the `ready` message passed to attach(), every SessionEvent,
 *   {"type":"clear"} (stop playback now), {"type":"transfer",...} and {"type":"pong"}.
 *
 * Authentication (the hello/resume handshake) happens before attach(); see apps/api.
 */
import WebSocket from 'ws';
import { z } from 'zod';
import { PCM16_16K, PCM16_24K, type AudioFormat } from '../audio/format.ts';
import type { TransferDestination } from '../engine/config.ts';
import type { SessionEvent } from '../engine/events.ts';
import type { Logger } from '../logger.ts';
import type { Transport, TransportHandlers } from './types.ts';

export const BROWSER_PROTOCOL_VERSION = 1;

const MAX_SEND_BUFFER_BYTES = 4 << 20;
const MAX_BUFFERED_EVENTS = 500;
const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 2000;

const text = z.string().trim().min(1).max(MAX_TEXT_CHARS);
const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hangup') }),
  z.object({ type: z.literal('message'), text }),
  z.object({ type: z.literal('say'), text }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientControl = z.infer<typeof controlSchema>;

/** Parse one client text frame; null when it is not a valid v1 control message. */
export function parseClientControl(raw: string): ClientControl | null {
  if (raw.length > MAX_CONTROL_BYTES) return null;
  try {
    const parsed = controlSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface BrowserTransportOptions {
  logger: Logger;
  /** How long a dropped client may stay away before the call ends (0: end at once). */
  resumeGraceMs: number;
  /** WebSocket ping interval; a client that misses two pongs is treated as dropped (0: off). */
  heartbeatMs?: number;
  /** `message` and `say` from the client (`hangup` and `ping` are handled here). */
  onControl(message: Exclude<ClientControl, { type: 'hangup' | 'ping' }>): void;
  /** The client connected, reconnected (true) or dropped (false). */
  onConnectionChange?(connected: boolean): void;
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  playbackLeadMs?: number;
}

export class BrowserTransport implements Transport {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  readonly playbackLeadMs: number;

  private ws: WebSocket | null = null;
  private detach: (() => void) | null = null;
  private handlers: TransportHandlers | null = null;
  private pendingAudio: Uint8Array[] = [];
  private bufferedEvents: string[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private hungUp = false;

  constructor(private readonly options: BrowserTransportOptions) {
    this.inputFormat = options.inputFormat ?? PCM16_16K;
    this.outputFormat = options.outputFormat ?? PCM16_24K;
    this.playbackLeadMs = options.playbackLeadMs ?? 120;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Use `ws` for this call from now on (first connect or resume). Sends `ready` first, then any
   * events buffered while the client was away. A previously attached socket is closed.
   */
  attach(ws: WebSocket, ready: Record<string, unknown>): void {
    if (this.closed) {
      ws.close(1000, 'call ended');
      return;
    }
    const previous = this.ws;
    this.detach?.();
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(4000, 'replaced by a new connection');
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;

    this.ws = ws;
    let alive = true;
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const chunk = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        // Audio can arrive before the session started; keep it in order
        if (this.handlers) this.handlers.onAudio(chunk);
        else this.pendingAudio.push(chunk);
        return;
      }
      const message = parseClientControl(data.toString());
      if (!message) {
        this.options.logger.warn({}, 'ignoring invalid control message');
        return;
      }
      if (message.type === 'hangup') this.hangup('client hung up');
      else if (message.type === 'ping') this.sendJson({ type: 'pong' });
      else this.options.onControl(message);
    };
    const onClose = (code: number) => this.onSocketGone(ws, code);
    const onError = (err: Error) => this.options.logger.warn({ err }, 'client socket error');
    const onPong = () => (alive = true);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
    ws.on('pong', onPong);
    this.detach = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
      ws.off('pong', onPong);
    };

    if (this.heartbeat) clearInterval(this.heartbeat);
    const heartbeatMs = this.options.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws) return;
        if (!alive) {
          this.options.logger.warn({}, 'client missed heartbeat, dropping connection');
          ws.terminate();
          return;
        }
        alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }

    // The socket may have closed while the caller was authenticating it: its close event is gone
    if (ws.readyState !== WebSocket.OPEN) {
      this.onSocketGone(ws, 1006);
      return;
    }
    this.sendJson(ready);
    const backlog = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const event of backlog) ws.send(event);
    this.options.onConnectionChange?.(true);
  }

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    const early = this.pendingAudio;
    this.pendingAudio = [];
    for (const chunk of early) handlers.onAudio(chunk);
  }

  private onSocketGone(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return;
    this.detach?.();
    this.detach = null;
    this.ws = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.closed || this.hungUp) return;
    this.options.onConnectionChange?.(false);
    const grace = this.options.resumeGraceMs;
    // 1000/1001: the client closed on purpose (page closed, stop() without hangup frame)
    if (grace <= 0 || code === 1000 || code === 1001) {
      this.hangup(`client disconnected (${code})`);
      return;
    }
    this.options.logger.info({ code, grace_ms: grace }, 'client dropped, waiting for it to resume');
    this.graceTimer = setTimeout(() => this.hangup('client did not resume'), grace);
    this.graceTimer.unref?.();
  }

  private hangup(reason: string): void {
    if (this.hungUp || this.closed) return;
    this.hungUp = true;
    this.options.logger.info({ reason }, 'caller left');
    this.handlers?.onHangup();
  }

  sendAudio(chunk: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
      this.options.logger.warn({ buffered_bytes: ws.bufferedAmount }, 'client socket backlog, dropping agent audio');
      return;
    }
    ws.send(chunk, { binary: true });
  }

  clearAudio(): void {
    this.sendJson({ type: 'clear' });
  }

  sendEvent(event: SessionEvent): void {
    this.sendJson(event);
  }

  async transfer(destination: TransferDestination): Promise<void> {
    // A browser call cannot be bridged to a phone number; the client decides what to do
    this.sendJson({ type: 'transfer', destination: { name: destination.name, target: destination.target } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    const ws = this.ws;
    this.detach?.();
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'call ended');
  }

  private sendJson(value: unknown): void {
    const json = JSON.stringify(value);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else if (!this.closed) {
      this.bufferedEvents.push(json);
      if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) this.bufferedEvents.shift();
    }
  }
}
