/**
 * Audio processing utilities for Gemini Live API and Gemini TTS
 * Handles PCM 16-bit little-endian conversion, base64 encoding/decoding,
 * gapless scheduling at 24kHz, and microphone capture at 16kHz.
 */

// Convert Float32 audio samples from Web Audio API to 16-bit PCM ArrayBuffer
export function float32ToInt16PCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return buffer;
}

// Convert ArrayBuffer / Int16 PCM to base64 string
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert base64 PCM string to Float32Array for AudioBuffer playback
export function base64ToFloat32PCM(base64: string): Float32Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Gapless Audio Queue Player for Gemini 24kHz PCM audio chunks
 */
export class GaplessPcmPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  public isPlaying = false;
  private onEndedCallback?: () => void;

  constructor(sampleRate: number = 24000) {
    // Lazy AudioContext initialization
    if (typeof window !== 'undefined') {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass({ sampleRate });
      }
    }
  }

  public getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  public async resume(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  public queuePcmBase64(base64: string): void {
    if (!this.audioCtx) return;

    try {
      const float32Data = base64ToFloat32PCM(base64);
      if (float32Data.length === 0) return;

      const audioBuffer = this.audioCtx.createBuffer(1, float32Data.length, this.audioCtx.sampleRate);
      audioBuffer.copyToChannel(float32Data, 0);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      const currentTime = this.audioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime + 0.05; // 50ms buffer for smooth start
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.isPlaying = true;
      this.activeSources.push(source);

      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        if (this.activeSources.length === 0) {
          this.isPlaying = false;
          if (this.onEndedCallback) {
            this.onEndedCallback();
          }
        }
      };
    } catch (err) {
      console.error('Error queuing PCM audio chunk:', err);
    }
  }

  public stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source already ended
      }
    }
    this.activeSources = [];
    if (this.audioCtx) {
      this.nextStartTime = this.audioCtx.currentTime;
    }
    this.isPlaying = false;
  }

  public setOnEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }
}
