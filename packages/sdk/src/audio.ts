/**
 * Browser microphone and speaker for VoiceClient.
 *
 * Capture: getUserMedia with the browser's echo cancellation, noise suppression and auto gain
 * (so the agent does not hear itself on speakers), then an AudioWorklet that resamples to 16 kHz
 * PCM16 and posts 20 ms frames. Muting sends silence, so the server's turn detection keeps moving.
 *
 * Playback: a 24 kHz AudioContext; each chunk is scheduled right after the previous one (gapless),
 * with a small lead when the queue ran dry. clear() stops everything at once (barge-in).
 *
 * Both AudioContexts are created before the first await, so iOS Safari treats them as started by
 * the user's tap. The worklet is loaded from a blob: URL; a page whose CSP forbids blob: workers
 * needs `worker-src blob:` (see the SDK README).
 */
import { micError, OctoVoiceError } from './errors.ts';
import type { AudioIO, Role } from './types.ts';

/** Matches the server's playbackLeadMs (120 ms), so its heard-text tracking stays accurate. */
const PLAYBACK_LEAD_S = 0.12;
const LEVEL_INTERVAL_MS = 50;
const MAX_DRAIN_MS = 10_000;

function captureWorklet(targetRate: number): string {
  return `
class OctoCapture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${targetRate}; this.pos = 0; this.prev = 0; this.out = []; this.peak = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1], b = ch[i];
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.peak = Math.max(this.peak, Math.abs(v));
      this.out.push(v * 32767);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    const frame = ${Math.round(targetRate / 50)};
    while (this.out.length >= frame) {
      const pcm = Int16Array.from(this.out.splice(0, frame));
      this.port.postMessage({ pcm: pcm.buffer, peak: this.peak }, [pcm.buffer]);
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('octo-capture', OctoCapture);`;
}

type AudioContextClass = typeof AudioContext;

function audioContextClass(): AudioContextClass | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext ?? null;
}

export class BrowserAudio implements AudioIO {
  private stream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private outContext: AudioContext | null = null;
  private capture: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  private outputRate = 24000;
  private playhead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private playing = false;
  private muted = false;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private readonly levelListeners: ((level: number, source: Role) => void)[] = [];
  private readonly playbackListeners: ((playing: boolean) => void)[] = [];

  async open(formats: { inputSampleRate: number; outputSampleRate: number }): Promise<void> {
    const Context = audioContextClass();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || !Context) {
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      throw new OctoVoiceError('mic-unsupported', insecure ? 'The microphone only works on secure (https://) pages.' : 'This browser cannot capture audio.');
    }
    this.outputRate = formats.outputSampleRate;
    // Created synchronously inside the user's click (iOS), resumed below
    this.micContext = new Context();
    this.outContext = new Context({ sampleRate: formats.outputSampleRate });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      await this.close();
      throw micError(error);
    }
    try {
      await Promise.all([this.micContext.resume(), this.outContext.resume()]);
      const url = URL.createObjectURL(new Blob([captureWorklet(formats.inputSampleRate)], { type: 'application/javascript' }));
      try {
        await this.micContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.capture = new AudioWorkletNode(this.micContext, 'octo-capture');
      this.micSource = this.micContext.createMediaStreamSource(this.stream);
      this.micSource.connect(this.capture);
      // Connected so every browser keeps pulling the worklet; it outputs silence
      this.capture.connect(this.micContext.destination);

      this.output = this.outContext.createGain();
      this.analyser = this.outContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.output.connect(this.analyser);
      this.analyser.connect(this.outContext.destination);
    } catch (error) {
      await this.close();
      throw new OctoVoiceError('mic-unsupported', 'Audio could not be started in this browser.', { cause: error });
    }
    const samples = new Float32Array(this.analyser.fftSize);
    this.levelTimer = setInterval(() => {
      if (!this.playing || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this.emitLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4), 'assistant');
    }, LEVEL_INTERVAL_MS);
  }

  startCapture(onFrame: (pcm16: ArrayBuffer) => void): void {
    if (!this.capture) return;
    this.capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      const { pcm, peak } = event.data;
      this.emitLevel(this.muted ? 0 : Math.min(1, peak * 1.4), 'user');
      onFrame(this.muted ? new ArrayBuffer(pcm.byteLength) : pcm);
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Also silences the track at the source, for browsers that show a "mic live" indicator per track
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  play(pcm16: ArrayBuffer): void {
    const context = this.outContext;
    if (!context || !this.output || pcm16.byteLength < 2) return;
    const pcm = new Int16Array(pcm16, 0, Math.floor(pcm16.byteLength / 2));
    const buffer = context.createBuffer(1, pcm.length, this.outputRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    const now = context.currentTime;
    if (this.playhead < now) this.playhead = now + PLAYBACK_LEAD_S;
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.setPlaying(false);
    };
    this.setPlaying(true);
  }

  clear(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // not started yet
      }
    }
    this.sources.clear();
    this.playhead = 0;
    this.setPlaying(false);
  }

  async close(options: { drain?: boolean } = {}): Promise<void> {
    if (this.capture) this.capture.port.onmessage = null;
    this.micSource?.disconnect();
    this.capture?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const mic = this.micContext;
    this.micContext = null;
    await mic?.close().catch(() => {});

    const out = this.outContext;
    if (out && options.drain && this.sources.size > 0) {
      const remainingMs = Math.min(MAX_DRAIN_MS, Math.max(0, (this.playhead - out.currentTime) * 1000));
      await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
    }
    this.clear();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.outContext = null;
    await out?.close().catch(() => {});
  }

  onLevel(listener: (level: number, source: Role) => void): void {
    this.levelListeners.push(listener);
  }

  onPlayback(listener: (playing: boolean) => void): void {
    this.playbackListeners.push(listener);
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (!playing) this.emitLevel(0, 'assistant');
    for (const listener of this.playbackListeners) listener(playing);
  }

  private emitLevel(level: number, source: Role): void {
    for (const listener of this.levelListeners) listener(level, source);
  }
}
