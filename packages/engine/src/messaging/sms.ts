/**
 * SMS rules that do not depend on the provider: keyword handling (STOP / START / HELP) and splitting
 * long replies into messages that fit the carrier segment limits.
 *
 * Segments: GSM-7 text fits 160 characters in one segment, 153 per segment when concatenated
 * (characters from the extension table count twice). Anything else (Bangla, emoji) is UCS-2:
 * 70 in one segment, 67 per concatenated segment, counted in UTF-16 code units.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '^{}\\[~]|€\f';
const BASIC = new Set(GSM7_BASIC);
const EXTENSION = new Set(GSM7_EXTENSION);

export type SmsEncoding = 'gsm7' | 'ucs2';

export function smsEncoding(text: string): SmsEncoding {
  for (const char of text) if (!BASIC.has(char) && !EXTENSION.has(char)) return 'ucs2';
  return 'gsm7';
}

/** Length in segment units: GSM-7 septets (extension chars count 2) or UTF-16 code units. */
export function smsLength(text: string, encoding: SmsEncoding = smsEncoding(text)): number {
  if (encoding === 'ucs2') return text.length;
  let length = 0;
  for (const char of text) length += EXTENSION.has(char) ? 2 : 1;
  return length;
}

export function segmentCount(text: string): number {
  const encoding = smsEncoding(text);
  const length = smsLength(text, encoding);
  const [single, multi] = encoding === 'gsm7' ? [160, 153] : [70, 67];
  return length <= single ? 1 : Math.ceil(length / multi);
}

export interface SplitOptions {
  /** Segments one outgoing message may use (carriers concatenate them). Default 3. */
  maxSegmentsPerMessage?: number;
  /** Messages per reply; the rest is cut with "…". Default 5. */
  maxMessages?: number;
}

/**
 * Split a reply into SMS messages at sentence, then word boundaries. Each message fits
 * `maxSegmentsPerMessage` segments for the reply's encoding.
 */
export function splitSms(text: string, options: SplitOptions = {}): string[] {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const encoding = smsEncoding(clean);
  const segments = Math.max(1, options.maxSegmentsPerMessage ?? 3);
  const maxMessages = Math.max(1, options.maxMessages ?? 5);
  const limit = segments === 1 ? (encoding === 'gsm7' ? 160 : 70) : (encoding === 'gsm7' ? 153 : 67) * segments;
  const fits = (value: string) => smsLength(value, encoding) <= limit;

  // Sentences (Latin and Bangla "।" full stops), then words, then characters as a last resort
  const sentences = clean.match(/[^.!?।\n]+[.!?।]*\s*|\n+/g) ?? [clean];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (fits(sentence)) {
      pieces.push(sentence);
      continue;
    }
    for (const word of sentence.split(/(?<=\s)/)) {
      if (fits(word)) {
        pieces.push(word);
        continue;
      }
      let chunk = '';
      for (const char of word) {
        if (!fits(chunk + char)) {
          pieces.push(chunk);
          chunk = '';
        }
        chunk += char;
      }
      if (chunk) pieces.push(chunk);
    }
  }

  const messages: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && !fits(current + piece)) {
      messages.push(current.trim());
      current = '';
    }
    current += piece;
  }
  if (current.trim()) messages.push(current.trim());

  const result = messages.filter(Boolean);
  if (result.length <= maxMessages) return result;
  const kept = result.slice(0, maxMessages);
  let last = kept[maxMessages - 1];
  while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join('');
  kept[maxMessages - 1] = `${last.trimEnd()}…`;
  return kept;
}

export type SmsKeyword = 'opt-out' | 'opt-in' | 'help';

/** Carrier-standard keywords (CTIA); the whole message must be the keyword. */
const KEYWORDS: Record<string, SmsKeyword> = {
  STOP: 'opt-out',
  STOPALL: 'opt-out',
  UNSUBSCRIBE: 'opt-out',
  CANCEL: 'opt-out',
  END: 'opt-out',
  QUIT: 'opt-out',
  OPTOUT: 'opt-out',
  REVOKE: 'opt-out',
  START: 'opt-in',
  UNSTOP: 'opt-in',
  OPTIN: 'opt-in',
  HELP: 'help',
  INFO: 'help',
};

/** The keyword a message is, if it is one: "stop", " STOP. " and "Stop!" all count. */
export function smsKeyword(text: string, extra: Record<string, SmsKeyword> = {}): SmsKeyword | null {
  const normalized = text.trim().replace(/[\s\p{P}]+/gu, '').toUpperCase();
  if (!normalized || normalized.length > 20) return null;
  return extra[normalized] ?? KEYWORDS[normalized] ?? null;
}
