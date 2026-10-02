/**
 * Text chunks in, ordered audio out. Each chunk is one TTS request; the next request starts while
 * the previous one is still streaming (up to `maxInFlight`), so there is no gap between sentences.
 * Aborting the signal stops every request and the drain loop immediately.
 */

/** Buffers one TTS stream from the moment it starts, so it can run ahead of playback. */
class TtsPrefetch {
  readonly requestAt: number;
  firstByteAt?: number;
  private chunks: Uint8Array[] = [];
  private done = false;
  private error: unknown = null;
  private wake: (() => void) | undefined;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly now: () => number
  ) {
    this.requestAt = now();
    void this.consume(source);
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async consume(source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of source) {
        if (chunk.length === 0) continue;
        this.firstByteAt ??= this.now();
        this.chunks.push(chunk);
        this.notify();
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.done = true;
      this.notify();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk) {
        yield chunk;
      } else if (this.done) {
        if (this.error) throw this.error;
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }
}

export interface SpeechPipelineOptions {
  /** Synthesize one chunk of text (timeouts, retries and fallbacks are the caller's concern). */
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  now: () => number;
  maxInFlight?: number;
  /** A TTS request is starting for `text`; return an id for its audio. */
  onSegmentStart(text: string): number;
  onAudio(segmentId: number, bytes: Uint8Array): void;
  onSegmentEnd(segmentId: number): void;
}

export class SpeechPipeline {
  private texts: string[] = [];
  private inflight: { segmentId: number; audio: TtsPrefetch }[] = [];
  private finished = false;
  private wake: (() => void) | undefined;
  private firstPrefetch: TtsPrefetch | undefined;
  /** Resolves when every pushed chunk has been emitted; rejects with the TTS error on failure. */
  readonly done: Promise<void>;

  constructor(private readonly options: SpeechPipelineOptions) {
    options.signal.addEventListener('abort', () => this.notify(), { once: true });
    this.done = this.drain();
    // Callers may attach their handler later; avoid an unhandled rejection in the meantime
    this.done.catch(() => {});
  }

  /** TTS request and first-byte times of the first chunk (latency metrics). */
  get firstTiming(): { requestAt?: number; firstByteAt?: number } {
    return { requestAt: this.firstPrefetch?.requestAt, firstByteAt: this.firstPrefetch?.firstByteAt };
  }

  push(text: string): void {
    if (this.finished || !text.trim()) return;
    this.texts.push(text);
    this.fill();
    this.notify();
  }

  /** No more text will be pushed. */
  finish(): void {
    this.finished = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private fill(): void {
    const { signal } = this.options;
    const max = this.options.maxInFlight ?? 2;
    while (this.inflight.length < max && this.texts.length > 0 && !signal.aborted) {
      const text = this.texts.shift() as string;
      const segmentId = this.options.onSegmentStart(text);
      const source = this.options.synthesize(text, signal);
      const audio = new TtsPrefetch(source, this.options.now);
      this.firstPrefetch ??= audio;
      this.inflight.push({ segmentId, audio });
    }
  }

  private async drain(): Promise<void> {
    const { signal } = this.options;
    for (;;) {
      if (signal.aborted) return;
      const head = this.inflight[0];
      if (head) {
        for await (const bytes of head.audio) {
          if (signal.aborted) return;
          this.options.onAudio(head.segmentId, bytes);
        }
        if (signal.aborted) return;
        this.options.onSegmentEnd(head.segmentId);
        this.inflight.shift();
        this.fill();
        continue;
      }
      if (this.finished && this.texts.length === 0) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}
