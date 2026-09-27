import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';
import { ElevenLabsLiveRelay } from './server/elevenlabs.ts';
const NOISE = Number(process.env.NOISE || 300); // room noise amplitude (int16) sent when the AI is not speaking
const key = process.env.ELEVENLABS_API_KEY!;
// Spoken question at 16kHz, as the browser mic would capture it
const q = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/nUarI71Lei0IFt1ybDm1?output_format=pcm_16000`, { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'ঢাকা শহর সম্পর্কে বিস্তারিত বলুন।', model_id: 'eleven_v3_conversational', language_code: 'bn' }) });
const question = Buffer.from(await q.arrayBuffer());
const t0 = performance.now(); const now = () => (performance.now() - t0) / 1000;
let playhead = 0, gaps: string[] = [], events: string[] = [], turns = 0, firstAudio = 0, speechStart = 0;
const isPlaying = () => now() < playhead;
const relay = new ElevenLabsLiveRelay((b64) => {
  const t = now(), dur = Buffer.from(b64, 'base64').length / 48000;
  if (!firstAudio) firstAudio = t;
  if (playhead < t) { if (playhead > 0 && t - playhead > 0.25) gaps.push(`${(t - playhead).toFixed(1)}s silence at ${playhead.toFixed(1)}s`); playhead = t + 0.12; }
  playhead += dur;
});
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const session = await ai.live.connect({
  model: 'gemini-3.1-flash-live-preview',
  config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
    systemInstruction: 'You are a Bangladeshi Bangla voice AI agent. Give complete, well-explained answers in Bengali, several sentences long. Never use lists.',
    inputAudioTranscription: {}, outputAudioTranscription: {} },
  callbacks: {
    onmessage: (m: any) => {
      const sc = m.serverContent; if (!sc) return;
      if (sc.inputTranscription?.text) events.push(`${now().toFixed(1)}s heard "${sc.inputTranscription.text.trim()}"`);
      if (sc.outputTranscription?.text) relay.pushText(sc.outputTranscription.text);
      if (sc.generationComplete || sc.turnComplete) relay.flush();
      if (sc.generationComplete) { turns++; events.push(`${now().toFixed(1)}s answer #${turns} generated`); }
      if (sc.interrupted) { events.push(`${now().toFixed(1)}s INTERRUPTED (AI playing: ${isPlaying()})`); relay.interrupt(); playhead = 0; }
    },
    onerror: (e: any) => events.push('error ' + e?.message), onclose: () => {},
  },
});
// Stream 256ms mic frames in real time for 60s, exactly like the browser client
const FRAME = 4096 * 2; let offset = 0;
const end = Date.now() + 60000;
while (Date.now() < end) {
  let frame: Buffer;
  if (offset < question.length) { frame = question.subarray(offset, offset + FRAME); offset += FRAME; if (!speechStart) speechStart = now(); }
  else if (isPlaying()) frame = Buffer.alloc(FRAME); // client sends silence while the AI speaks
  else { frame = Buffer.alloc(FRAME); for (let i = 0; i < FRAME; i += 2) frame.writeInt16LE(Math.round((Math.random() * 2 - 1) * NOISE), i); }
  session.sendRealtimeInput({ audio: { data: frame.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  await new Promise((r) => setTimeout(r, 256));
}
console.log(`noise ${NOISE}: question ends ${(question.length / 32000).toFixed(1)}s, first AI audio ${firstAudio.toFixed(1)}s, AI speech ends ${playhead.toFixed(1)}s`);
console.log('  answers generated:', turns, '| pauses >250ms:', gaps.length ? gaps.join('; ') : 'none');
for (const e of events) if (!e.includes('heard') || e.length < 120) console.log('  ' + e);
session.close(); process.exit(0);
