/**
 * Real-provider smoke test (spends a little API credit): a synthetic caller talks to the engine in
 * real time over a loopback transport. Caller speech is synthesized with the same TTS provider.
 *
 *   npm run voice:smoke                    (Bangla, balanced preset)
 *   npm run voice:smoke -- en fast         (English, fast preset)
 *
 * Script: greeting -> question -> barge-in ~1.2 s into the answer -> goodbye (expects endCall).
 * Prints per-turn latency and the call's p50/p95.
 */
import 'dotenv/config';
import { AudioConverter, PCM16_16K, PCM16_24K, encodeFromPcm16 } from '../src/audio/format.ts';
import { CallSession } from '../src/engine/callSession.ts';
import { parseAssistantConfig } from '../src/engine/config.ts';
import { EndReason } from '../src/engine/endReason.ts';
import { LATENCY_METRICS } from '../src/engine/metrics.ts';
import { createLogger, type LogLevel } from '../src/logger.ts';
import { createPlatform } from '../src/platform.ts';
import { PRESET_NAMES, type PresetName } from '../src/providers/presets.ts';
import type { VoiceSynthesizer } from '../src/providers/types.ts';
import { noise } from '../src/testing/simulatedCaller.ts';
import { LoopbackTransport } from '../src/transport/loopback.ts';
import { DEV_ASSISTANTS } from './assistants.ts';

const lang = process.argv[2] === 'en' ? 'en' : 'bn';
const preset: PresetName = PRESET_NAMES.includes(process.argv[3] as PresetName) ? (process.argv[3] as PresetName) : 'balanced';
const LINES = {
  bn: ['ঢাকা শহর সম্পর্কে কিছু বলুন।', 'একটু থামুন, শুধু এক বাক্যে বলুন।', 'ধন্যবাদ, আর কিছু লাগবে না। বিদায়।'],
  en: ['Can you tell me something about the city of Dhaka?', 'Sorry, just give me the short version.', "Thanks, that's all I needed. Goodbye."],
}[lang];

const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) || 'warn' });
const platform = createPlatform();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function synthesize(text: string, voice: VoiceSynthesizer): Promise<Int16Array> {
  const converter = new AudioConverter(voice.outputFormat, PCM16_16K);
  const parts: Int16Array[] = [];
  for await (const chunk of voice.stream({ text, language: lang }, { callId: 'smoke-caller', logger, signal: new AbortController().signal })) {
    parts.push(converter.toPcm16(chunk));
  }
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

async function main() {
  const config = parseAssistantConfig({ ...DEV_ASSISTANTS[lang], preset, idle: { timeoutMs: 15000 } });
  const providers = await platform.providersForCall(config, 'smoke', logger);
  console.log(`Preset ${preset}: ${providers.transcriber[0].provider}/${providers.transcriber[0].model}, ${providers.model[0].provider}/${providers.model[0].model}, ${providers.voice[0].provider}/${providers.voice[0].model}`);
  console.log(`Synthesizing ${LINES.length} caller lines (${lang})...`);
  const utterances = await Promise.all(LINES.map((line) => synthesize(line, providers.voice[0].instance)));
  const transport = new LoopbackTransport(PCM16_16K, PCM16_24K, 120);
  const session = new CallSession({ config, transport, providers, orgId: 'smoke', logger, callId: `smoke-${Date.now()}` });

  // Caller "microphone": 20 ms frames in real time, speech when queued, else quiet room noise
  const queue: Int16Array[] = [];
  let seed = 1;
  const say = (audio: Int16Array) => {
    for (let i = 0; i < audio.length; i += 320) queue.push(audio.subarray(i, i + 320));
  };
  // Paced by wall clock: timers are coarse (≈15.6 ms on Windows), so send every frame that is due
  const micStart = Date.now();
  let framesSent = 0;
  const mic = setInterval(() => {
    const due = Math.floor((Date.now() - micStart) / 20);
    for (; framesSent < due; framesSent++) {
      const frame = queue.shift() ?? noise(16000, 20, 40, seed++);
      transport.pushAudio(encodeFromPcm16(PCM16_16K, frame));
    }
  }, 10);
  const log = (msg: string) => console.log(`${((Date.now() - session.startedAt) / 1000).toFixed(2).padStart(6)}s  ${msg}`);
  session.onEvent((e) => {
    if (e.type === 'state') log(`state -> ${e.state}`);
    if (e.type === 'transcript' && e.final) log(`${e.role === 'user' ? 'caller' : 'agent '}: ${e.text}${e.role === 'assistant' && e.interrupted ? '  [interrupted]' : ''}`);
    if (e.type === 'error') log(`ERROR ${e.stage}: ${e.message}`);
  });
  const waitFor = async (check: () => boolean, ms: number, what: string) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end || session.state === 'ended') throw new Error(`timed out waiting for ${what} (state ${session.state})`);
      await sleep(20);
    }
  };

  await session.start();
  try {
    await waitFor(() => session.state === 'listening', 20000, 'greeting to finish');
    await sleep(400);
    say(utterances[0]);
    await waitFor(() => session.state === 'speaking' && session.turns.length >= 1, 20000, 'answer to start');
    await sleep(1200);
    say(utterances[1]); // barge-in
    await waitFor(() => session.turns.some((t) => t.interrupted), 5000, 'barge-in');
    await waitFor(() => session.turns.length >= 3 && session.state === 'listening', 30000, 'short answer to finish');
    await sleep(400);
    say(utterances[2]);
    await waitFor(() => session.turns.length >= 4, 30000, 'goodbye reply');
    await Promise.race([session.ended, sleep(8000)]);
  } catch (err) {
    log(`script stopped: ${(err as Error).message}`);
  }
  if (session.state !== 'ended') {
    log('assistant did not end the call; hanging up');
    transport.hangup();
  }
  const summary = await session.ended;
  clearInterval(mic);

  console.log(`\nEnd reason: ${summary.endReason}${summary.endReason === EndReason.AssistantEnded ? ' (model called endCall)' : ''}`);
  console.log('\nPer reply turn (ms):');
  console.table(
    summary.turns
      .filter((t) => t.kind === 'reply')
      .map((t) => ({ turn: t.index, interrupted: t.interrupted, ...Object.fromEntries(LATENCY_METRICS.map((m) => [m, t.latency[m] === undefined ? '' : Math.round(t.latency[m]!)])) }))
  );
  console.log('Call p50 / p95 (ms):');
  console.table(Object.fromEntries(LATENCY_METRICS.map((m) => [m, { count: summary.latency[m].count, p50: summary.latency[m].p50, p95: summary.latency[m].p95 }])));
  console.log('Usage (billing):');
  console.table(summary.usage.map((u) => ({ component: u.component, provider: u.provider, model: u.model, billing: u.billing, fallback: u.fallback, estimated: u.estimated, ...u.units })));
  console.log('History sent to the LLM:');
  for (const h of summary.history) console.log(`  ${h.role.padEnd(9)} ${h.interrupted ? '[heard only] ' : ''}${h.content}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
