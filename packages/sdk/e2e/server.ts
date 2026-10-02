/**
 * Fake engine for the Playwright tests: the real API (in-memory Postgres, real migrations, real
 * auth and media socket) with fake STT/LLM/TTS, plus a page server for the real example pages.
 *
 *   API    http://127.0.0.1:4311  (serves /sdk/widget.js from packages/sdk/dist: npm run sdk:build)
 *   Pages  http://127.0.0.1:4310  (allowed origin)  /widget, /custom
 *          http://localhost:4310  (same pages, an origin the public key does NOT allow)
 *
 * Test hook: POST http://127.0.0.1:4311/test/drop-sockets cuts every live media socket (1006), to
 * exercise reconnect.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEngine } from '../../engine/src/testing/fakeEngine.ts';
import { createKey, createTestApp, json, signUp } from '../../../apps/api/test/helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '../../../examples/html');
export const PAGE_PORT = Number(process.env.E2E_PAGE_PORT ?? 4310);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4311);
const ALLOWED_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

if (!fs.existsSync(path.resolve(here, '../dist/widget.js'))) {
  console.error('packages/sdk/dist/widget.js is missing: run npm run sdk:build first');
  process.exit(1);
}

const engine = fakeEngine();
const t = await createTestApp({
  providersForCall: engine.providersForCall,
  modelForCall: engine.modelForCall,
  env: { VOICE_RESUME_GRACE_MS: '15000', API_PUBLIC_URL: API_URL },
  extraRoutes: (app) => {
    app.post('/test/drop-sockets', { config: { auth: 'none' } }, async () => {
      const clients = [...(app.websocketServer?.clients ?? [])];
      for (const socket of clients) socket.terminate();
      return { dropped: clients.length };
    });
  },
});
const owner = await signUp(t, { orgName: 'E2E Clinic' });
const created = json(
  await owner.caller.request('POST', '/v1/assistants', {
    name: 'Clinic receptionist',
    config: { firstMessage: 'Hello! How can I help?', firstMessageMode: 'assistant-speaks-first', systemPrompt: 'You are a clinic receptionist.' },
  })
);
await owner.caller.request('POST', `/v1/assistants/${created.id}/publish`, {});
const { key } = await createKey(owner.caller, { name: 'website', type: 'public', allowedOrigins: [ALLOWED_ORIGIN], allowedAssistantIds: [created.id] });
await t.app.listen({ host: '127.0.0.1', port: API_PORT });

function page(file: string): string {
  return fs
    .readFileSync(path.join(examples, file), 'utf8')
    .replaceAll('https://api.your-domain.com', API_URL)
    .replaceAll('pk_your_public_key', key)
    .replaceAll('your_assistant_id', created.id);
}

const pages = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const file = { '/widget': 'index.html', '/custom': 'custom-button.html' }[url.pathname];
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else if (file) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(file));
  } else {
    res.writeHead(404).end();
  }
});
// A private key for trying the server-side APIs (chat, OpenAI-compatible) by hand; fake org only
const serverKey = await createKey(owner.caller, { name: 'local server', type: 'private' });
pages.listen(PAGE_PORT, '127.0.0.1', () => console.log(`e2e pages on ${ALLOWED_ORIGIN}, API on ${API_URL}
assistant ${created.id}
public key ${key}
private key ${serverKey.key}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    pages.close();
    await t.close();
    process.exit(0);
  });
}
