/**
 * Splits streamed LLM text into chunks that can be sent to TTS as soon as they are complete.
 *
 * - A chunk ends at a sentence end: . ! ? (and full-width forms), the Bangla/Devanagari danda । ॥,
 *   or a newline. A "." only counts when followed by whitespace, so "3.5" and "e.g." mid-word
 *   are not split.
 * - The first chunk of a reply may also end at a clause boundary (, ; : — and the CJK/Arabic
 *   equivalents) once it is long enough, so the agent starts speaking sooner.
 * - Chunks never exceed `maxChars`; overlong text is split at the last space.
 */

export interface SentenceChunkerOptions {
  /** First chunk may end at a clause boundary once it has this many characters. */
  firstClauseMinChars: number;
  /** Later chunks shorter than this are merged with the next sentence (natural prosody). */
  minChars: number;
  maxChars: number;
}

const DEFAULTS: SentenceChunkerOptions = { firstClauseMinChars: 24, minChars: 12, maxChars: 300 };

const SENTENCE_END = new Set(['.', '!', '?', '।', '॥', '。', '！', '？', '؟', '\n']);
const CLAUSE_END = new Set([',', ';', ':', '—', '，', '、', '；', '：', '،']);

export class SentenceChunker {
  private buffer = '';
  private emitted = 0;
  private readonly options: SentenceChunkerOptions;

  constructor(options: Partial<SentenceChunkerOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Add streamed text; returns the chunks completed by it (possibly none). */
  push(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];
    for (;;) {
      const end = this.findBoundary(false);
      if (end <= 0) break;
      this.take(end, chunks);
    }
    return chunks;
  }

  /** End of the reply: return whatever is left. */
  flush(): string[] {
    const chunks: string[] = [];
    for (;;) {
      const end = this.findBoundary(true);
      if (end <= 0) break;
      this.take(end, chunks);
    }
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) {
      chunks.push(rest);
      this.emitted++;
    }
    return chunks;
  }

  reset(): void {
    this.buffer = '';
    this.emitted = 0;
  }

  private take(end: number, out: string[]): void {
    const chunk = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    if (chunk) {
      out.push(chunk);
      this.emitted++;
    }
  }

  /** Index just past the boundary that should end the next chunk, or -1. */
  private findBoundary(final: boolean): number {
    const { maxChars, minChars, firstClauseMinChars } = this.options;
    const text = this.buffer;
    const isFirst = this.emitted === 0;
    const limit = Math.min(text.length, maxChars);
    let clause = -1;
    for (let i = 0; i < limit; i++) {
      const ch = text[i];
      if (SENTENCE_END.has(ch)) {
        if (ch === '.' || ch === '!' || ch === '?') {
          const next = text[i + 1];
          // Wait for the next character to know whether this ends the sentence
          if (next === undefined) {
            if (!final) break;
          } else if (!/\s/.test(next) && !(ch !== '.' && /["'”’)\]]/.test(next))) {
            continue;
          }
        }
        const end = i + 1;
        if (!isFirst && text.slice(0, end).trim().length < minChars && !final) continue;
        return end;
      }
      if (isFirst && clause < 0 && CLAUSE_END.has(ch) && /\s/.test(text[i + 1] ?? '') && i + 1 >= firstClauseMinChars) {
        clause = i + 1;
      }
    }
    if (clause > 0) return clause;
    if (text.length > maxChars) {
      const space = text.lastIndexOf(' ', maxChars);
      return space > 0 ? space + 1 : maxChars;
    }
    return -1;
  }
}
