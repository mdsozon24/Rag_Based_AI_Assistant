/**
 * Local voice dev server: talk to the cascaded engine from your microphone.
 *
 *   npm run voice:dev            then open http://localhost:3200
 *
 * Uses the real providers (ElevenLabs Scribe STT, Gemini LLM, ElevenLabs TTS) from .env.
 * Binds to 127.0.0.1 only: there is no authentication and every call spends API credit.
 */
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CallSession } from '../src/engine/callSession.ts';
import { parseAssistantConfig, type AssistantConfig } from '../src/engine/config.ts';
import { EndReason } from '../src/engine/endReason.ts';
import { LatencyRecorder, VOICE_TO_VOICE_TARGET_MS } from '../src/engine/metrics.ts';
import { createLogger } from '../src/logger.ts';
import { createPlatform } from '../src/platform.ts';
import { PRESET_NAMES, type PresetName } from '../src/providers/presets.ts';
import { WebSocketTransport } from '../src/transport/webSocket.ts';
import { DEV_ASSISTANTS } from './assistants.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.VOICE_DEV_PORT || 3200);
const host = process.env.VOICE_DEV_HOST || '127.0.0.1';
const logger = createLogger({ bindings: { service: 'voice-dev' } });
const platform = createPlatform();
// Dev calls run as one org with no stored keys, so platform keys (from .env) are used
const DEV_ORG = 'dev';
const latency = new LatencyRecorder();
const page = fs.readFileSync(path.join(here, 'voice-dev.html'), 'utf8');
let activeCalls = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  } else if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activeCalls, targetVoiceToVoiceMs: VOICE_TO_VOICE_TARGET_MS, latency: latency.summary() }));
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', `http://${req.headers.host}`);
  const preset = DEV_ASSISTANTS[url.searchParams.get('lang') ?? 'bn'] ?? DEV_ASSISTANTS.bn;
  const greet = url.searchParams.get('greet') !== '0';
  const silenceMs = Number(url.searchParams.get('silenceMs'));
  const presetParam = url.searchParams.get('preset') as PresetName | null;
  let config;
  try {
    config = parseAssistantConfig({
      ...preset,
      ...(presetParam && PRESET_NAMES.includes(presetParam) ? { preset: presetParam } : {}),
      firstMessage: { ...preset.firstMessage, mode: greet ? 'assistant-speaks-first' : 'wait-for-user' },
      ...(Number.isFinite(silenceMs) && silenceMs > 0 ? { endpointing: { ...preset.endpointing, silenceMs } } : {}),
    });
  } catch (err) {
    ws.close(1008, 'invalid config');
    logger.warn({ err }, 'rejected call with invalid config');
    return;
  }
  void startCall(ws, config);
});

async function startCall(ws: WebSocket, config: AssistantConfig): Promise<void> {
  let providers;
  try {
    providers = await platform.providersForCall(config, DEV_ORG, logger);
  } catch (err) {
    // E.g. the preset's primary provider has no API key: tell the page, then close
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'cannot start call');
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', stage: 'internal', message }));
    ws.close(1011, 'provider unavailable');
    return;
  }
  const transport = new WebSocketTransport(ws, logger);
  const session = new CallSession({ config, transport, providers, orgId: DEV_ORG, logger, latencyRecorder: latency });
  activeCalls++;
  session.ended.then((summary) => {
    activeCalls--;
    logger.info({ call_id: summary.callId, end_reason: summary.endReason, all_calls_latency: latency.summary().voiceToVoiceMs }, 'dev call finished');
  });
  session.start().catch((err) => {
    logger.error({ err, call_id: session.callId }, 'call failed to start');
    void session.end(EndReason.ErrorInternal, { error: { stage: 'internal', message: err instanceof Error ? err.message : String(err) } });
  });
}

server.listen(port, host, () => {
  logger.info({ url: `http://localhost:${port}`, presets: PRESET_NAMES }, 'voice dev server ready');
});
