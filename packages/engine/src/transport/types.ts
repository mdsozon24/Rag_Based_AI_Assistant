/**
 * A transport carries one call's audio and control messages between the caller and the engine:
 * browser WebSocket, telephony media streams (Phase 8), or an in-process loopback for tests.
 */
import type { AudioFormat } from '../audio/format.ts';
import type { TransferDestination } from '../engine/config.ts';
import type { SessionEvent } from '../engine/events.ts';

export interface TransportHandlers {
  /** Caller audio in `inputFormat`. */
  onAudio(chunk: Uint8Array): void;
  /** The caller hung up or the connection dropped. */
  onHangup(): void;
}

export interface Transport {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  /** How long the far end buffers before it starts playing after running dry (ms). */
  readonly playbackLeadMs: number;
  start(handlers: TransportHandlers): void;
  /** Agent audio in `outputFormat`. May be sent faster than real time; the far end buffers it. */
  sendAudio(chunk: Uint8Array): void;
  /** Stop playback now and drop everything buffered at the far end (barge-in). */
  clearAudio(): void;
  sendEvent(event: SessionEvent): void;
  /** Hand the caller to another destination. Resolves once the transfer is accepted. */
  transfer(destination: TransferDestination): Promise<void>;
  close(): void;
}
