/**
 * The real API for dashboard end-to-end tests and local trials, without any provider key: in-memory
 * Postgres with the real migrations, real auth, real media socket, the analysis and webhook workers,
 * and fake STT/LLM/TTS. The fake model echoes callers ("You said: ...") and answers post-call
 * analysis prompts in the JSON shape they ask for.
 *
 *   npx tsx apps/dashboard/e2e/api-server.ts            (API on :4321, dashboard expected on :4320)
 *
 * Test-only route (this harness only, never the real API): GET /test/emails?to=<address> returns the
 * emails sent to that address (sign-up verification, invitations), newest last.
 */
import type { LlmRequest } from '../../../packages/engine/src/providers/types.ts';
import { defaultFakeReply, fakeEngine } from '../../../packages/engine/src/testing/fakeEngine.ts';
import { OutboxMailer } from '../../api/src/services/mailer.ts';
import { createTestApp } from '../../api/test/helpers.ts';

const API_PORT = Number(process.env.E2E_API_PORT ?? 4321);
const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT ?? 4320);
const DASHBOARD = `http://127.0.0.1:${DASHBOARD_PORT}`;
const DASHBOARD_LOCALHOST = `http://localhost:${DASHBOARD_PORT}`;

type Schema = { type?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; minimum?: number; items?: Schema };

/** A small value that satisfies a JSON Schema (the fake model's structured outputs). */
function sample(schema: Schema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'boolean':
      return true;
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'array':
      return [];
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value)]));
    default:
      return 'example';
  }
}

function analysisReply(request: LlmRequest): string {
  const task = String(request.messages.find((m) => m.role === 'user')?.content ?? '').split('</transcript>').at(-1) ?? '';
  if (task.includes('{"passed"')) return '{"passed": true, "reason": "The caller got what they asked for."}';
  if (task.includes('{"score"')) return '{"score": 8, "reason": "Helpful and brief."}';
  if (task.includes('{"verdict"')) return '{"verdict": "A short, successful conversation."}';
  const categories = /exactly one of (\[.*?\])/.exec(task)?.[1];
  if (categories) return JSON.stringify({ category: (JSON.parse(categories) as string[])[0], reason: 'Closest match.' });
  if (task.includes('Extract the structured output')) {
    // The schema is the line after the instruction (see extractionTask in apps/api)
    const lines = task.split('\n');
    const at = lines.findIndex((line) => line.startsWith('Reply with only one JSON object that satisfies'));
    try {
      return JSON.stringify(sample(JSON.parse(lines[at + 1]) as Schema));
    } catch {
      return '{}';
    }
  }
  return 'The caller asked a question and the assistant answered it. The call ended normally.';
}

const engine = fakeEngine({
  reply: (text, request) => (request.systemPrompt.startsWith('You analyse finished phone calls') ? analysisReply(request) : defaultFakeReply(text)),
});

const t = await createTestApp({
  providersForCall: engine.providersForCall,
  modelForCall: engine.modelForCall,
  logger: process.env.E2E_API_LOG === 'true',
  env: {
    API_PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
    DASHBOARD_URL: DASHBOARD,
    DASHBOARD_ORIGINS: `${DASHBOARD},${DASHBOARD_LOCALHOST}`,
    // The dashboard (Next.js, on this machine) forwards /v1 and reports the browser's address
    TRUST_PROXY: 'loopback',
    ANALYSIS_RETRY_BASE_SECONDS: '1',
  },
  extraRoutes: (app, ctx) => {
    app.get('/test/emails', { config: { auth: 'none' } }, async (request) => {
      const to = String((request.query as { to?: string }).to ?? '').toLowerCase();
      const sent = ctx.mailer instanceof OutboxMailer ? ctx.mailer.sent : [];
      return { emails: sent.filter((e) => e.to === to) };
    });
  },
});

// Workers run on their own clocks in the test harness; keep those clocks on real time
for (const clock of [t.analysisClock, t.webhookClock, t.monitoringClock, t.dialerClock]) {
  setInterval(() => (clock.now = Date.now()), 500).unref();
}
t.ctx.analysis.start();
t.ctx.webhookDelivery.start();

await t.app.listen({ host: '127.0.0.1', port: API_PORT });
console.log(`e2e API on http://127.0.0.1:${API_PORT} (dashboard origin ${DASHBOARD})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void t.close().finally(() => process.exit(0)));
}
