/**
 * ElevenLabs text-to-speech for natural Bangla voice output.
 * Enabled when ELEVENLABS_API_KEY is set; callers fall back to Gemini TTS otherwise.
 */
import fs from 'fs';
import path from 'path';

const API_BASE = 'https://api.elevenlabs.io/v1';

// eleven_v3_conversational supports Bengali like eleven_v3, but starts speaking ~3x sooner and
// generates ~4x faster than real time (eleven_v3 is barely real time, which leaves audible gaps).
const DEFAULT_MODEL_ID = 'eleven_v3_conversational';
// Premade "George" voice; admins pick a Bangla voice in the app, or set ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

const VOICE_SETTINGS_PATH = path.join(process.cwd(), 'data', 'voice_settings.json');

type OutputFormat = 'mp3_44100_128' | 'pcm_24000';

interface StoredVoiceSettings {
  voiceId: string;
  updatedAt: string;
  updatedBy: string;
}

let storedVoiceSettings: StoredVoiceSettings | null | undefined;

function loadStoredVoiceSettings(): StoredVoiceSettings | null {
  if (storedVoiceSettings !== undefined) return storedVoiceSettings;
  try {
    storedVoiceSettings = JSON.parse(fs.readFileSync(VOICE_SETTINGS_PATH, 'utf8'));
  } catch {
    storedVoiceSettings = null;
  }
  return storedVoiceSettings;
}

/** The admin-selected voice, else ELEVENLABS_VOICE_ID, else the premade default. */
export function getActiveVoiceId(): string {
  return loadStoredVoiceSettings()?.voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
}

export function setActiveVoiceId(voiceId: string, updatedBy: string): void {
  const settings: StoredVoiceSettings = { voiceId, updatedAt: new Date().toISOString(), updatedBy };
  fs.mkdirSync(path.dirname(VOICE_SETTINGS_PATH), { recursive: true });
  const temporaryPath = `${VOICE_SETTINGS_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(temporaryPath, VOICE_SETTINGS_PATH);
  storedVoiceSettings = settings;
}

// Read lazily: this module is imported before dotenv.config() runs in server.ts.
function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) ? value : fallback;
}

function getConfig() {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: getActiveVoiceId(),
    modelId: process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID,
    voiceSettings: {
      // eleven_v3 models: 0 = Creative (most expressive), 0.5 = Natural, 1 = Robust (flattest)
      stability: numberEnv('ELEVENLABS_STABILITY', 0.5),
      similarity_boost: numberEnv('ELEVENLABS_SIMILARITY', 0.75),
      use_speaker_boost: true,
      speed: numberEnv('ELEVENLABS_SPEED', 1.0),
      // 0 = neutral delivery; higher values exaggerate the voice's own style
      ...(process.env.ELEVENLABS_STYLE ? { style: numberEnv('ELEVENLABS_STYLE', 0) } : {}),
    },
  };
}

export function isElevenLabsEnabled(): boolean {
  return Boolean(getConfig().apiKey);
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string;
  gender?: string;
  accent?: string;
  description?: string;
  previewUrl?: string;
  /** Native Bangla or Bengali-accented voice, listed first in the admin picker. */
  bangla: boolean;
}

const VOICE_CACHE_MS = 5 * 60 * 1000;
let voiceCache: { voices: ElevenLabsVoice[]; expiresAt: number } | null = null;

/** All voices in the ElevenLabs account (premade, cloned and saved library voices). */
export async function listElevenLabsVoices(forceRefresh = false): Promise<ElevenLabsVoice[]> {
  if (!forceRefresh && voiceCache && voiceCache.expiresAt > Date.now()) return voiceCache.voices;

  const { apiKey } = getConfig();
  const voices: ElevenLabsVoice[] = [];
  let pageToken = '';
  do {
    const url = `https://api.elevenlabs.io/v2/voices?page_size=100${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const response = await fetch(url, { headers: { 'xi-api-key': apiKey } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`ElevenLabs voice list failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const page: any = await response.json();
    for (const voice of page.voices || []) {
      const labels = voice.labels || {};
      const bangla =
        labels.language === 'bn' ||
        /beng|bangla|^bn/i.test(labels.accent || '') ||
        /bangla|bengali/i.test(voice.name || '') ||
        (voice.verified_languages || []).some((entry: any) => entry.language === 'bn');
      voices.push({
        voiceId: voice.voice_id,
        name: voice.name,
        category: voice.category,
        gender: labels.gender,
        accent: labels.accent,
        description: labels.descriptive,
        previewUrl: voice.preview_url || undefined,
        bangla,
      });
    }
    pageToken = page.has_more ? page.next_page_token || '' : '';
  } while (pageToken);

  voices.sort((a, b) => Number(b.bangla) - Number(a.bangla) || a.name.localeCompare(b.name));
  voiceCache = { voices, expiresAt: Date.now() + VOICE_CACHE_MS };
  return voices;
}

interface LibraryVoice {
  voiceId: string;
  publicOwnerId: string;
  name: string;
  gender?: string;
}

async function fetchSharedVoices(params: URLSearchParams): Promise<LibraryVoice[]> {
  const response = await fetch(`${API_BASE}/shared-voices?${params}`, { headers: { 'xi-api-key': getConfig().apiKey } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs voice library search failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const data: any = await response.json();
  return (data.voices || []).map((voice: any) => ({
    voiceId: voice.voice_id,
    publicOwnerId: voice.public_owner_id,
    name: voice.name,
    gender: voice.gender || undefined,
  }));
}

/**
 * Human Bangla voices from the public ElevenLabs Voice Library: voices whose language is
 * Bengali plus Bengali-accented voices (the library files most of those under Hindi).
 */
async function listLibraryBanglaVoices(): Promise<LibraryVoice[]> {
  const results = await Promise.all(
    [['language', 'bn'], ['accent', 'bengali']].map(([key, value]) =>
      fetchSharedVoices(new URLSearchParams({ page_size: '100', [key]: value }))
    )
  );
  const seen = new Set<string>();
  return results.flat().filter((voice) => !seen.has(voice.voiceId) && seen.add(voice.voiceId));
}

/** Add a Voice Library voice to the ElevenLabs account. */
async function addLibraryVoice(voice: LibraryVoice): Promise<void> {
  const response = await fetch(
    `${API_BASE}/voices/add/${encodeURIComponent(voice.publicOwnerId)}/${encodeURIComponent(voice.voiceId)}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': getConfig().apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: voice.name }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs add voice failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  voiceCache = null;
}

export interface VoiceOption {
  voiceId: string;
  name: string;
  gender?: string;
}

let optionsCache: { options: VoiceOption[]; library: LibraryVoice[]; expiresAt: number } | null = null;

/**
 * The voices an admin can choose from: the account's Bangla voices, human Bangla voices from the
 * Voice Library, and the active voice even if it is neither.
 */
export async function listVoiceOptions(forceRefresh = false): Promise<VoiceOption[]> {
  if (!forceRefresh && optionsCache && optionsCache.expiresAt > Date.now()) return optionsCache.options;

  const activeVoiceId = getActiveVoiceId();
  const [accountVoices, library] = await Promise.all([
    listElevenLabsVoices(forceRefresh),
    listLibraryBanglaVoices().catch((error) => {
      console.warn('Voice library unavailable:', error?.message || error);
      return [] as LibraryVoice[];
    }),
  ]);
  const options = new Map<string, VoiceOption>();
  for (const voice of accountVoices) {
    if (voice.bangla || voice.voiceId === activeVoiceId) {
      options.set(voice.voiceId, { voiceId: voice.voiceId, name: voice.name, gender: voice.gender });
    }
  }
  for (const voice of library) {
    if (!options.has(voice.voiceId)) options.set(voice.voiceId, { voiceId: voice.voiceId, name: voice.name, gender: voice.gender });
  }

  const sorted = [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
  optionsCache = { options: sorted, library, expiresAt: Date.now() + VOICE_CACHE_MS };
  return sorted;
}

/**
 * Make a chosen voice the voice for all answers. A Voice Library voice is first added to the
 * ElevenLabs account; if that fails (e.g. no free voice slot) it is still used directly.
 */
export async function selectVoice(voiceId: string, updatedBy: string): Promise<void> {
  const options = await listVoiceOptions();
  if (!options.some((option) => option.voiceId === voiceId)) throw new Error('UNKNOWN_VOICE');

  const inAccount = (await listElevenLabsVoices()).some((voice) => voice.voiceId === voiceId);
  const libraryVoice = optionsCache?.library.find((voice) => voice.voiceId === voiceId);
  if (!inAccount && libraryVoice) {
    await addLibraryVoice(libraryVoice).catch((error) => {
      console.warn('Using the library voice without adding it to the account:', error?.message || error);
    });
  }
  setActiveVoiceId(voiceId, updatedBy);
}

async function requestSpeech(
  text: string,
  outputFormat: OutputFormat,
  signal?: AbortSignal,
  voiceIdOverride?: string
): Promise<Response> {
  const { apiKey, voiceId, modelId, voiceSettings } = getConfig();
  const response = await fetch(
    `${API_BASE}/text-to-speech/${encodeURIComponent(voiceIdOverride || voiceId)}/stream?output_format=${outputFormat}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'application/octet-stream',
      },
      body: JSON.stringify({ text, model_id: modelId, language_code: 'bn', voice_settings: voiceSettings }),
      signal,
    }
  );
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response;
}

/** Synthesize the full text as an MP3 file, with the active voice unless one is given. */
export async function generateElevenLabsSpeech(text: string, voiceId?: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await requestSpeech(text, 'mp3_44100_128', undefined, voiceId);
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg' };
}

/** Stream 24kHz 16-bit mono PCM, yielding chunks aligned to whole samples. */
async function* streamPcm24k(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const response = await requestSpeech(text, 'pcm_24000', signal);
  let carry: Buffer | null = null;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    let data = Buffer.from(chunk);
    if (carry) {
      data = Buffer.concat([carry, data]);
      carry = null;
    }
    if (data.length % 2 === 1) {
      carry = data.subarray(data.length - 1);
      data = data.subarray(0, data.length - 1);
    }
    if (data.length > 0) yield data;
  }
}

/**
 * Starts consuming an audio stream immediately and buffers it, so a passage can be
 * synthesized while the one before it is still being sent to the client.
 */
class PrefetchedAudio {
  private chunks: Buffer[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  constructor(source: AsyncIterable<Buffer>, signal: AbortSignal) {
    this.consume(source, signal);
  }

  private async consume(source: AsyncIterable<Buffer>, signal: AbortSignal): Promise<void> {
    try {
      for await (const chunk of source) {
        this.chunks.push(chunk);
        this.wake?.();
      }
    } catch (err: any) {
      if (!signal.aborted) console.warn('ElevenLabs live TTS error:', err?.message || err);
    } finally {
      this.done = true;
      this.wake?.();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    while (true) {
      const chunk = this.chunks.shift();
      if (chunk) {
        yield chunk;
      } else if (this.done) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
      }
    }
  }
}

const SENTENCE_END = /[।?!.\n]/;
const MAX_BATCH_CHARS = 800;
// eleven_v3 models have no previous_text support, so every request restarts the intonation.
// While the listener still has enough audio queued, wait for this much text so each request
// covers a longer passage.
const MIN_FOLLOWUP_CHARS = 220;
// Passages synthesized ahead of the one being sent (ElevenLabs limits concurrent requests per plan).
const MAX_IN_FLIGHT = 2;
// Speak the sentences that are ready instead of waiting for a longer passage once the client has
// less than this much audio left, so the voice never pauses mid-answer (covers ElevenLabs TTFB).
const LOW_BUFFER_MS = 2000;
// GaplessPcmPlayer starts playback 120ms ahead whenever its queue has run dry.
const PLAYBACK_LEAD_MS = 120;
// 24kHz 16-bit mono PCM
const PCM_BYTES_PER_MS = 48;

/**
 * Turns the Gemini Live text stream into ElevenLabs audio for one client.
 * The first sentence is spoken immediately for low latency; later sentences are grouped into
 * longer passages so the prosody stays natural, but only while the listener has enough audio
 * queued. The next passage is synthesized while the current one plays, so there is no silent
 * gap between them.
 */
export class ElevenLabsLiveRelay {
  private pending = '';
  private flushRequested = false;
  private sending = false;
  private controller = new AbortController();
  private queue: PrefetchedAudio[] = [];
  /** Estimated time (Date.now()) at which the client finishes playing the audio sent so far. */
  private playbackEndsAt = 0;
  private lowBufferTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sendPcmBase64: (audio: string) => void) {}

  /** Append model output text (Gemini output transcription). */
  pushText(text: string): void {
    this.pending += text;
    this.pump();
  }

  /** The model has generated its whole answer: speak whatever text remains. */
  flush(): void {
    if (!this.pending.trim()) {
      // Nothing left, e.g. turnComplete arriving after generationComplete already flushed
      this.pending = '';
      return;
    }
    this.flushRequested = true;
    this.pump();
  }

  /** The user interrupted: drop queued text and stop the in-flight requests. */
  interrupt(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.pending = '';
    this.flushRequested = false;
    this.queue = [];
    this.playbackEndsAt = 0;
    this.clearLowBufferTimer();
  }

  close(): void {
    this.interrupt();
  }

  private bufferedMs(): number {
    return this.playbackEndsAt - Date.now();
  }

  private send(pcm: Buffer): void {
    this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now() + PLAYBACK_LEAD_MS) + pcm.length / PCM_BYTES_PER_MS;
    this.sendPcmBase64(pcm.toString('base64'));
  }

  private clearLowBufferTimer(): void {
    if (this.lowBufferTimer) clearTimeout(this.lowBufferTimer);
    this.lowBufferTimer = null;
  }

  /** Re-check the waiting text when the client's queued audio drops to LOW_BUFFER_MS. */
  private armLowBufferTimer(): void {
    if (this.lowBufferTimer) return;
    this.lowBufferTimer = setTimeout(() => {
      this.lowBufferTimer = null;
      this.pump();
    }, Math.max(0, this.bufferedMs() - LOW_BUFFER_MS));
  }

  private takeBatch(): string {
    let end = -1;
    for (let i = 0; i < this.pending.length && i < MAX_BATCH_CHARS; i++) {
      const ch = this.pending[i];
      // A '.' only ends a sentence when followed by whitespace, so "3.5" is not split
      if (ch === '.' ? /\s/.test(this.pending[i + 1] ?? '') : SENTENCE_END.test(ch)) end = i + 1;
    }
    // End of answer: speak everything that is left in one request
    if (this.flushRequested && this.pending.length <= MAX_BATCH_CHARS) end = this.pending.length;
    if (end === -1 && this.pending.length > MAX_BATCH_CHARS) {
      const space = this.pending.lastIndexOf(' ', MAX_BATCH_CHARS);
      end = space > 0 ? space + 1 : MAX_BATCH_CHARS;
    }
    if (end <= 0) return '';
    // Wait for a longer passage only while audio is still being synthesized or plenty is queued
    const canWait = this.queue.length > 0 || this.bufferedMs() > LOW_BUFFER_MS;
    if (canWait && !this.flushRequested && end < MIN_FOLLOWUP_CHARS && this.pending.length <= MAX_BATCH_CHARS) {
      if (this.queue.length === 0) this.armLowBufferTimer();
      return '';
    }
    this.clearLowBufferTimer();
    const batch = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    if (!this.pending.trim() && this.flushRequested) {
      this.pending = '';
      this.flushRequested = false;
    }
    return batch.trim();
  }

  /** Start synthesizing ready passages, up to MAX_IN_FLIGHT ahead. */
  private schedule(): void {
    while (this.queue.length < MAX_IN_FLIGHT) {
      const batch = this.takeBatch();
      if (!batch) break;
      const signal = this.controller.signal;
      this.queue.push(new PrefetchedAudio(streamPcm24k(batch, signal), signal));
    }
  }

  private async pump(): Promise<void> {
    this.schedule();
    if (this.sending) return;
    this.sending = true;
    try {
      let audio: PrefetchedAudio | undefined;
      while ((audio = this.queue[0])) {
        const signal = this.controller.signal;
        for await (const pcm of audio) {
          if (signal.aborted) break;
          this.send(pcm);
        }
        // interrupt() may have replaced the queue while this passage was being sent
        if (this.queue[0] === audio) this.queue.shift();
        this.schedule();
      }
    } finally {
      this.sending = false;
    }
  }
}
