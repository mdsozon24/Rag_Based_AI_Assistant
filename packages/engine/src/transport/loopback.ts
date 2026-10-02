/**
 * In-process transport for tests and simulations: the test pushes caller audio and inspects
 * everything the engine sent back.
 */
import { durationMs, type AudioFormat } from '../audio/format.ts';
import type { TransferDestination } from '../engine/config.ts';
import type { SessionEvent } from '../engine/events.ts';
import type { Transport, TransportHandlers } from './types.ts';

export interface SentAudio {
  at: number;
  bytes: Uint8Array;
  durationMs: number;
}

export class LoopbackTransport implements Transport {
  readonly sentAudio: SentAudio[] = [];
  readonly clears: number[] = [];
  readonly events: SessionEvent[] = [];
  readonly transfers: TransferDestination[] = [];
  closed = false;
  private handlers: TransportHandlers | null = null;

  constructor(
    readonly inputFormat: AudioFormat,
    readonly outputFormat: AudioFormat,
    readonly playbackLeadMs = 0,
    private readonly now: () => number = Date.now,
    private readonly transferBehaviour: 'accept' | 'fail' = 'accept'
  ) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  /** Caller audio in inputFormat. */
  pushAudio(chunk: Uint8Array): void {
    if (!this.closed) this.handlers?.onAudio(chunk);
  }

  hangup(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers?.onHangup();
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.closed) return;
    this.sentAudio.push({ at: this.now(), bytes: chunk, durationMs: durationMs(this.outputFormat, chunk.length) });
  }

  clearAudio(): void {
    this.clears.push(this.now());
  }

  sendEvent(event: SessionEvent): void {
    this.events.push(event);
  }

  async transfer(destination: TransferDestination): Promise<void> {
    if (this.transferBehaviour === 'fail') throw new Error('transfer rejected');
    this.transfers.push(destination);
  }

  close(): void {
    this.closed = true;
  }

  totalSentMs(): number {
    return this.sentAudio.reduce((sum, a) => sum + a.durationMs, 0);
  }
}
