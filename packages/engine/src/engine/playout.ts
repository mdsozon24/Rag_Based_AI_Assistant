/**
 * Tracks the audio the agent has sent and when the caller hears it.
 *
 * Audio is sent faster than real time and the client plays it from its buffer, so "sent" is not
 * "heard". The tracker keeps a play-head: each chunk starts when the previous one ends (or now
 * plus the client's start-up lead, if the buffer had run dry). On barge-in, heardText() maps the
 * play-head back to the text of each chunk, so history records only what the caller heard.
 */

interface Piece {
  start: number;
  end: number;
}

interface Segment {
  text: string;
  pieces: Piece[];
  audioMs: number;
  complete: boolean;
}

export interface HeardResult {
  /** Text the caller heard, cut at a word boundary. */
  text: string;
  /** True when every segment sent so far was heard in full. */
  complete: boolean;
  heardMs: number;
  sentMs: number;
}

/** Speaking-rate estimate for a segment whose audio is still arriving (characters per second). */
const DEFAULT_CHARS_PER_SECOND = 14;

export class PlayoutTracker {
  private segments: Segment[] = [];
  private playhead = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** Delay before the client starts playing after its buffer ran dry (jitter buffer). */
    private readonly startLeadMs = 0
  ) {}

  /** When the caller will have heard all audio sent so far (ms epoch); 0 if nothing was sent. */
  get playbackEndsAt(): number {
    return this.playhead;
  }

  get hasAudio(): boolean {
    return this.segments.some((s) => s.pieces.length > 0);
  }

  /** Start a new text segment (one TTS request). Returns its id. */
  beginSegment(text: string): number {
    this.segments.push({ text, pieces: [], audioMs: 0, complete: false });
    return this.segments.length - 1;
  }

  /** Record `durationMs` of audio for the segment, sent now. Returns when it starts playing. */
  addAudio(segmentId: number, durationMs: number): number {
    const segment = this.segments[segmentId];
    if (!segment) throw new Error(`Unknown playout segment ${segmentId}`);
    const now = this.now();
    const start = this.playhead > now ? this.playhead : now + this.startLeadMs;
    this.playhead = start + durationMs;
    segment.pieces.push({ start, end: this.playhead });
    segment.audioMs += durationMs;
    return start;
  }

  completeSegment(segmentId: number): void {
    const segment = this.segments[segmentId];
    if (segment) segment.complete = true;
  }

  /** Text heard by the caller up to `at` (default now). */
  heardText(at: number = this.now()): HeardResult {
    const parts: string[] = [];
    let heardMs = 0;
    let sentMs = 0;
    let complete = true;
    const rate = this.observedCharsPerMs();
    for (const segment of this.segments) {
      sentMs += segment.audioMs;
      let segmentHeard = 0;
      for (const piece of segment.pieces) segmentHeard += Math.max(0, Math.min(at, piece.end) - piece.start);
      heardMs += segmentHeard;
      const expectedMs = segment.complete ? segment.audioMs : Math.max(segment.audioMs, segment.text.length / rate);
      if (expectedMs <= 0) {
        if (segment.text.trim()) complete = false;
        continue;
      }
      const fraction = Math.min(1, segmentHeard / expectedMs);
      if (fraction >= 1 && segment.complete) {
        parts.push(segment.text);
        continue;
      }
      complete = false;
      const partial = cutAtWord(segment.text, fraction);
      if (partial) parts.push(partial);
    }
    return { text: parts.join(' ').trim(), complete, heardMs, sentMs };
  }

  reset(): void {
    this.segments = [];
    this.playhead = 0;
  }

  private observedCharsPerMs(): number {
    let chars = 0;
    let ms = 0;
    for (const s of this.segments) {
      if (s.complete && s.audioMs > 0) {
        chars += s.text.length;
        ms += s.audioMs;
      }
    }
    return chars > 0 && ms > 0 ? chars / ms : DEFAULT_CHARS_PER_SECOND / 1000;
  }
}

/** The first `fraction` of `text`, rounded down to a whole word. */
export function cutAtWord(text: string, fraction: number): string {
  if (fraction <= 0) return '';
  if (fraction >= 1) return text;
  const cut = Math.floor(text.length * fraction);
  if (cut <= 0) return '';
  // Keep the word only if the cut falls at its end
  if (/\s/.test(text[cut] ?? ' ')) return text.slice(0, cut).trim();
  const space = text.lastIndexOf(' ', cut);
  return space > 0 ? text.slice(0, space).trim() : '';
}
